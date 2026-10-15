// Servidor de producción autoalojado: sirve la API y el frontend compilado (dist/) en un solo
// proceso Node. Pensado para ir detrás de un proxy/balanceador que termina el TLS (o un proxy
// propio que sirve HTTPS con vuestro certificado). Lee la configuración de variables de entorno.
process.env.PRIME_STORE ??= 'sqlserver';              // motor de almacenamiento (SQL Server; 'sqlite' también significa SQL Server)
process.env.PRIME_SQLITE_PATH ??= '/data/prime-suite.db'; // SQLite anterior: solo se lee para migrar sus datos
process.env.PRIME_ALLOW_PRIVATE_FETCH ??= '1';        // herramienta interna: permite llegar a Superset/servicios en red privada

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { handle } from './app.ts';
import { handleDemo } from './demo.ts';
import { handleTwon, isTwonPath } from './proxy2n.ts';
import { storeMode } from './store.ts';

const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const DIST = path.resolve(process.env.DIST_DIR || 'dist');

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8'
};

async function serveStatic(p: string): Promise<Response> {
  let file = path.join(DIST, decodeURIComponent(p));
  if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 });
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    await stat(file);
  } catch {
    file = path.join(DIST, 'index.html'); // SPA: cualquier ruta desconocida sirve index.html
  }
  const ext = path.extname(file);
  // Los assets con hash se pueden cachear agresivamente; el index.html no.
  const cache = p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache';
  return new Response(await readFile(file), { headers: { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': cache } });
}

const server = createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const url = `http://${req.headers.host || 'localhost'}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) });
    const p = new URL(url).pathname;
    const isApi = p.startsWith('/api/') || p.startsWith('/oidc/') || p.startsWith('/.well-known/');

    let response: Response;
    if (p.startsWith('/demo-api/')) response = await handleDemo(request);
    else if (isTwonPath(p)) response = await handleTwon(request); // 2N Access Commander bajo el mismo origen
    else if (isApi) response = await handle(request);
    else response = await serveStatic(p);

    const out: Record<string, string | string[]> = {};
    response.headers.forEach((v, k) => (out[k] = v));
    const setCookie = (response.headers as any).getSetCookie?.();
    if (setCookie?.length) out['set-cookie'] = setCookie;
    res.writeHead(response.status, out);
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    console.error('[prime-suite] error no controlado:', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'Error interno' }));
  }
});

server.listen(port, host, () => {
  console.log(`Prime Suite escuchando en http://${host}:${port} · almacenamiento=${storeMode()}`);
  // Conecta a SQL Server al arrancar; si no hay fichero de conexión o falla, la web pedirá los datos.
  if (storeMode() === 'sqlserver') import('./sqlserver.ts').then((db) => db.initDb({ server: true })).catch((e) => console.error('[prime-suite] SQL Server:', e));
});

// Apagado limpio (Docker envía SIGTERM).
for (const sig of ['SIGTERM', 'SIGINT'] as const) process.on(sig, () => server.close(async () => {
  if (storeMode() === 'sqlserver') await (await import('./sqlserver.ts')).closeDb();
  process.exit(0);
}));
