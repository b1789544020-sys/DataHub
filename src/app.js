// DataHub - main server entry
// Express app: registers routes, static frontend, cron cleanup.

const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const config = require('./config');
const db = require('./db');
const authRouter = require('./routes/auth');
const filesRouter = require('./routes/files');
const { cleanExpired } = require('./jobs/cleanup');

const app = express();

// Trust X-Forwarded-* headers when behind a proxy (Railway, Render, etc.)
app.set('trust proxy', 1);

// Body parsing (JSON for auth)
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Request log (tiny)
app.use((req, _res, next) => {
  const t = new Date().toISOString();
  console.log(`[${t}] ${req.method} ${req.url}`);
  next();
});

// CORS - allow any origin for the API (since this is a "share to cloud" hub).
// In production, restrict to your known frontend origins.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-Download-Token');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API routes
app.use('/api/auth', authRouter);
app.use('/api', filesRouter);

// Public dirs (declared early so the share page can serve static files)
const publicDir = path.join(__dirname, '..', 'public');

// Health check
app.get('/healthz', (_req, res) => res.json({ ok: true, uptime: process.uptime() }));

// Home page - either the included static frontend, or a JSON message
const indexHtml = path.join(publicDir, 'index.html');
if (fs.existsSync(indexHtml)) {
  app.use(express.static(publicDir));
} else {
  app.get('/', (_req, res) => {
    res.json({
      name: 'DataHub',
      version: '1.0.0',
      description: 'Cloud storage + share links for tool outputs',
      endpoints: [
        'POST   /api/auth/register',
        'POST   /api/auth/login',
        'POST   /api/upload (multipart, file field=file)',
        'GET    /api/files (auth)',
        'DELETE /api/files/:id (auth)',
        'GET    /api/s/:code (public, metadata)',
        'POST   /api/s/:code/verify (public, password)',
        'GET    /api/s/:code/download (public, file stream)',
        'GET    /s/:code (public, share preview page)',
      ],
    });
  });
}

// Public share page (HTML) - mounted at /s/:code so it works without /api prefix.
// Note: this is a separate mount because the API router owns /api/s/:code.
const filesRouterForShare = require('./routes/files');
app.get(/^\/s\/([A-Za-z0-9_-]{4,32})$/, (req, res, next) => {
  // Re-target the URL to the filesRouter internal page handler.
  // We use a fresh path that the filesRouter matches: /s/:code/page
  const code = req.params[0];
  req.url = `/s/${encodeURIComponent(code)}/page`;
  // Re-attach the captured param so filesRouter sees it.
  req.params = { code };
  filesRouterForShare.handle(req, res, next);
});

// 404
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.url });
});

// Error handler
app.use((err, _req, res, _next) => {
  console.error('[ERR]', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Cron: clean expired files once an hour
cron.schedule('0 * * * *', () => {
  try {
    const removed = cleanExpired(db, config.storage.dir);
    if (removed > 0) console.log(`[cleanup] removed ${removed} expired file(s)`);
  } catch (e) {
    console.error('[cleanup] failed', e);
  }
});

const port = config.port;
app.listen(port, () => {
  console.log(`DataHub listening on http://localhost:${port}`);
  console.log(`  baseUrl: ${config.baseUrl}`);
  console.log(`  storage: ${config.storage.dir}`);
  console.log(`  db:      ${config.db.path}`);
});