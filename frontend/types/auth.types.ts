export interface MqttCredentials {
  brokerUrl: string;
  username: string;
  password: string;
  topics: {
    telemetrySubscribe: string;
    commandPublish: string;
    statusSubscribe: string;
  }
}

export interface User {
  id: string | number;
  username: string;
  email: string;
}

export interface SessionState {
  isFinished: boolean;
}

export interface AuthState {
  user: User;
  token?: string;
  mqtt?: MqttCredentials;
}