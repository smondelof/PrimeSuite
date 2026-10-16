// Atajos de Evalos · Teletrabajo › widget del Inicio: además de los totales, quién está cada día.
// Ejecutar con:  npm test   (node --import tsx --test server/*.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRIME_STORE = 'file';
process.env.PRIME_DATA_DIR = mkdtempSync(join(tmpdir(), 'ps-twhoy-'));
process.env.PRIME_ISSUER = 'https://primesuite.test';
const ISS = 'https://primesuite.test';

const { handle } = await import('./app.ts');
const db = await import('./db.ts');
const { createSession } = await import('./crypto.ts');

const companyId = db.id();
const userId = db.id();
await db.Companies.put({ id: companyId, name: 'Digitek', code: 'pri5', enabledModules: [], moduleUrls: {}, createdAt: db.now() });
await db.Users.put({ id: userId, companyId, email: 'super@digitek.es', firstName: 'Super', lastName: '', passwordHash: 'x', role: 'superadmin', groupIds: [], status: 'active', sessionVersion: 1, createdAt: db.now() });
const COOKIE = `ps_session=${encodeURIComponent((await createSession('', { id: userId, sessionVersion: 1 })).token)}`;
const call = async (method: string, path: string, body?: unknown) => {
  const res = await handle(new Request(`${ISS}${path}`, { method, headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

test('el resumen del widget dice quién está en oficina, teletrabajo o ausente cada día', async () => {
  const cfg = await call('PUT', '/api/evalos/config', { companyId, engine: 'demo' });
  assert.equal(cfg.status, 200, JSON.stringify(cfg.body));
  const r = await call('GET', '/api/evalos/teletrabajo/hoy');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const b = r.body;
  assert.ok(Array.isArray(b.days) && b.days.length > 0 && b.days.length <= 5, 'hasta 5 días laborables');
  assert.ok(Array.isArray(b.people) && b.people.length > 0, 'lista de personas con nombre');
  const known = new Set(b.people.map((p: any) => p.code));
  for (const d of b.days) {
    const who = Object.entries(d.who as Record<string, string>);
    // Los totales cuadran con la lista de personas de ese día
    assert.equal(who.filter(([, k]) => k === 'T').length, d.remote, d.date);
    assert.equal(who.filter(([, k]) => k === 'O' || k === 'H').length, d.office, d.date);
    assert.equal(who.filter(([, k]) => k === 'A').length, d.absent, d.date);
    for (const [code] of who) assert.ok(known.has(code), `${code} tiene nombre`);
  }
  // Compatibilidad con el widget anterior
  assert.deepEqual(b.next.map((n: any) => n.date), b.days.map((d: any) => d.date));
  for (const a of b.topAlerts) if (a.employee) assert.ok(a.name);
});
