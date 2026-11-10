import dotenv from 'dotenv';
dotenv.config();

import express, { Application } from 'express';
import https from 'https';
import http from 'http';
import fs from 'fs';

import healthRoutes from './routes/health.routes';
import authRoutes from './routes/auth.routes';
import deviceRoutes from './routes/device.routes';
import factoryRoutes from './routes/factory.routes';
import videoRoutes from './routes/video.routes';
import mtlsRoutes from './routes/mtls.routes';
import { initDb, startUnverifiedUserCleanupJob } from './config/database';
import { ENV } from './config/env';

const publicApp: Application = express();
publicApp.set('trust proxy', 'loopback'); // Trust the loopback interface for proxy headers
publicApp.use(express.json());
publicApp.use('/health', healthRoutes);
publicApp.use('/api/auth', authRoutes);
publicApp.use('/api/devices', deviceRoutes);
publicApp.use('/api/factory', factoryRoutes);
publicApp.use('/api/videos', videoRoutes);
publicApp.use('/iot', mtlsRoutes);

// const mtlsApp: Application = express();
// mtlsApp.use(express.json());
// mtlsApp.use('/iot', mtlsRoutes);

// const mtlsOptions: https.ServerOptions = {
//  key: process.env.NODE_ENV === 'production' ? fs.readFileSync(`/etc/letsencrypt/live/${process.env.DOMAIN_NAME}/privkey.pem`) : fs.readFileSync('./certbot-certs/server.key'),
//  cert: process.env.NODE_ENV === 'production' ? fs.readFileSync(`/etc/letsencrypt/live/${process.env.DOMAIN_NAME}/fullchain.pem`): fs.readFileSync('./certbot-certs/server.crt'),
//  ca: [process.env.NODE_ENV === 'production' ? fs.readFileSync('/app/cfssl-config/ca.pem') : fs.readFileSync('./cfssl/cfssl-config/ca.pem')],
//  requestCert: true,       // Force mTLS checking
//  rejectUnauthorized: true // Drop connections without a valid client certificate
// }

const startServer = async () => {
  try {
    await initDb();
    console.log('📦 Database initialized successfully.');

	startUnverifiedUserCleanupJob();

    http.createServer(publicApp).listen(ENV.NODE_UNENCRYPTED_PORT, () => {
        console.log(`🌐 Port ${ENV.NODE_UNENCRYPTED_PORT}: Unencrypted NodeJS HTTP Server Active`);
    });

    // https.createServer(mtlsOptions, mtlsApp).listen(ENV.NODE_MTLS_BACKEND_PORT, () => {
    //    console.log(`🔒 Port ${ENV.NODE_MTLS_BACKEND_PORT}: Secure mTLS HTTPS Server Active`);
    //});
  } catch(error) {
    console.error('❌ Failed to start server due to database error:', error);
    process.exit(1);
  }
};

startServer();
