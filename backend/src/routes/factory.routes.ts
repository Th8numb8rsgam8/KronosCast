import fs from 'fs';
import crypto from 'crypto';
import { pool } from '../config/database';
import { Router, Request, Response } from "express";
import { FactoryPayload } from '../types/device.types'

const router = Router();

const PUBLIC_KEY_PEM = fs.readFileSync('./public_key.pem', 'utf8');

router.post('/registration', async (req: Request, res: Response): Promise<any> => {
  try {

    const { hardwareId, timestamp, signature } = req.body as FactoryPayload;

    if (!hardwareId || !timestamp || !signature) {
      return res.status(400).json({ error: 'Missing required cryptographic fields' });
    }

    // 1. Prevent Replay Attacks: Check if timestamp is within a reasonable window (e.g., 5 minutes)
    const requestTime = parseInt(timestamp, 10);
    const currentTime = Math.floor(Date.now() / 1000);
    if (isNaN(requestTime) || Math.abs(currentTime - requestTime) > 300) {
      return res.status(403).json({ error: 'Timestamp expired or invalid' });
    }

    // 2. Recreate the exact message that was signed on the factory machine
    const message = `${hardwareId}:${timestamp}`;

    // 3. Verify the signature using Node.js crypto
    const verifier = crypto.createVerify('SHA256');
    verifier.update(message);
    verifier.end();

    const isSignatureValid = verifier.verify(
      {
        key: PUBLIC_KEY_PEM,
        format: 'pem',
        type: 'spki',
      },
      Buffer.from(signature, 'hex')
    );

    if (!isSignatureValid) {
      return res.status(403).json({ error: 'Cryptographic signature verification failed' });
    }

    // 4. Signature is valid! Save/Insert into PostgreSQL whitelist
    const query = `
      INSERT INTO device_whitelist (hardware_id, status)
      VALUES ($1, $2)
      ON CONFLICT (hardware_id) 
      DO NOTHING
      RETURNING hardware_id, status
    `;

    const result = await pool.query(query, [hardwareId, 'pre_authorized']);
    
    return res.status(200).json({
      success: true,
      message: 'Device verified via asymmetric signature and whitelisted successfully',
      device: result.rows[0],
    });

  } catch (error) {
    console.error('Error verifying factory signature:', error);
    return res.status(500).json({ error: 'Internal server error during verification' });
  }
});

export default router;