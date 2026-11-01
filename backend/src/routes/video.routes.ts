import { Router, Request, Response } from "express";
import { upload } from '../middleware/upload.middleware';
import { verifyJwtMiddleware } from "../middleware/auth.middleware";
import { PutObjectCommand, ListObjectsV2Command,} from '@aws-sdk/client-s3';
import { v4 as uuidv4 } from 'uuid';
import { VideoItem } from "../types/video.types";
import spacesClient from "../services/spaces.service";
import { ENV } from "../config/env";

const router = Router();

/**
 * GET /api/videos
 * Fetches/lists all uploaded videos from the DigitalOcean Spaces bucket
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const command = new ListObjectsV2Command({
      Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
    });

    const response = await spacesClient.send(command);
    
    const endpoint = ENV.DIGITAL_OCEAN_SPACES_ENDPOINT || '';
    const formattedEndpoint = endpoint.replace('//', `//${ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME}.`);

    const videos: VideoItem[] = (response.Contents || []).map((item) => {
      const fileUrl = `${formattedEndpoint}/${item.Key}`;
      
      return {
        id: item.ETag?.replace(/"/g, ''),
        filename: item.Key || '',
        url: fileUrl,
        size: item.Size,
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

    const fileExtension = req.file.originalname.split('.').pop() || 'mp4';
    const fileName = `videos/${uuidv4()}.${fileExtension}`;

    const uploadCommand = new PutObjectCommand({
      Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
      Key: fileName,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
      ACL: 'public-read',
    });

    await spacesClient.send(uploadCommand);

    const fileUrl = `${ENV.DIGITAL_OCEAN_SPACES_ENDPOINT.replace('//', `//${ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME}.`)}/${fileName}`;

    res.status(201).json({
      success: true,
      message: 'Video uploaded successfully',
      video: {
        filename: fileName,
        url: fileUrl,
      },
    });
  } catch (error) {
    console.error('[Upload Error] Failed to upload video to Spaces:', error);
    res.status(500).json({ error: 'Video upload failed.' });
  }
});

export default router;