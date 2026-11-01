import { Request, Response } from "express";
import { Pool } from "pg";
import mqtt from "mqtt";

export const createDeviceDeleteHandler = (pool: Pool, mqttAdminClient: mqtt.MqttClient) => {
  return async (req: Request, res: Response): Promise<void> => {
    const { userId, deviceId } = req.params;

   // 🔒 Security Check: Ensure the authenticated user matches the requested device deletion ID
    if (req.user?.id !== userId) {
      res.status(403).json({ error: 'Forbidden: You can only delete your own account.' });
      return;
    }

    const client = await pool.connect();

    try {
      // 1. Fetch the device first to get its hardware_id and mqtt_username
      const deviceQuery = `
        SELECT hardware_id, mqtt_username 
        FROM devices 
        WHERE id = $1 AND user_id = $2;
      `;
      const deviceResult = await client.query(deviceQuery, [deviceId, userId]);

      if (deviceResult.rows.length === 0) {
        res.status(404).json({ error: 'Device not found or does not belong to this user.' });
        return;
      }

      const { hardware_id: hardwareId, mqtt_username: mqttUsername } = deviceResult.rows[0];
      const roleName = `role_device_${deviceId}`;

      // Start database transaction
      await client.query('BEGIN');

      // 2. Delete the device from the devices table
      const deleteDeviceQuery = `
        DELETE FROM devices 
        WHERE id = $1 AND user_id = $2;
      `;
      await client.query(deleteDeviceQuery, [deviceId, userId]);

      // 3. Update the device_whitelist table: 
      // Reset status to 'pre_authorized', clear user_id and registration timestamps
      const updateWhitelistQuery = `
        UPDATE device_whitelist 
        SET status = 'pre_authorized', 
            user_id = NULL, 
            registered_at = NULL 
        WHERE hardware_id = $1;
      `;
      await client.query(updateWhitelistQuery, [hardwareId]);

      // Commit the database transaction first
      await client.query('COMMIT');

      // 4. Remove MQTT credentials from Mosquitto Dynamic Security
      // Mosquitto dynamic security commands: deleteClient and deleteRole
      if (mqttUsername) {
        const deleteClientCmd = {
          commands: [
            {
              command: 'deleteClient',
              username: mqttUsername,
            }
          ]
        };

        const deleteRoleCmd = {
          commands: [
            {
              command: 'deleteRole',
              rolename: roleName,
            }
          ]
        };

        // Publish deletion commands to Mosquitto control topic
        mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(deleteClientCmd));
        mqttAdminClient.publish('$CONTROL/dynamic-security/v1', JSON.stringify(deleteRoleCmd));
      }

      res.status(200).json({ 
        success: true, 
        message: 'Device successfully deleted, whitelist reset, and MQTT credentials revoked.' 
      });

    } catch (error) {
      // Rollback database transaction on failure
      await client.query('ROLLBACK');
      console.error('[Database/MQTT Error] Failed to delete device:', error);
      res.status(500).json({ error: 'Internal server error while deleting device.' });
    } finally {
      // Release client back to the pool
      client.release();
    }
  };
};