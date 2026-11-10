import { Pool } from "pg";
import { deleteHeadscaleUser } from '../services/headscale.service';
import { deleteMqttUserFromMosquitto } from '../services/mqtt.service';
import { ENV } from "./env";

export const pool = new Pool({
  user: ENV.DB_USER,
  password: ENV.DB_PASSWORD, // Handles '@' automatically without encoding
  host: ENV.DB_HOST,
  port: ENV.DB_PORT, 
  database: ENV.DB_NAME,
});

export async function initDb(): Promise<void> {
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
	  is_verified BOOLEAN DEFAULT FALSE,
	  email_otp_hash VARCHAR(255),
	  email_otp_expires_at TIMESTAMP,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS devices (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          device_name VARCHAR(100) NOT NULL,
          hardware_id VARCHAR(255) UNIQUE NOT NULL,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
          CONSTRAINT unique_device_name_per_user UNIQUE (user_id, device_name)

      );

      DO $$ 
      BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'device_status') THEN
              CREATE TYPE device_status AS ENUM ('pre_authorized', 'active', 'revoked');
          END IF;
      END $$;

      CREATE TABLE IF NOT EXISTS device_whitelist (
          id SERIAL PRIMARY KEY,
          hardware_id VARCHAR(255) UNIQUE NOT NULL,
          status device_status DEFAULT 'pre_authorized',
          user_id UUID REFERENCES users(id) ON DELETE SET NULL, -- Linked when user registers it
          registered_at TIMESTAMP WITH TIME ZONE,
          created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables verified / created successfully.');
  } catch (err) {
    console.error('Error initializing database tables:', err);
  }
}

export function startUnverifiedUserCleanupJob() {
  const INTERVAL_MS = 1 * 60 * 1000; // Every 1 hour

  console.log('[Cleanup Job] Initializing background task for unverified users & MQTT credentials...');

  setInterval(async () => {
    try {
      // 1. Find unverified users older than 24 hours
      const expiredQuery = await pool.query(
        `SELECT id, username, mqtt_username FROM users 
         WHERE is_verified = FALSE 
         AND created_at < NOW() - INTERVAL '${ENV.DB_CLEANUP_INTERVAL}'`
      );

      const expiredUsers = expiredQuery.rows;

      if (expiredUsers.length === 0) {
        return;
      }

      console.log(`[Cleanup Job] Found ${expiredUsers.length} expired unverified user(s) to purge.`);

      for (const user of expiredUsers) {
        try {
          // 2. Delete the user from Mosquitto Dynamic Security
			if (user.mqtt_username) {
				await deleteMqttUserFromMosquitto(user.id, user.mqtt_username);
			}
          console.log(`[Cleanup Job] Deleted MQTT dynsec user: ${user.username}`);
        } catch (mqttErr) {
          console.error(`[Cleanup Job] Failed to delete MQTT user ${user.username}:`, mqttErr);
          // Continue deleting from DB even if MQTT deletion fails, or handle accordingly
        }
      }

      for (const user of expiredUsers) {
		  const userRemovedFromHeadscale = await deleteHeadscaleUser(user.id);
      }

      // 3. Bulk delete the expired users from PostgreSQL
      const userIds = expiredUsers.map((u) => u.id);
      const deleteResult = await pool.query(
        `DELETE FROM users WHERE id = ANY($1::uuid[])`, // or use integer[] depending on your ID type
        [userIds]
      );

      console.log(`[Cleanup Job] Successfully purged ${deleteResult.rowCount} unverified user(s) from PostgreSQL.`);
    } catch (err) {
      console.error('[Cleanup Job] Error during unverified user cleanup cycle:', err);
    }
  }, INTERVAL_MS);
}
