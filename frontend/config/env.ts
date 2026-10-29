import { z } from 'zod';

const envSchema = z.object({
    BACKEND_PROTOCOL: z.string(),
    BACKEND_IP: z.string().ip(),
    BACKEND_PORT: z.coerce.number(),
    SERVICE_UUID: z.string().uuid(),
    SSID_CHARACTERISTIC_UUID: z.string().uuid(),
    PASS_CHARACTERISTIC_UUID: z.string().uuid(),
    JWT_CHARACTERISTIC_UUID: z.string().uuid(),
    STATUS_CHARACTERISTIC_UUID: z.string().uuid()
});

const parsedEnv = envSchema.safeParse({
    BACKEND_PROTOCOL: process.env.EXPO_PUBLIC_BACKEND_PROTOCOL,
    BACKEND_IP: process.env.EXPO_PUBLIC_BACKEND_IP,
    BACKEND_PORT: process.env.EXPO_PUBLIC_BACKEND_PORT,
    SERVICE_UUID: process.env.EXPO_PUBLIC_SERVICE_UUID,
    SSID_CHARACTERISTIC_UUID: process.env.EXPO_PUBLIC_SSID_CHARACTERISTIC_UUID,
    PASS_CHARACTERISTIC_UUID: process.env.EXPO_PUBLIC_PASS_CHARACTERISTIC_UUID, 
    JWT_CHARACTERISTIC_UUID: process.env.EXPO_PUBLIC_JWT_CHARACTERISTIC_UUID, 
    STATUS_CHARACTERISTIC_UUID: process.env.EXPO_PUBLIC_STATUS_CHARACTERISTIC_UUID, 
})

if (!parsedEnv.success) {
    console.error(' Invalid environment variables:', parsedEnv.error.format());
    throw new Error('Invalid environment variables');
}

export const ENV = parsedEnv.data;