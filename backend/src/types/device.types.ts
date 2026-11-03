import { JwtPayload } from "jsonwebtoken";

export interface DeviceRow {
  id: string;
  user_id: string;
  device_name: string;
  hardware_id: string | null;
  mqtt_username: string | null;
  // mqtt_password_hash: string | null;
  created_at: Date;
}

export interface SetupJwtPayload extends JwtPayload {
  userId: string;
  backendUrl: string;
  deviceName: string;
  scope: string;
}

export interface RequestSetupRequestBody {
  userId?: string;
  deviceName?: string;
}

export interface VerifySetupRequestBody {
  hardware_id: string;
  csr?: string;
  device_id?: string;
}

export interface FactoryPayload {
  hardwareId: string;
  timestamp: string;
  signature: string;
}