import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { Pool } from 'pg';
import mqtt from 'mqtt';
import { deleteHeadscaleUser, deleteHeadscaleNodeByHostname } from '../services/headscale.service';
import { deleteAllUserVideosFromSpaces } from '../controllers/video.controller';
import { ENV } from '../config/env';

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

		await deleteAllUserVideosFromSpaces(userId);

      // 1. Fetch user info and all associated devices to clean up MQTT & Whitelists properly
      const userQuery = `SELECT mqtt_username FROM users WHERE id = $1;`;
      const userResult = await client.query(userQuery, [userId]);

      if (userResult.rows.length === 0) {
        res.status(404).json({ error: 'User not found.' });
        return;
      }

      const userMqttUsername = userResult.rows[0].mqtt_username;

      const devicesQuery = `SELECT id, hardware_id FROM devices WHERE user_id = $1;`;
      const devicesResult = await client.query(devicesQuery, [userId]);
      const devices = devicesResult.rows;

	  // Remove user's devices from Headscale private network
	  for (const device of devices) {
		  const removedNodeFromHeadscale = await deleteHeadscaleNodeByHostname(device.hardware_id);
		  if (!removedNodeFromHeadscale) {
			  console.log(`Failed to delete Node from Headscale of device ${device.hardware_id}`);
		  }
	  }

	  const removedUserFromHeadscale = await deleteHeadscaleUser(userId);
	  if (!removedUserFromHeadscale) {
		console.log(`Failed to delete User from Headscale: ${userId}`);
	  }

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
