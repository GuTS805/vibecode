import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import { router } from './routes.js';
import { startScheduler, startKeepAlive } from './scheduler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '256kb' }));

// Compact request log — useful when reading Render's live logs.
app.use((req, _res, next) => {
  if (req.path.startsWith('/api') && req.path !== '/api/health') {
    console.log(`${req.method} ${req.path}${req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''}`);
  }
  next();
});

app.use('/api', router);

/* --------------------- serve the built React frontend ---------------------- */

const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

if (fs.existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  // SPA fallback — anything not under /api returns index.html.
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'));
  });
} else {
  console.warn('[server] client/dist not found — run `npm run build` to serve the UI.');
  app.get('/', (_req, res) =>
    res.status(503).send('<h1>Frontend not built</h1><p>Run <code>npm run build</code>, then restart.</p>')
  );
}

app.use((req, res) => res.status(404).json({ error: `Not found: ${req.method} ${req.path}` }));

app.use((err, _req, res, _next) => {
  console.error('[error]', err);
  res.status(500).json({ error: err.message || 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
  if (!process.env.GEMINI_API_KEY) {
    console.warn('[server] WARNING: GEMINI_API_KEY is not set — cycles will fail.');
  }
  startScheduler();
  startKeepAlive();
});
