#!/usr/bin/env node
/**
 * Local dev server — runs the Netlify function + Vite together without
 * needing Netlify CLI. One command, no global install, no login.
 *
 * Usage:
 *   npm run dev:local
 *   open  http://localhost:3000
 *
 * What it does:
 *   - Starts an HTTP server on :8888 that loads netlify/functions/search.js
 *     and invokes its handler the same way Netlify would (event/context).
 *   - Spawns `vite` on :3000. The existing vite.config.js proxy already
 *     rewrites /api/search -> /.netlify/functions/search -> :8888.
 *
 * Changes to .js files under netlify/functions/ require a restart of this
 * script (Ctrl-C and re-run); Vite itself hot-reloads the front-end.
 */

import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// CommonJS require, since netlify/functions uses exports.handler
const require = createRequire(import.meta.url);
const funcPath = path.join(ROOT, 'netlify', 'functions', 'search.js');

let handler;
try {
  ({ handler } = require(funcPath));
} catch (err) {
  console.error('Failed to load netlify/functions/search.js:', err.message);
  process.exit(1);
}

const FUNCTIONS_PORT = 8888;
const VITE_PORT = 3000;

const server = http.createServer(async (req, res) => {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
    });
    res.end();
    return;
  }

  // Only /.netlify/functions/search is wired here; everything else 404.
  const url = new URL(req.url, `http://localhost:${FUNCTIONS_PORT}`);
  if (!url.pathname.endsWith('/.netlify/functions/search')) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found\n');
    return;
  }

  // Collect body if any (search.js doesn't use it, but keep parity).
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');

  const event = {
    httpMethod: req.method,
    path: url.pathname,
    queryStringParameters: Object.fromEntries(url.searchParams),
    headers: req.headers,
    body,
  };

  const started = Date.now();
  try {
    const result = await handler(event, {});
    const elapsed = Date.now() - started;
    console.log(`[fn] ${req.method} ${url.pathname}${url.search}  ${result.statusCode}  ${elapsed}ms`);
    res.statusCode = result.statusCode || 200;
    if (result.headers) {
      for (const [k, v] of Object.entries(result.headers)) res.setHeader(k, v);
    }
    res.end(result.body || '');
  } catch (err) {
    console.error('[fn] error', err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\nPort ${FUNCTIONS_PORT} is already in use. Kill the process using it and try again:\n  lsof -nP -iTCP:${FUNCTIONS_PORT} -sTCP:LISTEN\n`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(FUNCTIONS_PORT, () => {
  console.log(`\n  functions  →  http://localhost:${FUNCTIONS_PORT}/.netlify/functions/search`);
  console.log(`  vite       →  http://localhost:${VITE_PORT}  (starting)`);
  console.log(`\nOpen the Vite URL in your browser. Ctrl-C to stop both.\n`);

  // Spawn Vite dev server — uses project's local vite install, no global needed.
  const vite = spawn(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['vite'],
    { stdio: 'inherit', cwd: ROOT, shell: false }
  );

  const shutdown = () => {
    console.log('\nShutting down…');
    server.close();
    try { vite.kill(); } catch (_) {}
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  vite.on('exit', shutdown);
});
