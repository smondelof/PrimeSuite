// Punto de entrada común: lo usan la función de Netlify y el servidor local.
import { Router, json, body, HttpError, assertSameOrigin } from './http.ts';
import { storeMode } from './store.ts';
import { authRoutes } from './routes/auth.ts';
import { oidcRoutes } from './routes/oidc.ts';
import { portalRoutes } from './routes/portal.ts';
import { adminRoutes } from './routes/admin.ts';
import { insightsRoutes } from './routes/insights.ts';
import { evalosRoutes } from './routes/evalos.ts';
import { teletrabajoRoutes } from './routes/teletrabajo.ts';

const router = new Router();
router.get('/api/health', async () => {
  const out: Record<string, unknown> = { ok: true, service: 'prime-suite', version: process.env.PRIME_VERSION || 'desarrollo', store: storeMode() };
  if (storeMode() === 'sqlserver') out.db = (await import('./sqlserver.ts')).dbStatus().status;
  return json(out);
});

// Conexión a SQL Server (instalaciones autoalojadas): estado, reintento y alta desde la web.
router.get('/api/db/status', async () => {
  if (storeMode() !== 'sqlserver') return json({ store: storeMode(), status: 'lista', ready: true });
  const db = await import('./sqlserver.ts');
  await db.initDb();
  return json(db.dbStatus());
});
router.post('/api/db/retry', async () => {
  if (storeMode() !== 'sqlserver') throw new HttpError(404, 'No se usa SQL Server');
  return json(await (await import('./sqlserver.ts')).retryDb());
});
router.post('/api/db/config', async (req) => {
  if (storeMode() !== 'sqlserver') throw new HttpError(404, 'No se usa SQL Server');
  const b = await body<Record<string, unknown>>(req).catch(() => null);
  if (!b || typeof b !== 'object') throw new HttpError(400, 'Datos no válidos');
  return json(await (await import('./sqlserver.ts')).configureDb(b as any));
});

// Diagnóstico temporal del almacenamiento (Netlify Blobs). Quitar cuando esté resuelto.
router.get('/api/_diag', async () => {
  const env = {
    hasBlobsContext: !!process.env.NETLIFY_BLOBS_CONTEXT,
    NETLIFY_SITE_ID: !!process.env.NETLIFY_SITE_ID,
    SITE_ID: !!process.env.SITE_ID,
    NETLIFY_BLOBS_TOKEN: !!process.env.NETLIFY_BLOBS_TOKEN,
    NETLIFY_API_TOKEN: !!process.env.NETLIFY_API_TOKEN,
    usingExplicitToken: !!((process.env.NETLIFY_SITE_ID || process.env.SITE_ID) && (process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN)),
    netlify: !!process.env.NETLIFY,
    store: process.env.PRIME_STORE || '(blobs)'
  };
  const { store } = await import('./store.ts');
  const steps: Record<string, string> = {};
  const probe = `_diag/${Date.now()}`;
  const run = async (name: string, fn: () => Promise<unknown>) => {
    try {
      await fn();
      steps[name] = 'ok';
    } catch (e: any) {
      steps[name] = `${e?.name}: ${e?.message}`;
    }
  };
  await run('construct', async () => store());
  await run('set', () => store().set(probe, { ok: true }));
  await run('get', () => store().get(probe));
  await run('list', () => store().keys('_diag/'));
  await run('del', () => store().del(probe));
  // Prueba de sesión: firmar y verificar (sin cookie), para aislar cripto de transporte.
  const { createSession, readSession } = await import('./crypto.ts');
  await run('session', async () => {
    const { token } = await createSession('x', { id: 'diag-user', sessionVersion: 1 });
    const s = await readSession('x', token);
    if (!s || s.userId !== 'diag-user') throw new Error('la sesión no se validó tras firmarla');
  });
  return json({ env, steps });
});
authRoutes(router);
oidcRoutes(router);
portalRoutes(router);
adminRoutes(router);
insightsRoutes(router);
evalosRoutes(router);
teletrabajoRoutes(router);

// Endpoints llamados desde otras aplicaciones (sin comprobación de Origin).
const CROSS_ORIGIN = ['/api/sso/redeem', '/oidc/token', '/oidc/userinfo'];

export async function handle(req: Request): Promise<Response> {
  try {
    const path = new URL(req.url).pathname;
    if (path.startsWith('/api/') && !CROSS_ORIGIN.includes(path)) assertSameOrigin(req);
    // Sin conexión a SQL Server solo responden la salud y la configuración de la base de datos.
    if (storeMode() === 'sqlserver' && path !== '/api/health' && !path.startsWith('/api/db/')) await (await import('./sqlserver.ts')).getPool();
    const res = await router.handle(req);
    return res || json({ error: 'No encontrado' }, 404);
  } catch (e: any) {
    if (e instanceof HttpError) return json({ error: e.message, code: e.code }, e.status);
    console.error('[prime-suite]', e);
    return json({ error: 'Error interno' }, 500);
  }
}
