import { Request, Response } from 'express';
import { GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Pool } from 'pg';
import { ENV } from '../config/env';
import { PlaylistItem } from '../types/video.types';
import spacesClient from '../services/spaces.service';

export const createPlaylistJsonHandler = (pool: Pool) => {
  return async (req: Request, res: Response) => {

	const { hardware_id } = req.body;

	if (!hardware_id) {
		return res.status(400).json({
			error: 'Bad Request: Missing hardware ID from device.'
		});
	}

    const client = await pool.connect();

    try {
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
    		SELECT id, user_id
    		FROM devices
    		WHERE hardware_id = $1;
   		`;

    	const deviceResult = await client.query(deviceQuery, [hardware_id]);

    	if (deviceResult.rows.length === 0) {
    		client.release();
    		res.status(404).json({ error: 'Device not found or does not belong to any user.' });
    	}

      // 1. List all video objects currently stored in the bucket
      const listCommand = new ListObjectsV2Command({
      	Bucket: ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME,
      	Prefix: `${deviceResult.rows[0].user_id}/`,
      });
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

/**
 * Deletes all files stored under a specific user's folder prefix in DigitalOcean Spaces.
 * @param userId The ID of the user whose account is being deleted
 */
export async function deleteAllUserVideosFromSpaces(userId: string): Promise<void> {
  const bucketName = ENV.DIGITAL_OCEAN_SPACES_BUCKET_NAME;
  const prefix = `${userId}/`;

  try {
    // 1. List all objects matching the user's prefix
    const listCommand = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
    });

    const listedObjects = await spacesClient.send(listCommand);

    // If the user has no videos stored, there's nothing to delete
    if (!listedObjects.Contents || listedObjects.Contents.length === 0) {
      return;
    }

    // 2. Map the results into an array of objects required by DeleteObjectsCommand
    const objectsToDelete = listedObjects.Contents
      .filter((item) => item.Key) // Ensure key exists
      .map((item) => ({ Key: item.Key as string }));

    if (objectsToDelete.length === 0) return;

    // 3. Batch delete the objects (S3/Spaces allows up to 1000 objects per delete request)
    const deleteCommand = new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: objectsToDelete,
        Quiet: true, // Optional: suppresses successful deletion logs in response
      },
    });

    await spacesClient.send(deleteCommand);
    console.log(`Successfully deleted ${objectsToDelete.length} video file(s) for user: ${userId}`);

  } catch (error) {
    console.error(`[Spaces Bulk Delete Error] Failed to delete files for user ${userId}:`, error);
    throw new Error('Failed to clean up user media files from cloud storage.');
  }
}
