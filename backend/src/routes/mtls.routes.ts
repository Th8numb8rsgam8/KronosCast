import { Router, Request, Response } from "express";
import { createPlaylistJsonHandler } from "../controllers/video.controller";
import { getDeviceMqttTopics, deriveDeterministicMqttPassword } from "../services/mqtt.service";
import { WifiAccessPoint, DeviceLocationPayload, GoogleGeolocationResponse } from "../types/device.types";
import { pool } from "../config/database";
import { ENV } from "../config/env";

const GOOGLE_GEOLOCATION_URL = 'https://www.googleapis.com/geolocation/v1/geolocate';

const router = Router();

router.post('/api/v1/devices/mqtt-request', async (req: Request, res: Response): Promise<Response> => {
    // Access the verified client certificate via the underlying socket wrapper

    // const socket = req.socket as any; 
    // const clientCert = socket.getPeerCertificate();
    
    // if (!clientCert || !clientCert.subject) {
        // return res.status(401).json({ error: "Client certificate missing from handshake context" });
    // }
    
    // const device_username: string = clientCert.subject.CN;
    // const deviceId: string = device_username.replace(/^device_/, '');
	
	const { hardware_id } = req.body;

	if (!hardware_id) {
    	return res.status(400).json({ 
      		error: 'Bad Request: Missing hardware ID from device.' 
    	});
	}
	
    const client = await pool.connect();
    // const deviceQuery = `
    //  SELECT hardware_id, user_id
    //  FROM devices
    //  WHERE id = $1;
    // `;
    // const deviceResult = await client.query(deviceQuery, [deviceId]);

    // if (deviceResult.rows.length === 0) {
    //  client.release();
    //  res.status(404).json({ error: 'Device not found or does not belong to any user.' });
    // }

    const whitelistCheck = `
      SELECT status 
      FROM device_whitelist
      WHERE hardware_id = $1
    `;
    // const whitelistResult = await client.query(whitelistCheck, [deviceResult.rows[0].hardware_id]);
    const whitelistResult = await client.query(whitelistCheck, [hardware_id]);

    if (whitelistResult.rows.length === 0) {
      await client.release();
      return res.status(403).json({ error: 'Forbidden: Hardware ID is not whitelisted.' });
    }

    if (whitelistResult.rows[0].status !== "active") {
      await client.release();
      return res.status(400).json({ error: 'Hardware is not listed as active' });
    }

    const deviceQuery = `
    	SELECT id, user_id, mqtt_username
    	FROM devices
    	WHERE hardware_id = $1;
   	`;
    const deviceResult = await client.query(deviceQuery, [hardware_id]);

    if (deviceResult.rows.length === 0) {
    	client.release();
    	res.status(404).json({ error: 'Device not found or does not belong to any user.' });
    }

    const topics = getDeviceMqttTopics(deviceResult.rows[0].user_id, deviceResult.rows[0].id);
	const rawMqttPassword = deriveDeterministicMqttPassword(deviceResult.rows[0].id);
    return res.status(200).json({
      message: 'Provisioning MQTT topics for device.',
      mqtt: {
        // brokerUrl: ENV.MQTT_DEVICE_URL,
        brokerUrl: ENV.MQTT_BROKER_URL,
		username: deviceResult.rows[0].mqtt_username,
		password: rawMqttPassword,
        topics: {
          telemetry: topics.telemetry,
          status: topics.status,
          commands: topics.commands,
        }
      },
    });
});


router.post('/api/v1/device/location', async (req: Request, res: Response): Promise<void> => {
  try {
    const apiKey = ENV.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      console.error('[Geolocation] Missing GOOGLE_MAPS_API_KEY in server environment');
      res.status(500).json({ error: 'Server geolocation configuration missing' });
      return;
    }

    const { hardware_id, considerIp = false, wifiAccessPoints } = req.body as DeviceLocationPayload;

    if (!hardware_id || typeof hardware_id !== 'string') {
      res.status(400).json({ error: 'hardware_id is required' });
      return;
    }

    // 1. Check device_whitelist BEFORE calling Google API to protect quota & block revoked/unknown hardware
    const whitelistResult = await pool.query(
      `SELECT status FROM device_whitelist WHERE hardware_id = $1`,
      [hardware_id]
    );

    if (whitelistResult.rowCount === 0) {
      res.status(403).json({ error: 'Hardware ID not found in whitelist' });
      return;
    }

    const deviceStatus: string = whitelistResult.rows[0].status;
    if (deviceStatus !== 'active') {
      res.status(403).json({ error: 'Device status is not active.' });
      return;
    }

    // 2. Validate Wi-Fi scan payload
    if (!Array.isArray(wifiAccessPoints)) {
      res.status(400).json({ error: 'wifiAccessPoints must be an array' });
      return;
    }

    if (wifiAccessPoints.length < 2 && !considerIp) {
      res.status(400).json({
        error: 'At least 2 valid Wi-Fi access points are required when considerIp is false'
      });
      return;
    }

    // 3. Query Google Geolocation API
    const googleResponse = await fetch(`${GOOGLE_GEOLOCATION_URL}?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        considerIp,
        wifiAccessPoints
      })
    });

    if (!googleResponse.ok) {
      const errorText = await googleResponse.text();
      console.error(`[Geolocation] Google API error (${googleResponse.status}):`, errorText);
      res.status(502).json({
        error: 'Upstream geolocation provider failed',
        details: googleResponse.status
      });
      return;
    }

    const geoData = (await googleResponse.json()) as GoogleGeolocationResponse;
    const { lat, lng } = geoData.location;
    const { accuracy } = geoData;

    // 4. Update the 'devices' table with the resolved coordinates
    const updateResult = await pool.query(
      `UPDATE devices
       SET latitude = $1,
           longitude = $2,
           accuracy = $3,
           location_updated_at = NOW()
       WHERE hardware_id = $4
       RETURNING id, device_name, latitude, longitude, accuracy, location_updated_at`,
      [lat, lng, accuracy, hardware_id]
    );

    if (updateResult.rowCount === 0) {
	console.warn(`[Geolocation] Active hardware_id ${hardware_id} missing from devices table`);
	res.status(404).json({ error: 'Registered device record not found' });
    }

    res.status(200).json({
      lat,
      lng,
      accuracy
    });
  } catch (err) {
    console.error('[Geolocation] Unexpected server error:', err);
    res.status(500).json({ error: 'Internal server error processing geolocation' });
  }
});

router.post(
  '/api/v1/stream/playlist',
  createPlaylistJsonHandler(pool)
);

export default router;
