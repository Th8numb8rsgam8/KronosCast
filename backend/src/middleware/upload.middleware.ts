import multer from 'multer';

// Configure multer with memory storage and type definitions
export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB limit
});