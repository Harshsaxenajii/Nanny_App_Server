import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { config } from '../config';

export interface TokenPayload {
  userId: string;
  role:   string;
  mobile?: string;
}

export const JwtUtils = {
  signAccess:   (p: TokenPayload) => jwt.sign(p, config.jwt.accessSecret,  { expiresIn: config.jwt.accessExpiry  as any }),
  signRefresh:  (p: TokenPayload) => jwt.sign(p, config.jwt.refreshSecret, { expiresIn: config.jwt.refreshExpiry as any }),
  verifyAccess: (t: string)       => jwt.verify(t, config.jwt.accessSecret)  as TokenPayload,
  verifyRefresh:(t: string)       => jwt.verify(t, config.jwt.refreshSecret) as TokenPayload,
  hash:         (t: string)       => crypto.createHash('sha256').update(t).digest('hex'),
};
