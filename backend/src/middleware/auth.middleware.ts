import { Request, Response, NextFunction } from "express";
import jwt, { JwtPayload } from 'jsonwebtoken';
import { ENV } from "../config/env";

// Extend Express Request type so TypeScript knows about the decoded user payload
// export interface AuthenticatedRequest extends Request {
//   user?: {
//     userId: string;
//     [key: string]: any;
//   };
// }

// Define the shape of your decoded token payload
export interface JwtPayloadUser {
  id?: string;
  userId?: string;
  username?: string;
  scope?: string;
  deviceName?: string;
  [key: string]: any; // Catch-all for any other custom claims
}

// Augment Express Request interface so req.user is recognized globally
declare global {
    namespace Express {
    interface Request {
      user?: JwtPayloadUser;
    }
  }
}

export const verifyJwtMiddleware = (requiredScope?: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            res.status(401).json({ error: 'Unauthorized: Missing or malformed Bearer token.' });
            return;
        }

        const token = authHeader.split(' ')[1];

        try {
            // Verify token signature and expiration using your secret key
            const decoded = jwt.verify(token, ENV.JWT_ACCESS_SECRET) as { userId: string };
            
            // Attach decoded info to the request object
            req.user = decoded;
            next();
        } catch (err: any) {

			if (err.name === 'TokenExpiredError') {
				console.log('Token expired at:', err.expiredAt);
            	res.status(401).json({ error: 'Your session has expired. Please log in again.' });
				return;
			}
			console.log('Invalid or tampered token:', err.message);
            res.status(401).json({ error: 'Unauthorized: Token is invalid.' });
            return;
        }
    };
}
