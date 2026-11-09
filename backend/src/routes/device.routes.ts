import { Router, Request, Response } from "express";
import { pool } from "../config/database";
// import mqttAdminClient from "../services/mqtt.service";
import { verifyJwtMiddleware } from "../middleware/auth.middleware";
import { createDeviceDeleteHandler } from "../controllers/device.controller";
import { DeviceRow } from "../types/device.types";

const router  = Router();

router.delete(
  '/:userId/:deviceId', 
  verifyJwtMiddleware(),
  createDeviceDeleteHandler(pool)
);

// Get all devices owned by a user
router.get(
  '/:userId', 
  async (req: Request<{ userId: string }>, res: Response): Promise<Response> => {
    const { userId } = req.params;

    try {
      const result = await pool.query<DeviceRow>(
        `SELECT id, device_name, created_at 
         FROM devices 
         WHERE user_id = $1 
         ORDER BY created_at DESC`,
        [userId]
      );

      return res.json({ devices: result.rows });
    } catch (err) {
      console.error('Error fetching devices:', err);
      return res.status(500).json({ error: 'Failed to fetch user devices.' });
    }
  }
);

export default router;
