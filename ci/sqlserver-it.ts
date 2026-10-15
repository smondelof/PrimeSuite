// Prueba de integración contra un SQL Server real (solo para la rama de comprobación).
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../prime-suite');

const PASS = process.env.MSSQL_SA_PASSWORD!;
const dir = mkdtempSync(path.join(tmpdir(), 'ps-it-'));
const litePath = path.join(dir, 'prime-suite.db');
Object.assign(process.env, { PRIME_STORE: 'sqlite', PRIME_SQLITE_PATH: litePath, PRIME_DATA_DIR: dir, PRIME_SECRET_KEY: 'clave-de-prueba-ci' });

// 1. SQLite «antiguo» con datos variados
const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite');
const lite = new DatabaseSync(litePath);
lite.exec('CREATE TABLE kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)');
const rows: Record<string, unknown> = {
  settings: { sessionHours: 9, mfaAdmins: true },
  'users/u1': { id: 'u1', email: 'ana@ejemplo.es', firstName: 'Ána', lastName: 'Núñez 😀' },
  'companies/c1': { id: 'c1', name: 'Primion', code: 'pri5' },
  'audit/2026-10-15T10:00:00.000Z_a': { id: 'a', action: 'x' },
  'audit/2026-10-15T11:00:00.000Z_b': { id: 'b', action: 'y' },
  'jti/AbC': { exp: 1 },
  'jti/abc': { exp: 2 },
  'a_b/1': { v: 1 },
  'axb/1': { v: 2 },
  ['codes/' + 'z'.repeat(500)]: { long: true }
};
for (const [k, v] of Object.entries(rows)) lite.prepare('INSERT INTO kv (k, v) VALUES (?, ?)').run(k, JSON.stringify(v));
lite.close();

const db = await import('../prime-suite/server/sqlserver.ts');
const { store } = await import('../prime-suite/server/store.ts');

// 2. Sin fichero: modo configuración, código en /data
await db.initDb({ server: true });
assert.equal(db.dbStatus().status, 'sin-configurar');
const code = readFileSync(path.join(dir, 'codigo-configuracion.txt'), 'utf8').trim();
console.log('código', code);

// 3. Código incorrecto, credenciales incorrectas
await assert.rejects(db.configureDb({ code: 'AAAAA-BBBBB', server: 'localhost', database: 'X', user: 'sa', password: PASS }), /código/);
await assert.rejects(db.configureDb({ code, server: 'localhost', database: 'PrimeSuiteCI', user: 'sa', password: 'mala' }), /Usuario o contraseña/);
console.log('errores de credenciales OK:', db.dbStatus().error);

// 4. Alta correcta: crea la BD, las tablas y migra
let r: any;
for (let i = 0; ; i++) {
  try { r = await db.configureDb({ code, server: 'localhost', port: 1433, database: 'PrimeSuiteCI', user: 'sa', password: PASS, encrypt: true, trustServerCertificate: true }); break; }
  catch (e: any) { if (i > 20 || /código|contraseña/.test(e.message)) throw e; console.log('esperando a SQL Server…', e.message); await new Promise((s) => setTimeout(s, 3000)); }
}
console.log('configureDb →', JSON.stringify(r));
assert.equal(r.ok, true);
assert.equal(r.createdDatabase, true);
assert.deepEqual(r.migrated, { total: Object.keys(rows).length, inserted: Object.keys(rows).length });
assert.ok(existsSync(path.join(dir, 'sqlserver.json')));
assert.ok(existsSync(litePath + '.migrado-a-sqlserver'));
assert.ok(!readFileSync(path.join(dir, 'sqlserver.json'), 'utf8').includes(PASS), 'la contraseña no debe estar en claro');

// 5. KV
const kv = store();
assert.deepEqual(await kv.get('settings'), rows.settings);
assert.deepEqual(await kv.get('users/u1'), rows['users/u1']);
assert.deepEqual(await kv.get('codes/' + 'z'.repeat(500)), { long: true });
assert.deepEqual(await kv.keys('jti/'), ['jti/AbC', 'jti/abc']);
assert.deepEqual(await kv.keys('a_b/'), ['a_b/1']);
assert.deepEqual(await kv.keys('audit/'), ['audit/2026-10-15T10:00:00.000Z_a', 'audit/2026-10-15T11:00:00.000Z_b']);
assert.equal((await kv.keys('')).length, Object.keys(rows).length);
assert.equal(await kv.set('jti/abc', { x: 1 }, { onlyIfNew: true }), false);
assert.equal(await kv.set('jti/nuevo', { x: 1 }, { onlyIfNew: true }), true);
await kv.set('settings', { sessionHours: 4 });
assert.deepEqual(await kv.get('settings'), { sessionHours: 4 });
await kv.del('jti/nuevo');
assert.equal(await kv.get('jti/nuevo'), null);
assert.equal(await kv.get('no-existe'), null);
// Escrituras concurrentes sobre la misma clave
await Promise.all(Array.from({ length: 20 }, (_, i) => kv.set('conc/x', { i })));
assert.ok((await kv.get<{ i: number }>('conc/x'))!.i >= 0);
const races = await Promise.all(Array.from({ length: 10 }, () => kv.set('once/y', 1, { onlyIfNew: true })));
assert.equal(races.filter(Boolean).length, 1);
console.log('KV OK');

// 6. Columnas creadas
const pool = await db.getPool();
const cols = (await pool.request().query("SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME LIKE 'PrimeSuite%' ORDER BY TABLE_NAME, ORDINAL_POSITION")).recordset;
console.log('columnas', JSON.stringify(cols));
for (const c of ['Clave', 'Valor', 'Ambito', 'Creado', 'Actualizado']) assert.ok(cols.some((x: any) => x.TABLE_NAME === 'PrimeSuite_Datos' && x.COLUMN_NAME === c), c);
const amb = (await pool.request().query("SELECT Ambito, COUNT(*) n FROM dbo.PrimeSuite_Datos GROUP BY Ambito ORDER BY Ambito")).recordset;
console.log('ámbitos', JSON.stringify(amb));
await db.closeDb();

// 7. Servidor real: arranca con el fichero, conecta solo y no vuelve a migrar
async function runServer(port: number, env: Record<string, string>) {
  const p = spawn(process.execPath, ['--import', 'tsx', 'server/prod.ts'], { cwd: APP, env: { ...process.env, ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  p.stdout.on('data', (d) => (out += d));
  p.stderr.on('data', (d) => (out += d));
  for (let i = 0; i < 60; i++) {
    try { const h = await (await fetch(`http://127.0.0.1:${port}/api/health`)).json(); if (h.db === 'lista' || h.db === 'sin-configurar' || h.db === 'error') return { p, h, log: () => out }; } catch {}
    await new Promise((s) => setTimeout(s, 1000));
  }
  p.kill(); throw new Error('el servidor no arrancó:\n' + out);
}
const s1 = await runServer(18555, {});
console.log('health servidor con fichero', JSON.stringify(s1.h));
assert.equal(s1.h.db, 'lista');
const ss = await fetch('http://127.0.0.1:18555/api/setup/status');
console.log('/api/setup/status con datos migrados', ss.status, await ss.text());
assert.equal(ss.status, 200);
s1.p.kill('SIGTERM');

// 8. Servidor sin fichero: la API responde 503 DB_SETUP salvo salud y /api/db
const dir2 = mkdtempSync(path.join(tmpdir(), 'ps-it2-'));
const s2 = await runServer(18556, { PRIME_DATA_DIR: dir2, PRIME_SQLITE_PATH: path.join(dir2, 'prime-suite.db') });
assert.equal(s2.h.db, 'sin-configurar');
const me = await fetch('http://127.0.0.1:18556/api/me');
const meBody = await me.json();
console.log('/api/me sin BD', me.status, JSON.stringify(meBody));
assert.equal(me.status, 503);
assert.equal(meBody.code, 'DB_SETUP');
const oidc = await fetch('http://127.0.0.1:18556/.well-known/openid-configuration');
console.log('/.well-known sin BD', oidc.status);
const st = await (await fetch('http://127.0.0.1:18556/api/db/status')).json();
console.log('/api/db/status', JSON.stringify(st));
assert.equal(st.status, 'sin-configurar');
assert.ok(/Código de configuración/.test(s2.log()), 'el código se anuncia en el log');
const code2 = readFileSync(path.join(dir2, 'codigo-configuracion.txt'), 'utf8').trim();
const bad = await fetch('http://127.0.0.1:18556/api/db/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'XXXXX-XXXXX', server: 'localhost', database: 'PrimeSuiteCI2', user: 'sa', password: PASS }) });
assert.equal(bad.status, 403);
const good = await fetch('http://127.0.0.1:18556/api/db/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: code2, server: 'localhost', port: '1433', database: 'PrimeSuiteCI2', user: 'sa', password: PASS, encrypt: true, trustServerCertificate: true }) });
console.log('/api/db/config', good.status, await good.text());
assert.equal(good.status, 200);
const me2 = await fetch('http://127.0.0.1:18556/api/setup/status');
console.log('/api/setup/status tras configurar', me2.status, await me2.text());
assert.equal(me2.status, 200);
s2.p.kill('SIGTERM');

// 9. Backup por línea de comandos (debe terminar solo)
const t0 = Date.now();
await new Promise<void>((res, rej) => {
  const b = spawn(process.execPath, ['--import', 'tsx', 'server/tools/backup.ts', path.join(dir, 'b.json')], { cwd: APP, env: process.env, stdio: 'inherit' });
  const t = setTimeout(() => { b.kill(); rej(new Error('backup no termina')); }, 60_000);
  b.on('exit', (c) => { clearTimeout(t); c === 0 ? res() : rej(new Error('backup exit ' + c)); });
});
const backup = JSON.parse(readFileSync(path.join(dir, 'b.json'), 'utf8'));
console.log('backup', backup.count, 'registros en', Date.now() - t0, 'ms');
assert.ok(backup.count >= Object.keys(rows).length);

console.log('\nINTEGRACIÓN SQL SERVER: TODO OK');
process.exit(0);
