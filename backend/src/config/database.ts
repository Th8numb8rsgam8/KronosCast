import { Pool } from "pg";
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
          created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS devices (
          id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
          user_id UUID REFERENCES users(id) ON DELETE CASCADE,
          device_name VARCHAR(100) NOT NULL,
          hardware_id VARCHAR(255) UNIQUE NOT NULL,
          mqtt_username VARCHAR(100) UNIQUE,
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