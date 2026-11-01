import { Router, Request, Response } from "express";
import { upload } from '../middleware/upload.middleware';
import { verifyJwtMiddleware } from "../middleware/auth.middleware";
import { PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { VideoItem } from "../types/video.types";
import spacesClient from "../services/spaces.service";
import { ENV } from "../config/env";

const router = Router();

/**
 * GET /api/videos
 * Fetches/lists all uploaded videos from the DigitalOcean Spaces bucket
 */
router.get(
  '/', 
  verifyJwtMiddleware(),
  async (req: Request, res: Response) => {
  try {

    const userId = (req.user as any)?.userId || (req.user as any)?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const listCommand = new ListObjectsV2Command({
      Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
      Prefix: `${userId}/`,
    });

    const response = await spacesClient.send(listCommand);
    const contents = response.Contents || [];
    
    const endpoint = ENV.DIGITAL_OCEAN_SPACES_ENDPOINT || '';
    const formattedEndpoint = endpoint.replace('//', `//${ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME}.`);

    const videos: VideoItem[] = contents
      .filter((item) => item.Key && item.Key !== `${userId}`)
      .map((item) => {

        // Extract filename from 'userId/filename.mp4'
        const filename = item.Key ? item.Key.split('/').pop() || '' : '';
        // Convert size from bytes to Megabytes (rounded to 2 decimal places)
        const sizeMb = item.Size ? Number((item.Size / (1024 * 1024)).toFixed(2)) : 0;
        // const fileUrl = `${formattedEndpoint}/${item.Key}`;
      
        return {
          id: item.Key,
          filename,
          url: `${formattedEndpoint}/${item.Key}`,
          size: sizeMb,
          lastModified: item.LastModified,
        };
    });

    res.status(200).json({ success: true, videos });
  } catch (error) {
    console.error('[Spaces Error] Failed to list videos:', error);
    res.status(500).json({ error: 'Failed to fetch videos from storage.' });
  }
});

/**
 * POST /api/videos/upload
 * Handles video file uploads from frontend and pushes them to DigitalOcean Spaces
 */
router.post(
  '/upload', 
  verifyJwtMiddleware(),
  upload.single('video'), 
  async (req: Request, res: Response): Promise<void> => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No video file provided.' });
      return;
    }

    const userId = (req.user as any)?.userId || (req.user as any)?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized: User ID missing from token.'});
      return;
    }

    // 2. Read the custom name sent from the frontend body form data
    const customName = req.body.name;
    if (!customName || typeof customName !== 'string' || !customName.trim()) {
      res.status(400).json({ error: 'A valid video name is required.' });
      return;
    }

    // Sanitize the filename to prevent path traversal or unsafe characters
    const sanitizedName = customName.trim().replace(/[^a-zA-Z0-9_\-\.]/g, '_');
    const fileExtension = sanitizedName.split('.').pop()?.toLowerCase() === 'mp4' ? '' : '.mp4';
    const fileName = `${sanitizedName}${fileExtension}`;

    // 3. Define the S3 Key with a folder structure based on the user ID
    const s3Key = `${userId}/${fileName}`;

    const uploadCommand = new PutObjectCommand({
      Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
      Key: s3Key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read',
    });

    await spacesClient.send(uploadCommand);

    const fileUrl = `${ENV.DIGITAL_OCEAN_SPACES_ENDPOINT.replace('//', `//${ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME}.`)}/${s3Key}`;

    res.status(201).json({
      success: true,
      message: 'Video uploaded successfully',
      video: {
        filename: fileName,
        path: s3Key,
        url: fileUrl,
      },
    });
  } catch (error) {
    console.error('[Upload Error] Failed to upload video to Spaces:', error);
    res.status(500).json({ error: 'Video upload failed.' });
  }
});

router.delete(
  '/', 
  verifyJwtMiddleware(), 
  async (req: Request, res: Response): Promise<void> => {
  try {
    const userId = (req.user as any)?.userId || (req.user as any)?.id;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }

    const { s3Key } = req.body;
    if (!s3Key || typeof s3Key !== 'string') {
      res.status(400).json({ error: 'A valid s3Key is required.' });
      return;
    }

    // 🛡️ Security Check: Ensure the user is only deleting files inside their own folder prefix
    if (!s3Key.startsWith(`${userId}/`)) {
      res.status(403).json({ error: 'Forbidden: You can only delete your own files.' });
      return;
    }

    const deleteCommand = new DeleteObjectCommand({
      Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
      Key: s3Key,
    });

    await spacesClient.send(deleteCommand);

    res.status(200).json({ success: true, message: 'Video deleted successfully.' });
  } catch (error) {
    console.error('[Delete Video Error]:', error);
    res.status(500).json({ error: 'Failed to delete video from storage.' });
  }
});

export default router;