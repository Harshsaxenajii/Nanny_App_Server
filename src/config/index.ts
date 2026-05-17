import 'dotenv/config';

export const config = {
  env: process.env.NODE_ENV || 'development',
  isDev: process.env.NODE_ENV !== 'production',
  port: parseInt(process.env.PORT || '3000', 10),
  mongoUri: process.env.MONGO_URI || 'mongodb://localhost:27017/nanny_app',
  anthropic: {
    apiKey: process.env.ANTHROPIC_API_KEY || '',
  },
  jwt: {
    accessSecret:  process.env.JWT_ACCESS_SECRET  || 'dev_access_secret_min_32_chars_long',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_min_32_chars_long',
    accessExpiry:  process.env.JWT_ACCESS_EXPIRY  || '15m',
    refreshExpiry: process.env.JWT_REFRESH_EXPIRY || '30d',
    refreshExpiryMs: 30 * 24 * 60 * 60 * 1000,
  },
  otp: {
    expirySec:     parseInt(process.env.OTP_EXPIRY_SECONDS || '300', 10),
    maxAttempts:   parseInt(process.env.MAX_OTP_ATTEMPTS   || '5',   10),
    blockSec:      30 * 60,
  },
  msg91: {
    authKey:    process.env.MSG91_AUTH_KEY    || '',
    templateId: process.env.MSG91_TEMPLATE_ID || '',
    senderId:   process.env.MSG91_SENDER_ID   || 'NANNY',
  },
  razorpay: {
    keyId:         process.env.RAZORPAY_KEY_ID         || '',
    keySecret:     process.env.RAZORPAY_KEY_SECRET      || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET  || '',
  },
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3001').split(',').map(s => s.trim()),
};
