import { z } from 'zod';

const envSchema = z.object({
    DB_USER: z.string(),
    DB_PASSWORD: z.string(),
    // DB_HOST: z.ipv4(),
    DB_HOST: z.string(),
    DB_PORT: z.coerce.number(),
    DB_NAME: z.string(),
    JWT_ACCESS_SECRET: z.string(),
    JWT_REFRESH_SECRET: z.string(),
    MTLS_BACKEND_PORT: z.coerce.number(),
    MQTT_BROKER_URL: z.url(),
    MQTT_PUBLIC_URL: z.url(),
    MQTT_DEVICE_URL: z.url(),
    MQTT_ADMIN_USER: z.string(),
    MQTT_ADMIN_PASS: z.string(),
    DIGITAL_OCEAN_SPACES_BUCKET_NAME: z.string(),
    DIGITAL_OCEAN_SPACES_ENDPOINT: z.url(),
    DIGITAL_OCEAN_SPACES_ACCESS_KEY_ID: z.string(),
    DIGITAL_OCEAN_SPACES_ACCESS_KEY_SECRET: z.string()
});

const parsedEnv = envSchema.safeParse({
    DB_USER: process.env.DB_USER,
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_HOST: process.env.DB_HOST,
    DB_PORT: process.env.DB_PORT,
    DB_NAME: process.env.DB_NAME,
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
    MTLS_BACKEND_PORT: process.env.MTLS_BACKEND_PORT,
    MQTT_BROKER_URL: process.env.MQTT_BROKER_URL,
    MQTT_PUBLIC_URL: process.env.MQTT_PUBLIC_URL,
    MQTT_DEVICE_URL: process.env.MQTT_DEVICE_URL,
    MQTT_ADMIN_USER: process.env.MQTT_ADMIN_USER,
    MQTT_ADMIN_PASS: process.env.MQTT_ADMIN_PASS,
    DIGITAL_OCEAN_SPACES_BUCKET_NAME: process.env.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
    DIGITAL_OCEAN_SPACES_ENDPOINT: process.env.DIGITAL_OCEAN_SPACES_ENDPOINT,
    DIGITAL_OCEAN_SPACES_ACCESS_KEY_ID: process.env.DIGITAL_OCEAN_SPACES_ACCESS_KEY_ID,
    DIGITAL_OCEAN_SPACES_ACCESS_KEY_SECRET: process.env.DIGITAL_OCEAN_SPACES_ACCESS_KEY_SECRET
})

if (!parsedEnv.success) {
    // console.error(' Invalid environment variables:', z.treeifyError(parsedEnv.error));
    console.error(' Invalid environment variables:', JSON.stringify(parsedEnv.error.issues, null, 2));
    throw new Error('Invalid environment variables');
}

export const ENV = parsedEnv.data;
