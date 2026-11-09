import { JwtPayload } from "jsonwebtoken";

export interface UserRow {
  id: string;
  username: string;
  email: string;
  password_hash: string;
  mqtt_username: string | null;
  mqtt_password_hash: string | null;
  created_at: Date;

  is_verified: boolean;
  email_otp_hash: string | null;
  email_otp_expires_at: Date | null;
}

export interface UserPayload extends JwtPayload {
  id: string;
  username: string;
}

export interface SignupRequestBody {
  username?: string;
  email?: string;
  password?: string;
}

export interface LoginRequestBody {
  email?: string;
  password?: string;
}
