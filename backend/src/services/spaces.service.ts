import { S3Client } from "@aws-sdk/client-s3";
import { ENV } from "../config/env";

// Initialize the S3 client configured for DigitalOcean Spaces
const spacesClient = new S3Client({
  region: 'sfo3',
  endpoint: ENV.DIGITAL_OCEAN_SPACES_ENDPOINT, 
  forcePathStyle: true,
  credentials: {
    accessKeyId: ENV.DIGITAL_OCEAN_SPACES_ACCESS_KEY_ID || '',
    secretAccessKey: ENV.DIGITAL_OCEAN_SPACES_ACCESS_KEY_SECRET || '',
  },
});

export default spacesClient;