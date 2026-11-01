import { Router, Request, Response } from "express";
import { pool } from "../config/database";

const router = Router();

router.get(
  '/db_connection_ping', 
  async (_req: Request, res: Response): Promise<Response> => {
  try {
    const result = await pool.query<{ now: Date }>('SELECT NOW()');
    return res.json({
      status: 'success',
      message: 'Connected to PostgreSQL on Debian!',
      timestamp: result.rows[0].now,
    });
  } catch (err) {
    console.error('DB Connection Error:', err);
    return res.status(500).json({ error: 'Database connection failed' });
  }
});

export default router;