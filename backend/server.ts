import dotenv from 'dotenv';
dotenv.config();

import express, { Request, Response, Application } from 'express';
import bcrypt from 'bcrypt';
import jwt, { Secret, SignOptions, JwtPayload } from 'jsonwebtoken';
import { Pool, PoolClient, DatabaseError } from 'pg';
import mqtt from 'mqtt';
import crypto from 'crypto';

const app: Application = express();
app.set('trust proxy', 'loopback'); // Trust the loopback interface for proxy headers
app.use(express.json());

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  mqtt_username: string | null;
  mqtt_password_hash: string | null;
  created_at: Date;
}

export interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  hardware_id: string | null;
  mqtt_username: string | null;
  mqtt_password_hash: string | null;
  created_at: Date;
}

export interface SetupJwtPayload extends JwtPayload {
  userId: string;
  backendUrl: string;
  deviceId: string;
}

interface SignupRequestBody {
  username?: string;
  email?: string;
  password?: string;
}

interface LoginRequestBody {
  email?: string;
  password?: string;
}

interface RequestSetupRequestBody {
  userId?: string;
  deviceName?: string;
}

interface VerifySetupRequestBody {
  hardware_id?: string;
}

// Regex Patterns
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const JWT_SECRET: Secret = process.env.JWT_SECRET || 'default_jwt_secret_change_in_production';
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://localhost:1883';
const MQTT_ADMIN_USER = process.env.MQTT_ADMIN_USER || 'admin';
const MQTT_ADMIN_PASS = process.env.MQTT_ADMIN_PASS || 'backend_secret_password';

// Public MQTTS endpoint returned to mobile app
const MQTT_PUBLIC_URL = process.env.MQTT_PUBLIC_URL;

const pool = new Pool({
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD, // Handles '@' automatically without encoding
  host: process.env.DB_HOST,
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 5432,
  database: process.env.DB_NAME,
});

// In server.js right after setting up your pg Pool:
async function initDb(): Promise<void> {
  try {
    await pool.query(`
      CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

      CREATE TABLE IF NOT EXISTS users (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          username VARCHAR(50) UNIQUE NOT NULL,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255) NOT NULL,
          mqtt_username VARCHAR(100) UNIQUE,
          mqtt_password_hash VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS devices (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          device_name VARCHAR(100) NOT NULL,
          hardware_id VARCHAR(255) UNIQUE NOT NULL,
          mqtt_username VARCHAR(100) UNIQUE,
          mqtt_password_hash VARCHAR(255),
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CONSTRAINT unique_device_name_per_user UNIQUE (user_id, device_name)

      );
    `);
    console.log('Database tables verified / created successfully.');
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
}

initDb();


// ----------------------------------------------------------------------------
// MQTT ADMIN CLIENT & PROVISIONING SERVICE (DynSec Plugin)
// ----------------------------------------------------------------------------
const mqttAdminClient = mqtt.connect(MQTT_BROKER_URL, {
  username: MQTT_ADMIN_USER,
  password: MQTT_ADMIN_PASS,
  reconnectPeriod: 5000,
});

mqttAdminClient.on('connect', () => {
  console.log('Connected to Mosquitto MQTT Broker as Admin.');
});

mqttAdminClient.on('error', (err: Error) => {
  console.error('Mosquitto Admin Connection Error:', err.message);
});

function getDeviceMqttTopics(userId: string, deviceId: string) {
  return {
    telemetry: `users/${userId}/devices/${deviceId}/telemetry`,
    status: `users/${userId}/devices/${deviceId}/status`,
    commands: `users/${userId}/devices/${deviceId}/commands`,
  };
}

/**
 * Provisions dynamic RBAC role and client credentials inside Mosquitto via $CONTROL/dynamic-security/v1
 */
async function provisionMqttUserInMosquitto(userId: string, rawMqttPassword: string): Promise<string> {
  const mqttUsername = `user_${userId}`;
  const roleName = `role_user_${userId}`;

  // 1. Command to define strict role-based topic permissions for the user app
  const createRoleCmd = {
    commands: [
      {
        command: 'createRole',
        rolename: roleName,
        acls: [
          {
            acltype: 'subscribePattern',
            topic: `users/${userId}/devices/+/telemetry`,
            priority: 1,
            allow: true
          },
          {
            acltype: 'subscribePattern',
            topic: `users/${userId}/devices/+/status`,
            priority: 1,
            allow: true
          },
          {
            acltype: 'publishClientSend',
            topic: `users/${userId}/devices/+/commands`,
            priority: 1,
            allow: true
          }
        ]
      }
    ]
  };

  // 2. Command to create the Mosquitto user account and attach the created role
  const createClientCmd = {
    commands: [
      {
        command: 'createClient',
        username: mqttUsername,
        password: rawMqttPassword,
        roles: [
          {
            rolename: roleName,
            priority: 1
          }
        ]
      }
    ]
  };

  // Publish configuration commands to Mosquitto's dynamic security control topic
  mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(createRoleCmd));
  mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(createClientCmd));

  return mqttUsername;
}

/**
 * Provisions a dedicated MQTT user and ACL permissions for an individual edge device
 */
async function provisionEdgeDeviceInMosquitto(deviceId: string, userId: string, rawMqttPassword: string): Promise<string> {
  const mqttUsername = `device_${deviceId}`;
  const roleName = `role_device_${deviceId}`;

  const createRoleCmd = {
    commands: [
      {
        command: 'createRole',
        rolename: roleName,
        acls: [
          {
            acltype: 'publishClientSend',
            topic: `users/${userId}/devices/${deviceId}/telemetry`,
            priority: 1,
            allow: true
          },
          {
            acltype: 'publishClientSend',
            topic: `users/${userId}/devices/${deviceId}/status`,
            priority: 1,
            allow: true
          },
          {
            acltype: 'subscribePattern',
            topic: `users/${userId}/devices/${deviceId}/commands`,
            priority: 1,
            allow: true
          }
        ]
      }
    ]
  };

  const createClientCmd = {
    commands: [
      {
        command: 'createClient',
        username: mqttUsername,
        password: rawMqttPassword,
        roles: [
          {
            rolename: roleName,
            priority: 1
          }
        ]
      }
    ]
  };

  mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(createRoleCmd));
  mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(createClientCmd));

  return mqttUsername;
}

/**
 * Helper to construct the standard MQTT payload returned to the mobile client
 */
function buildMqttResponseObject(userId: string, mqttUsername: string, rawMqttPassword: string) {
  return {
    brokerUrl: MQTT_PUBLIC_URL,
    username: mqttUsername,
    password: rawMqttPassword,
    topics: {
      telemetrySubscribe: `users/${userId}/devices/+/telemetry`,
      statusSubscribe: `users/${userId}/devices/+/status`,
      commandPublish: `users/${userId}/devices/{deviceId}/commands`,
    }
  };
}

app.get(
  '/health', 
  async (_req: Request, res: Response): Promise<Response> => {
  try {
    const result = await pool.query<{ now: Date }>('SELECT NOW()');
    return res.json({
      status: 'success',
      message: 'Connected to PostgreSQL on Debian!',
      timestamp: result.rows[0].now,
    });
  } catch (err) {
    console.error('DB Connection Error:', err);
    return res.status(500).json({ error: 'Database connection failed' });
  }
});


// User Signup Endpoint
app.post(
  '/api/auth/signup', 
  async (req: Request<{}, {}, SignupRequestBody>, res: Response): Promise<Response> => {
    const { username, email, password } = req.body;

    if (!username || !email || !password) {
      return res.status(400).json({ error: 'username, email and password are required' });
    }

    // 2. Validate Email Format
    if (!EMAIL_REGEX.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    // 3. Validate Password Strength
    if (!STRONG_PASSWORD_REGEX.test(password)) {
      return res.status(400).json({
        error: 'Password must be at least 8 characters long and contain an uppercase letter, lowercase letter, number, and special character.'
      });
    }

    const client: PoolClient = await pool.connect();

    try {
      await client.query('BEGIN');

      // 2. Hash Password & Insert User
      const passwordHash = await bcrypt.hash(password, 10);

      // Insert new user into database
      const userResult = await client.query<{ id: string; username: string; email: string }>(
        'INSERT INTO users (username, email, password_hash) VALUES ($1, $2, $3) RETURNING id, username, email',
        [username.trim(), email.toLowerCase().trim(), passwordHash]
      );

      const newUser = userResult.rows[0];

      const rawMqttPassword = crypto.randomBytes(18).toString('hex');
      const mqttPasswordHash = await bcrypt.hash(rawMqttPassword, 10);

      const mqttUsername = await provisionMqttUserInMosquitto(newUser.id, rawMqttPassword);

      // Save generated MQTT credentials to PostgreSQL user record
      await client.query(
        'UPDATE users SET mqtt_username = $1, mqtt_password_hash = $2 WHERE id = $3',
        [mqttUsername, mqttPasswordHash, newUser.id]
      );

      await client.query('COMMIT');

      // Issue JWT authentication token for API access
      const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '7d' });

      return res.status(201).json({
        message: 'Signup successful',
        user: newUser,
        token,
        mqtt: buildMqttResponseObject(newUser.id, mqttUsername, rawMqttPassword)
      });
    } catch (err: unknown) {
      await client.query('ROLLBACK');

      // Catch unique violations (e.g., duplicate username or email)
      if (err instanceof DatabaseError && err.code === '23505') {
        return res.status(400).json({ error: 'Username or email is already registered.' });
      }

      console.error('Signup Error:', err);
      return res.status(500).json({ error: 'Internal server error during signup.' });
    } finally {
      client.release();
    }
  }
);

// ----------------------------------------------------------------------------
// USER AUTHENTICATION: LOGIN
// ----------------------------------------------------------------------------
app.post(
  '/api/auth/login',
  async (req: Request<{}, {}, LoginRequestBody>, res: Response): Promise<Response> => {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
      // Fetch user record including MQTT fields
      const result = await pool.query<UserRow>(
        'SELECT id, username, email, password_hash, mqtt_username, mqtt_password_hash FROM users WHERE email = $1',
        [email.toLowerCase().trim()]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      const user = result.rows[0];

      // Validate password
      const passwordMatch = await bcrypt.compare(password, user.password_hash);
      if (!passwordMatch) {
        return res.status(401).json({ error: 'Invalid email or password.' });
      }

      let rawMqttPassword: string;
      let mqttUsername = user.mqtt_username;

      // Lazy-provision MQTT credentials if user was registered prior to MQTT setup
      if (!mqttUsername || !user.mqtt_password_hash) {
        rawMqttPassword = crypto.randomBytes(18).toString('hex');
        const mqttPasswordHash = await bcrypt.hash(rawMqttPassword, 10);

        mqttUsername = await provisionMqttUserInMosquitto(user.id, rawMqttPassword);

        await pool.query(
          'UPDATE users SET mqtt_username = $1, mqtt_password_hash = $2 WHERE id = $3',
          [mqttUsername, mqttPasswordHash, user.id]
        );
      } else {
        // Generate temporary session password or re-synchronize credential for active login session
        rawMqttPassword = crypto.randomBytes(18).toString('hex');
        const mqttPasswordHash = await bcrypt.hash(rawMqttPassword, 10);

        // Update password in Mosquitto via DynSec Admin Client
        const updatePassCmd = {
          commands: [
            {
              command: 'setClientPassword',
              username: mqttUsername,
              password: rawMqttPassword
            }
          ]
        };
        mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(updatePassCmd));

        // Sync new password hash into PostgreSQL
        await pool.query(
          'UPDATE users SET mqtt_password_hash = $1 WHERE id = $2',
          [mqttPasswordHash, user.id]
        );
      }

      // Generate API JWT
      const token = jwt.sign({ userId: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

      return res.status(200).json({
        message: 'Login successful',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
        token,
        mqtt: buildMqttResponseObject(user.id, mqttUsername, rawMqttPassword)
      });
    } catch (err) {
      console.error('Login Error:', err);
      return res.status(500).json({ error: 'Internal server error during login.' });
    }
  }
);

// Step 1: Request JWT Setup Token
app.post(
  '/api/devices/request-setup', 
  async (req: Request<{}, {}, RequestSetupRequestBody>, res: Response): Promise<Response> => {
    const { userId, deviceName } = req.body;

    if (!userId || !deviceName) {
      return res.status(400).json({ error: 'User ID and Device Name are required.' });
    }

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = req.get('host');
    const backendUrl = `${protocol}://${host}/api/devices/verify-setup`;

    try {

      // 3. Create a stateless signed JWT token expiring in 15 minutes
      const signOptions: SignOptions = { expiresIn: '15m' };
      const setupToken = jwt.sign(
        { 
          userId,
          deviceName: deviceName.trim(),
          backendUrl,
        },
        JWT_SECRET,
        signOptions
      );

      return res.status(201).json({ 
        setupToken // Returned to mobile app to transmit over BLE
      });
    } catch (err) {
      console.error('Error initiating device setup:', err);
      return res.status(500).json({ error: 'Failed to initiate device setup.' });
    }
  }
);

// Step 2: Edge Device verifies JWT after connecting to Wi-Fi
app.post(
  '/api/devices/verify-setup', 
  async (req: Request<{}, {}, VerifySetupRequestBody>, res: Response): Promise<Response> => {

  // 1. Extract the Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Unauthorized: Missing or malformed Bearer token.' 
    });
  }

  // 2. Separate "Bearer" from the actual JWT string
  const token = authHeader.split(' ')[1];

  // 3. Extract hardware_id from the JSON request body
  const { hardware_id } = req.body;

  if (!hardware_id) {
    return res.status(400).json({ 
      error: 'Bad Request: Missing hardware_id in request body.' 
    });
  }

  const client: PoolClient = await pool.connect();

  try {

    await client.query('BEGIN');

    // Statelessly verify signature & expiration
    const decoded = jwt.verify(token, JWT_SECRET) as SetupJwtPayload;

    // 1. Create temporary device entry to obtain UUID
    const uuidResult = await pool.query<{ id: string }>('SELECT uuid_generate_v4() AS id');
    const deviceId = uuidResult.rows[0].id;

    // 2. Insert device into database
    const newDevice = await pool.query<Pick<DeviceRow, 'id' | 'user_id' | 'device_name'>>(
      `INSERT INTO devices (id, user_id, device_name, hardware_id) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, user_id, device_name`,
      [deviceId, decoded.userId, decoded.deviceName, hardware_id.trim()]
    );

    const device = newDevice.rows[0];

    const rawMqttPassword: string = crypto.randomBytes(18).toString('hex');
    const mqttPasswordHash: string = await bcrypt.hash(rawMqttPassword, 10);
    const mqttUsername = await provisionEdgeDeviceInMosquitto(device.id, device.user_id, rawMqttPassword);

    // 5. Save the hardware_id and update MQTT credentials in PostgreSQL
    await client.query(
      `UPDATE devices 
       SET mqtt_username = $1, mqtt_password_hash = $2 
       WHERE id = $3`,
      [mqttUsername, mqttPasswordHash || null, device.id]
    );

    await client.query('COMMIT');

    // 6. Dynamically generate the topic structures
    const topics = getDeviceMqttTopics(device.user_id, device.id);

    // 7. Return configuration packet to the edge device
    return res.json({
      message: 'Device successfully verified and provisioned!',
      device: {
        id: device.id,
        deviceName: device.device_name,
      },
      mqtt: {
        brokerUrl: MQTT_PUBLIC_URL,
        username: mqttUsername,
        password: rawMqttPassword || undefined, // Only returned on initial provisioning
        topics: {
          telemetry: topics.telemetry,
          status: topics.status,
          commands: topics.commands,
        }
      }
    });

  } catch (err: unknown) {
    await client.query('ROLLBACK');

    if (err instanceof jwt.TokenExpiredError) {
      return res.status(401).json({ error: 'Setup token has expired. Please restart pairing.' });
    }

    if (err instanceof DatabaseError && err.code === '23505') {

      const constraint = err.constraint;
      if (constraint === 'unique_device_name_per_user') {
        return res.status(400).json({ error: 'You already have a device with this name. Please choose a unique name.' });
      }

      return res.status(400).json({ error: 'This hardware ID is already registered to another device.' });
    }

    console.error('Error verifying setup token:', err);
    return res.status(400).json({ error: 'Invalid setup token or verification failed.' });
  } finally {
    client.release();
  }
});

// Get all devices owned by a user
app.get(
  '/api/devices/:userId', 
  async (req: Request<{ userId: string }>, res: Response): Promise<Response> => {
    const { userId } = req.params;

    try {
      const result = await pool.query<DeviceRow>(
        `SELECT id, device_name, created_at 
         FROM devices 
         WHERE user_id = $1 
         ORDER BY created_at DESC`,
        [userId]
      );

      return res.json({ devices: result.rows });
    } catch (err) {
      console.error('Error fetching devices:', err);
      return res.status(500).json({ error: 'Failed to fetch user devices.' });
    }
  }
);

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running at http://0.0.0.0:${PORT}`);
});