import { Router, Request, Response } from "express";
import { createPlaylistJsonHandler } from "../controllers/video.controller";
import { getDeviceMqttTopics } from "../services/mqtt.service";
import { pool } from "../config/database";
import { ENV } from "../config/env";

const router = Router();

router.post('/api/v1/devices/mqtt-request', async (req: Request, res: Response): Promise<Response> => {
    // Access the verified client certificate via the underlying socket wrapper
    const socket = req.socket as any; 
    const clientCert = socket.getPeerCertificate();
    
    if (!clientCert || !clientCert.subject) {
        return res.status(401).json({ error: "Client certificate missing from handshake context" });
    }
    
    const deviceId: string = clientCert.subject.CN;
    const client = await pool.connect();
    const deviceQuery = `
      SELECT hardware_id, user_id
      FROM devices
      WHERE id = $1;
    `;
    const deviceResult = await client.query(deviceQuery, [deviceId]);

    if (deviceResult.rows.length === 0) {
      client.release();
      res.status(404).json({ error: 'Device not found or does not belong to any user.' });
    }

    const whitelistCheck = `
      SELECT status 
      FROM device_whitelist
      WHERE hardware_id = $1
    `;
    const whitelistResult = await client.query(whitelistCheck, [deviceResult.rows[0].hardware_id]);

    if (whitelistResult.rows.length === 0) {
      await client.release();
      return res.status(403).json({ error: 'Forbidden: Hardware ID is not whitelisted.' });
    }

    if (whitelistResult.rows[0].status !== "active") {
      await client.release();
      return res.status(400).json({ error: 'Hardware is not listed as active' });
    }

    const topics = getDeviceMqttTopics(deviceResult.rows[0].user_id, deviceId);
    return res.status(200).json({
      message: 'Provisioning MQTT topics for device.',
      mqtt: {
        brokerUrl: ENV.MQTT_DEVICE_URL,
        topics: {
          telemetry: topics.telemetry,
          status: topics.status,
          commands: topics.commands,
        }
      },
    });
});

router.get(
  '/api/v1/stream/playlist',
  createPlaylistJsonHandler(pool)
);

export default router;