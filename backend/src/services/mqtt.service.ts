import crypto from 'crypto';
import mqtt from 'mqtt';
import { ENV } from '../config/env';

// ----------------------------------------------------------------------------
// MQTT ADMIN CLIENT & PROVISIONING SERVICE (DynSec Plugin)
// ----------------------------------------------------------------------------
const mqttAdminClient = mqtt.connect(ENV.MQTT_BROKER_URL, {
  username: ENV.MQTT_ADMIN_USER,
  password: ENV.MQTT_ADMIN_PASS,
  reconnectPeriod: 5000,
});

mqttAdminClient.on('connect', () => {
  console.log('Connected to Mosquitto MQTT Broker as Admin.');
});

mqttAdminClient.on('error', (err: Error) => {
  console.error('Mosquitto Admin Connection Error:', err.message);
});

export function deriveDeterministicMqttPassword(userId: string): string {
	const pepper = ENV.MQTT_PASSWORD_PEPPER;
	return crypto.createHmac('sha256', pepper).update(`user_${userId}`).digest('hex');
}

export function getDeviceMqttTopics(userId: string, deviceId: string) {
  return {
    telemetry: `users/${userId}/devices/${deviceId}/telemetry`,
    status: `users/${userId}/devices/${deviceId}/status`,
    commands: `users/${userId}/devices/${deviceId}/commands`,
  };
}

/**
 * Provisions dynamic RBAC role and client credentials inside Mosquitto via $CONTROL/dynamic-security/v1
 */
export async function provisionMqttUserInMosquitto(userId: string, rawMqttPassword: string): Promise<string> {
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
export async function provisionEdgeDeviceInMosquitto(deviceId: string, userId: string): Promise<string> {
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
export function buildMqttResponseObject(userId: string, mqttUsername: string, rawMqttPassword: string) {
  return {
    brokerUrl: ENV.MQTT_PUBLIC_URL,
    username: mqttUsername,
    password: rawMqttPassword,
    topics: {
      telemetrySubscribe: `users/${userId}/devices/+/telemetry`,
      statusSubscribe: `users/${userId}/devices/+/status`,
      commandPublish: `users/${userId}/devices/{deviceId}/commands`,
    }
  };
}

export default mqttAdminClient;
