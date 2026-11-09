import { Router, Request, Response } from "express";
import jwt, { SignOptions } from 'jsonwebtoken';
import { pool } from "../config/database";
import { PoolClient, DatabaseError } from "pg";
import mqttAdminClient, { deriveDeterministicMqttPassword } from "../services/mqtt.service";
// import jsrsasign from 'jsrsasign';
import bcrypt from 'bcrypt';
import crypto from 'crypto';
import axios from 'axios';
import { createUserAccountDeleteHandler } from "../controllers/auth.controller";
import { verifyJwtMiddleware } from "../middleware/auth.middleware";
import { generateAccessToken, generateRefreshToken } from '../controllers/auth.controller';
import { provisionMqttUserInMosquitto, provisionEdgeDeviceInMosquitto, buildMqttResponseObject } from "../services/mqtt.service";
import { createHeadscaleUser, generateHeadscalePreauthKey} from "../services/headscale.service";
import { SignupRequestBody, LoginRequestBody, UserPayload, UserRow } from "../types/user.types";
import { DeviceRow, SetupJwtPayload, VerifySetupRequestBody } from "../types/device.types";
// import { CFSSLSignedResponse } from '../types/mqtt.types'
import { ENV } from "../config/env";

// Regex Patterns
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STRONG_PASSWORD_REGEX = /^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/;

const router = Router();

router.delete(
  '/users/:userId', 
  verifyJwtMiddleware(),
  createUserAccountDeleteHandler(pool, mqttAdminClient)
);

// User Signup Endpoint
router.post(
  '/signup', 
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

      // const rawMqttPassword = crypto.randomBytes(18).toString('hex');
	  const rawMqttPassword = deriveDeterministicMqttPassword(newUser.id);
      const mqttPasswordHash = await bcrypt.hash(rawMqttPassword, 10);

      const mqttUsername = await provisionMqttUserInMosquitto(newUser.id, rawMqttPassword);

      // Save generated MQTT credentials to PostgreSQL user record
      await client.query(
        'UPDATE users SET mqtt_username = $1, mqtt_password_hash = $2 WHERE id = $3',
        [mqttUsername, mqttPasswordHash, newUser.id]
      );

	  const createdHeadscaleUser: boolean = await createHeadscaleUser(newUser.id);
	  if (!createdHeadscaleUser) {
      	return res.status(502).json({
        	error: 'Failed to add new user to Headscale private network.'
      	});
	  }

      await client.query('COMMIT');

      // Issue JWT authentication token for API access
      // const token = jwt.sign({ userId: newUser.id, email: newUser.email }, JWT_SECRET, { expiresIn: '7d' });
      const user = { id: newUser.id, username: newUser.username} as UserPayload;
      const accessToken = generateAccessToken(user);
      const refreshToken = generateRefreshToken(user);

      return res.status(201).json({
        message: 'Signup successful',
        user: newUser,
        access_token: accessToken,
        refresh_token: refreshToken,
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
router.post(
  '/login',
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

      let mqttUsername = user.mqtt_username;

	  const rawMqttPassword = deriveDeterministicMqttPassword(user.id);

	  // ONLY provision if the user predates MQTT setup
	  // Do NOT rotate passwords on regular logins to keep multi-device session stable
      if (!mqttUsername || !user.mqtt_password_hash) {
        // rawMqttPassword = crypto.randomBytes(18).toString('hex');
        const mqttPasswordHash = await bcrypt.hash(rawMqttPassword, 10);
        mqttUsername = await provisionMqttUserInMosquitto(user.id, rawMqttPassword);

        await pool.query(
          'UPDATE users SET mqtt_username = $1, mqtt_password_hash = $2 WHERE id = $3',
          [mqttUsername, mqttPasswordHash, user.id]
        );
      } 

      const returningUser = { id: user.id, username: user.username} as UserPayload;
      const accessToken = generateAccessToken(returningUser);
      const refreshToken = generateRefreshToken(returningUser);

      return res.status(200).json({
        message: 'Login successful',
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
        },
        access_token: accessToken,
        refresh_token: refreshToken,
        mqtt: buildMqttResponseObject(user.id, mqttUsername, rawMqttPassword)
      });
    } catch (err) {
      console.error('Login Error:', err);
      return res.status(500).json({ error: 'Internal server error during login.' });
    }
  }
);

// Request JWT Setup Token
router.post(
  '/devices/request-setup', 
  verifyJwtMiddleware(),
  async (req: Request<{}, {}, { deviceName: string }>, res: Response): Promise<Response> => {
    // const { userId, deviceName } = req.body;

    const userId = req.user?.id || req.user?.userId;
    const { deviceName } = req.body;

    if (!userId || !deviceName) {
      return res.status(400).json({ error: 'Device Name is required.' });
    }

    const protocol = (req.headers['x-forwarded-proto'] as string) || req.protocol;
    const host = req.get('host');
    const backendUrl = `${protocol}://${host}/api/auth/devices/verify-setup`;

    try {

      // 3. Create a stateless signed JWT token expiring in 15 minutes
      const signOptions: SignOptions = { expiresIn: '15m' };
      const setupToken = jwt.sign(
        { 
          userId,
          scope: 'provisioning',
          deviceName: deviceName.trim(),
          backendUrl,
        },
        ENV.JWT_ACCESS_SECRET,
        signOptions
      );

      return res.status(201).json({ 
        setupToken // Returned to mobile app to transmit over BLE
      });
    } catch (err) {
      console.error('Error initiating device setup:', err);
      return res.status(500).json({ error: 'Failed to generate JWT.' });
    }
  }
);

// Edge Device registers after connecting to Wi-Fi and gets MQTT Credentials and an mTLS certificate
router.post(
  '/devices/verify-setup', 
  async (req: Request<{}, {}, VerifySetupRequestBody>, res: Response): Promise<Response> => {

  // 1. Extract the Authorization header
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ 
      error: 'Unauthorized: Missing or malformed Bearer token.' 
    });
  }

  // Separate "Bearer" from the actual JWT string
  const token = authHeader.split(' ')[1];

  // const { csr } = req.body;
  const { hardware_id } = req.body;

  // if (!csr) {
  //  return res.status(400).json({ 
  //    error: 'Bad Request: Missing Certificate Signing Request from device.' 
  //  });
  // }

  if (!hardware_id) {
    return res.status(400).json({ 
      error: 'Bad Request: Missing Hardware ID from device.' 
    });
  }

  // const csrParam = jsrsasign.KJUR.asn1.csr.CSRUtil.getParam(csr);

  // Read the Common Name (CN) directly from the parsed subject metadata map
  // if (!csrParam || !csrParam.subject || !csrParam.subject.str) {
  //    return res.status(400).json({ error: "CN (Common Name) attribute missing inside the compiled CSR." });
  // }
        
  // const subjectString: string = csrParam.subject.str;

  // const cnMatch = subjectString.match(/CN=([^/]+)/);
  // if (!cnMatch) {
  //    return res.status(400).json({ error: "CN (Common Name) attribute missing inside the compiled CSR string." });
  // }

  // const hardware_id: string = cnMatch[1];

  // if (!hardware_id) {
  //  return res.status(400).json({ 
  //    error: 'Bad Request: Missing Hardware ID in CSR.' 
  //  });
  // }

  const client: PoolClient = await pool.connect();

  try {

    await client.query('BEGIN');

    // Statelessly verify signature & expiration
    const decoded = jwt.verify(token, ENV.JWT_ACCESS_SECRET) as SetupJwtPayload;

    if (decoded.scope !== 'provisioning') {
      await client.query('ROLLBACK');
      return res.status(403).send('Invalid token scope for this action');
    }

    const whitelistResult = await client.query(
      `SELECT id, status
       FROM device_whitelist 
       WHERE hardware_id = $1`,
      [hardware_id]
    );

    if (whitelistResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Forbidden: Hardware ID is not whitelisted.' });
    }

    const whitelistEntry = whitelistResult.rows[0];

    if (whitelistEntry.status === 'revoked') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Device is not authorized for registration.' });
    }

    if (whitelistEntry.status === 'active') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Device is already registered by a user.' });
    }

    // Create new device ID
    const uuidResult = await client.query<{ id: string }>('SELECT uuid_generate_v4() AS id');
    const deviceId = uuidResult.rows[0].id;

    // Request signature from local CFSSL container on port 8888
    // const cfsslDomain = process.env.NODE_ENV === 'production' ? 'cfssl' : 'localhost';
    // const cfsslResponse = await axios.post<CFSSLSignedResponse>(`http://${cfsslDomain}:8888/api/v1/cfssl/sign`, {
    //     certificate_request: csr,
    //     profile: "client",
    //     subject: {
    //       CN: `device_${deviceId}`
	// }    
    // });
	
	const preauthKey = await generateHeadscalePreauthKey(decoded.userId, `tag:edge-device-${decoded.userId}`);

    // Insert device into database
    const newDevice = await client.query<Pick<DeviceRow, 'id' | 'user_id' | 'device_name'>>(
      `INSERT INTO devices (id, user_id, device_name, hardware_id) 
       VALUES ($1, $2, $3, $4) 
       RETURNING id, user_id, device_name`,
      [deviceId, decoded.userId, decoded.deviceName, hardware_id.trim()]
    );
    const device = newDevice.rows[0];

    // const mqttUsername = await provisionEdgeDeviceInMosquitto(device.id, device.user_id);

    // 5. Save the hardware_id and update MQTT credentials in PostgreSQL
    // await client.query(
    //  `UPDATE devices 
    //   SET mqtt_username = $1
    //   WHERE id = $2`,
    //  [mqttUsername, device.id]
    // );

    // ─────────────────────────────────────────────────────────────
    // Update device_whitelist to link user and mark as active
    // ─────────────────────────────────────────────────────────────
    await client.query(
      `UPDATE device_whitelist 
       SET status = 'active', 
           user_id = $1, 
           registered_at = NOW() 
       WHERE hardware_id = $2`,
      [decoded.userId, hardware_id]
    );

    await client.query('COMMIT');

    // Return signed certificate to the edge device
    return res.json({
      message: 'Device successfully verified and provisioned!',
      // signed_certificate: cfsslResponse.data.result.certificate,
	  preauth_key: preauthKey,
	  login_server: ENV.HEADSCALE_SUBDOMAIN,
    });
  }
  catch (err: unknown) {
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

	// --- HANDLE HEADSCALE PREAUTH KEY ERRORS ---
	const errorMessage = err instanceof Error ? err.message : 'Unknown Headscale Error occured';

	if (errorMessage.includes('Headscale') || (err as any).response) {
		console.error('Headscale Preauth Generation Error:', errorMessage);
		return res.status(503).json({
			error: `Failed to generate Headscale preauth key: ${errorMessage}`
		});
	}

    console.error('Error verifying setup token:', err);
    return res.status(400).json({ error: 'Invalid setup token or verification failed.' });
  } finally {
    client.release();
  }
});

export default router;
