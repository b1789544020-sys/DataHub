// DataHub - Centralized Configuration
// All environment variables are loaded here and exposed as a single object.

const path = require('path');
require('dotenv').config();

const rootDir = path.resolve(__dirname, '..');

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  jwt: {
    secret: process.env.JWT_SECRET || 'datahub-dev-secret-change-me',
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  },

  storage: {
    dir: path.resolve(rootDir, process.env.STORAGE_DIR || './storage'),
    maxFileSizeMB: parseInt(process.env.MAX_FILE_SIZE_MB, 10) || 10,
    maxUserQuotaMB: parseInt(process.env.MAX_USER_QUOTA_MB, 10) || 100,
    linkExpiryDays: parseInt(process.env.LINK_EXPIRY_DAYS, 10) || 7,
  },

  baseUrl: process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`,

  cors: {
    origin: process.env.CORS_ORIGIN || '*',
  },

  db: {
    path: process.env.DB_PATH
      ? path.resolve(rootDir, process.env.DB_PATH)
      : path.resolve(rootDir, './storage/datahub.db'),
  },

  rateLimit: {
    // Public share endpoints (per IP)
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 60 * 1000,
    max: parseInt(process.env.RATE_LIMIT_MAX, 10) || 30,
  },

  authRateLimit: {
    // register/login (per IP)
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 20,
  },
};

if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
  console.warn('[config] WARNING: JWT_SECRET is not set; falling back to an insecure built-in secret. Set JWT_SECRET in production.');
}

module.exports = config;