import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'ps-sqlserver-'));
process.env.PRIME_DATA_DIR = dir;
delete process.env.PRIME_SECRET_KEY;
process.env.PRIME_STORE = 'sqlite'; // instalaciones antiguas: ahora significa SQL Server

const db = await import('./sqlserver.ts');
const { storeMode } = await import('./store.ts');

test('PRIME_STORE=sqlite pasa a usar SQL Server', () => {
  assert.equal(storeMode(), 'sqlserver');
  process.env.PRIME_STORE = 'file';
  assert.equal(storeMode(), 'file');
  process.env.PRIME_STORE = 'sqlserver';
  assert.equal(storeMode(), 'sqlserver');
});

test('claves: se respetan las cortas y las largas se resumen de forma estable', () => {
  assert.equal(db.dbKey('users/abc'), 'users/abc');
  const long = 'jti/' + 'x'.repeat(600);
  const k = db.dbKey(long);
  assert.ok(k.length <= db.KEY_MAX);
  assert.ok(k.startsWith('jti/#'));
  assert.equal(db.dbKey(long), k);
  assert.equal(db.dbKey(k), k);
});

test('prefijos LIKE: se escapan los comodines de SQL Server', () => {
  assert.equal(db.likePrefix(''), '%');
  assert.equal(db.likePrefix('audit/'), 'audit/%');
  assert.equal(db.likePrefix('a_b%c[d\\'), 'a\\_b\\%c\\[d\\\\%');
});

test('la contraseña se cifra y descifra (clave local si no hay PRIME_SECRET_KEY)', () => {
  const blob = db.encryptLocal('S3cr3t!ñ');
  assert.notEqual(blob, 'S3cr3t!ñ');
  assert.equal(db.decryptLocal(blob), 'S3cr3t!ñ');
  const tampered = blob.slice(0, -2) + (blob.endsWith('A') ? 'B' : 'A') + '=';
  assert.throws(() => db.decryptLocal(tampered));
});

test('validación del formulario', () => {
  const ok = db.normalizeInput({ server: ' sql01\\EVALOS ', database: 'PrimeSuite', user: 'ps', password: 'x', port: '' });
  assert.equal(ok.server, 'sql01\\EVALOS');
  assert.equal(ok.port, undefined);
  assert.equal(ok.encrypt, true);
  assert.equal(ok.trustServerCertificate, true);
  assert.throws(() => db.normalizeInput({ server: '', database: 'd', user: 'u', password: 'p' }), /servidor/);
  assert.throws(() => db.normalizeInput({ server: 'host;drop', database: 'd', user: 'u', password: 'p' }), /servidor/);
  assert.throws(() => db.normalizeInput({ server: 'h', database: 'a]b', user: 'u', password: 'p' }), /base de datos/);
  assert.throws(() => db.normalizeInput({ server: 'h', port: '70000', database: 'd', user: 'u', password: 'p' }), /puerto/);
  assert.throws(() => db.normalizeInput({ server: 'h', database: 'd', user: 'u' }), /contraseña/);
  // Sin contraseña nueva se reutiliza la guardada si es el mismo servidor y usuario.
  const prev = { server: 'h', database: 'd', user: 'u', passwordEnc: db.encryptLocal('guardada'), encrypt: true, trustServerCertificate: true, updatedAt: '' };
  assert.equal(db.normalizeInput({ server: 'h', database: 'otra', user: 'u' }, prev).password, 'guardada');
  assert.throws(() => db.normalizeInput({ server: 'h', database: 'd', user: 'otro' }, prev), /contraseña/);
});

test('código de configuración: formato, comprobación y bloqueo', () => {
  const code = db.newSetupCode();
  assert.match(code, /^[A-Z2-9]{5}-[A-Z2-9]{5}$/);
  assert.doesNotThrow(() => db.checkCode(code.toLowerCase(), code));
  assert.throws(() => db.checkCode('', code), /código/);
  assert.throws(() => db.checkCode('ABCDE-FGHJK', null), /código/);
});

test('sin fichero de conexión queda en modo configuración y responde 503 DB_SETUP', async () => {
  await db.initDb();
  const st = db.dbStatus();
  assert.equal(st.status, 'sin-configurar');
  assert.equal(st.ready, false);
  await assert.rejects(db.getPool(), (e: any) => e.status === 503 && e.code === 'DB_SETUP');
});

test('fichero de conexión inválido: también modo configuración', async () => {
  writeFileSync(path.join(dir, 'sqlserver.json'), '{ no es json');
  assert.equal(db.readConfig(), null);
});

test('el esquema es idempotente y usa intercalación binaria en la clave', () => {
  const all = db.SCHEMA_SQL.join('\n');
  assert.match(all, /Latin1_General_100_BIN2/);
  for (const stmt of db.SCHEMA_SQL) assert.match(stmt.trim(), /^IF /);
});
