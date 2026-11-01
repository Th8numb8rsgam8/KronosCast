import { Request, Response } from 'express';
import { GetObjectCommand, ListObjectsV2Command,} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Pool } from 'pg';
import { ENV } from '../config/env';
import { PlaylistItem } from '../types/video.types';
import spacesClient from '../services/spaces.service';

export const createPlaylistJsonHandler = (pool: Pool) => {
  return async (req: Request, res: Response) => {
    const client = await pool.connect();

    try {

      // 1. List all video objects currently stored in the bucket
      const listCommand = new ListObjectsV2Command({ Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME });
      const response = await spacesClient.send(listCommand);

      if (!response.Contents) {
        return res.status(200).json({ playlist: [] });
      }

      // const validObjects = response.Contents.filter((obj) => typeof obj.Key === "string");

      const playlist: PlaylistItem[] = [];

      // 2. Map over files to get exact sizes and generate secure signed URLs
      for (const object of response.Contents) {
        const key = object.Key;
        if (!key) continue;

        const sizeBytes = object.Size ?? 0;
        // const sizeMb = Math.ceil(sizeBytes / (1024 * 1024));

        const getObjectCommand = new GetObjectCommand({ Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME, Key: key });
        const signedUrl = await getSignedUrl(spacesClient, getObjectCommand, { expiresIn: 21600 });

        playlist.push({
          id: key.replace(/\.[^/.]+$/, ""),
          filename: key,
          url: signedUrl,
          size_bytes: sizeBytes,
        });
      }

      // Return the array as clean JSON to the Raspberry Pi
      res.status(200).json(playlist);
    } catch (err) {
      console.error('[Playlist Generation Error] Failed to create presigned playlist:', err);
      res.status(500).json({ error: 'Internal server error generating playlist.' });
    } finally {
      client.release();
    }
  };
};