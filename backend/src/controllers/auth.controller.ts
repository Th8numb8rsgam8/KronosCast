import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import mqtt from 'mqtt';
import { ENV } from '../config/env';
import { PreAuthKeyResponse } from '../types/device.types';

export const createHeadscaleUser = async (username: string): Promise<boolean> => {
	try {
		const response = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/user`, {
			method: 'POST',
			headers: {
				'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
				'Content-Type': 'application/json'
			},
			body: JSON.stringify({ name: username })
		});

		if (!response.ok) {
			const errorText = await response.text();
			if (response.status === 409 || errorText.includes('already exists')) {
				console.warn(`User ${username} already exists on Headscale.`);
				return true;
			}
			throw new Error(`Failed to create user: ${response.status} - ${errorText}`);
		}

		console.log(`Successfully created Headscale user: ${username}`);
		return true;
	} catch (error) {
		console.error('Error in createUser:', error);
		throw error;
	}
}

export const generateHeadscalePreauthKey = async (username: string, tag: string): Promise<string> => {

	const headscaleUsers = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/user`, {
		method: 'GET',
		headers: {
			'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
			'Content-Type': 'application/json'
		}
	});

	if (!headscaleUsers.ok) {
		throw new Error(`Failed to fetch Headscale users list: ${headscaleUsers.status}`);
	}
	const userData = (await headscaleUsers.json()) as { users: Array<{ id: number; name: string }> };
	const matchedUser = userData.users.find((u) => u.name === username);

	if (!matchedUser) {
		throw new Error(`Could not find numerid ID for Headscale user: ${username}`);
	}

	const response = await fetch(`${ENV.HEADSCALE_API_URL}/api/v1/preauthkey`, {
		method: 'POST',
		headers: {
			'Authorization': `Bearer ${ENV.HEADSCALE_API_KEY}`,
			'Content-Type': 'application/json'
		},
		body: JSON.stringify({
			user: matchedUser.id.toString(),
			reusable: false,
			ephemeral: false,
			expiration: new Date(Date.now() + 30 * 50 * 1000).toISOString(),
			aclTags: [tag],
		}),
	});

	if (!response.ok) {
		const errorBody = await response.text();
		throw new Error(`Headscale API error (${response.status}): ${errorBody}`);
	}

	const data = (await response.json()) as PreAuthKeyResponse;

	const key = data.preAuthKey?.key || data.key;
	if (!key) {
		throw new Error('Malformed response received from Headscale API: missing key.');
	}

	return key;
}

// Generate short-lived Access Token (15 mins)
export const generateAccessToken = (user: { id: string; username: string }): string => {
  return jwt.sign(
    { id: user.id, username: user.username }, 
    ENV.JWT_ACCESS_SECRET, 
    { expiresIn: '15m' }
  );
};

// Generate long-lived Refresh Token (7 days)
export const generateRefreshToken = (user: { id: string; username: string }): string => {
  return jwt.sign(
    { id: user.id, username: user.username }, 
    ENV.JWT_REFRESH_SECRET, 
    { expiresIn: '7d' }
  );
};

export const createUserAccountDeleteHandler = (pool: Pool, mqttAdminClient: mqtt.MqttClient) => {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId } = req.params;

    // 🔒 Security Check: Ensure the authenticated user matches the requested account deletion ID
    if (req.user?.id !== userId) {
      res.status(403).json({ error: 'Forbidden: You can only delete your own account.' });
      return;
    }

    const client = await pool.connect();

    try {
      // 1. Fetch user info and all associated devices to clean up MQTT & Whitelists properly
      const userQuery = `SELECT mqtt_username FROM users WHERE id = $1;`;
      const userResult = await client.query(userQuery, [userId]);

      if (userResult.rows.length === 0) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const userMqttUsername = userResult.rows[0].mqtt_username;

      const devicesQuery = `SELECT id, hardware_id, mqtt_username FROM devices WHERE user_id = $1;`;
      const devicesResult = await client.query(devicesQuery, [userId]);
      const devices = devicesResult.rows;

      // Start database transaction
      await client.query('BEGIN');

      // 2. Reset device_whitelist entries for all devices owned by this user
      for (const device of devices) {
        await client.query(
          `UPDATE device_whitelist 
           SET status = 'pre_authorized', 
               user_id = NULL, 
               registered_at = NULL 
           WHERE hardware_id = $1`,
          [device.hardware_id]
        );
      }

      // 3. Delete the user from the database. 
      // Note: Because of `ON DELETE CASCADE` on your devices table foreign key, 
      // deleting the user will automatically drop all rows in the devices table.
      await client.query(`DELETE FROM users WHERE id = $1;`, [userId]);

      // Commit the database transaction
      await client.query('COMMIT');

      // 4. Clean up Mosquitto Dynamic Security for all devices
      for (const device of devices) {
        const roleName = `role_device_${device.id}`;
        
        if (device.mqtt_username) {
          mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify({
            commands: [{ command: 'deleteClient', username: device.mqtt_username }]
          }));
        }

        mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify({
          commands: [{ command: 'deleteRole', rolename: roleName }]
        }));
      }

      // 5. Clean up Mosquitto Dynamic Security for the user account itself
      if (userMqttUsername) {
        const userRoleName = `role_user_${userId}`;

        mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify({
          commands: [{ command: 'deleteClient', username: userMqttUsername }]
        }));

        mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify({
          commands: [{ command: 'deleteRole', rolename: userRoleName }]
        }));
      }

      res.status(200).json({ 
        success: true, 
        message: 'Account, associated devices, whitelist records, and all MQTT credentials successfully deleted.' 
      });

    } catch (error) {
      await client.query('ROLLBACK');
      console.error('[Database/MQTT Error] Failed to delete user account:', error);
      res.status(500).json({ error: 'Internal server error while deleting account.' });
    } finally {
      client.release();
    }
  };
};
