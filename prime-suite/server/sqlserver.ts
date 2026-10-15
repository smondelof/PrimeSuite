// Almacenamiento de Prime Suite en SQL Server (instalaciones autoalojadas).
//
// · Los datos de conexión se guardan en un fichero local (por defecto /data/sqlserver.json) con la
//   contraseña cifrada. Si no existe, o la conexión falla, la app arranca en «modo configuración»:
//   solo responde /api/health y /api/db/*, y la web muestra el formulario de conexión.
// · Al conectar, la propia app crea la base de datos (si no existe), las tablas y las columnas que falten.
// · La primera vez migra todo lo que había en el fichero SQLite anterior (sin sobrescribir nada).
// · Para cambiar la conexión desde la web hace falta el código de configuración que se escribe en el
//   log del contenedor y en /data/codigo-configuracion.txt (así nadie de fuera puede apuntar la app a otro servidor).
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { HttpError } from './http.ts';

// ---------- Tablas ----------
export const DATA_TABLE = 'dbo.PrimeSuite_Datos';
export const INFO_TABLE = 'dbo.PrimeSuite_Info';
export const SCHEMA_VERSION = 1;
export const KEY_MAX = 450; // NVARCHAR(450): límite de una clave primaria agrupada (900 bytes)

/** Sentencias idempotentes: crean lo que falte (tablas, columnas, índices) sin tocar lo que ya existe. */
export const SCHEMA_SQL: string[] = [
  `IF OBJECT_ID(N'${DATA_TABLE}', N'U') IS NULL
     CREATE TABLE ${DATA_TABLE} (
       Clave NVARCHAR(${KEY_MAX}) COLLATE Latin1_General_100_BIN2 NOT NULL CONSTRAINT PK_PrimeSuite_Datos PRIMARY KEY CLUSTERED,
       Valor NVARCHAR(MAX) NOT NULL
     )`,
  `IF COL_LENGTH(N'${DATA_TABLE}', N'Ambito') IS NULL
     ALTER TABLE ${DATA_TABLE} ADD Ambito AS (CASE WHEN CHARINDEX(N'/', Clave) > 0 THEN LEFT(Clave, CHARINDEX(N'/', Clave) - 1) ELSE Clave END) PERSISTED`,
  `IF COL_LENGTH(N'${DATA_TABLE}', N'Creado') IS NULL
     ALTER TABLE ${DATA_TABLE} ADD Creado DATETIME2(3) NOT NULL CONSTRAINT DF_PrimeSuite_Datos_Creado DEFAULT SYSUTCDATETIME()`,
  `IF COL_LENGTH(N'${DATA_TABLE}', N'Actualizado') IS NULL
     ALTER TABLE ${DATA_TABLE} ADD Actualizado DATETIME2(3) NOT NULL CONSTRAINT DF_PrimeSuite_Datos_Actualizado DEFAULT SYSUTCDATETIME()`,
  `IF NOT EXISTS (SELECT 1 FROM sys.indexes WHERE name = N'IX_PrimeSuite_Datos_Ambito' AND object_id = OBJECT_ID(N'${DATA_TABLE}'))
     CREATE INDEX IX_PrimeSuite_Datos_Ambito ON ${DATA_TABLE} (Ambito)`,
  `IF OBJECT_ID(N'${INFO_TABLE}', N'U') IS NULL
     CREATE TABLE ${INFO_TABLE} (
       Clave NVARCHAR(100) NOT NULL CONSTRAINT PK_PrimeSuite_Info PRIMARY KEY,
       Valor NVARCHAR(MAX) NULL
     )`,
  `IF COL_LENGTH(N'${INFO_TABLE}', N'Actualizado') IS NULL
     ALTER TABLE ${INFO_TABLE} ADD Actualizado DATETIME2(3) NOT NULL CONSTRAINT DF_PrimeSuite_Info_Actualizado DEFAULT SYSUTCDATETIME()`
];

// ---------- Claves ----------
/** Las claves de más de 450 caracteres (rarísimas: p. ej. un jti externo) se guardan con un hash estable. */
export function dbKey(key: string) {
  if (key.length <= KEY_MAX) return key;
  const cut = key.lastIndexOf('/', 300);
  const prefix = cut > 0 ? key.slice(0, cut + 1) : '';
  return `${prefix}#${createHash('sha256').update(key).digest('hex')}`;
}
/** Patrón LIKE de «empieza por» (ESCAPE '\'): se escapan los comodines de SQL Server. */
export function likePrefix(prefix: string) {
  return prefix.replace(/[\\%_[]/g, '\\$&') + '%';
}

// ---------- Fichero de configuración ----------
export interface DbConfig {
  server: string;          // nombre o IP; admite «servidor\INSTANCIA»
  port?: number;           // por defecto 1433 (se ignora con instancia con nombre)
  database: string;
  user: string;
  passwordEnc: string;     // AES-256-GCM
  encrypt: boolean;
  trustServerCertificate: boolean;
  updatedAt: string;
}
export interface DbInput {
  server: string;
  port?: number | string;
  database: string;
  user: string;
  password?: string;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export function dataDir() {
  if (process.env.PRIME_DATA_DIR) return path.resolve(process.env.PRIME_DATA_DIR);
  if (process.env.PRIME_SQLITE_PATH) return path.dirname(path.resolve(process.env.PRIME_SQLITE_PATH));
  return existsSync('/data') ? '/data' : path.resolve('.data');
}
export const configPath = () => process.env.PRIME_DB_CONFIG || path.join(dataDir(), 'sqlserver.json');
export const sqlitePath = () => process.env.PRIME_SQLITE_PATH || path.join(dataDir(), 'prime-suite.db');
const codePath = () => path.join(dataDir(), 'codigo-configuracion.txt');

/** Clave para cifrar la contraseña del fichero: PRIME_SECRET_KEY o, si no hay, una clave local en el volumen de datos. */
function fileKey(): Buffer {
  if (process.env.PRIME_SECRET_KEY) return createHash('sha256').update('prime-suite/sqlserver:' + process.env.PRIME_SECRET_KEY).digest();
  const f = path.join(dataDir(), '.clave-configuracion');
  if (!existsSync(f)) writePrivate(f, randomBytes(32).toString('base64'));
  return Buffer.from(readFileSync(f, 'utf8').trim(), 'base64');
}
export function encryptLocal(plain: string, key = fileKey()) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), enc.toString('base64')].join(':');
}
export function decryptLocal(blob: string, key = fileKey()) {
  const [v, iv, tag, enc] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || enc === undefined) throw new Error('Formato de contraseña cifrada no válido');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(enc, 'base64')), d.final()]).toString('utf8');
}

function writePrivate(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, content, { mode: 0o600 });
  renameSync(tmp, file);
  try { chmodSync(file, 0o600); } catch {}
}

export function readConfig(): DbConfig | null {
  try {
    const c = JSON.parse(readFileSync(configPath(), 'utf8')) as DbConfig;
    return c && c.server && c.database && c.user ? c : null;
  } catch {
    return null;
  }
}
function writeConfig(c: DbConfig) {
  writePrivate(configPath(), JSON.stringify(c, null, 2) + '\n');
}

/** Valida y normaliza lo que llega del formulario. */
export function normalizeInput(b: DbInput, previous?: DbConfig | null) {
  const s = (v: unknown, max = 256) => String(v ?? '').trim().slice(0, max);
  const server = s(b.server);
  const database = s(b.database, 128);
  const user = s(b.user, 128);
  const portRaw = s(b.port, 5);
  const port = portRaw ? Number(portRaw) : undefined;
  if (!server) throw new HttpError(400, 'Indica el servidor de SQL Server.');
  if (!/^[A-Za-z0-9.\-_]+(\\[A-Za-z0-9_$\-]+)?$/.test(server)) throw new HttpError(400, 'El servidor solo admite nombre o IP, opcionalmente con \\INSTANCIA.');
  if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) throw new HttpError(400, 'El puerto no es válido.');
  if (!database) throw new HttpError(400, 'Indica la base de datos.');
  if (/[\[\]\x00-\x1f]/.test(database)) throw new HttpError(400, 'El nombre de la base de datos no es válido.');
  if (['master', 'model', 'msdb', 'tempdb'].includes(database.toLowerCase())) throw new HttpError(400, 'No uses una base de datos del sistema: indica una propia para Prime Suite (p. ej. PrimeSuite_Dev).');
  if (!user) throw new HttpError(400, 'Indica el usuario de SQL Server.');
  let password = typeof b.password === 'string' ? b.password : '';
  // Contraseña vacía = mantener la guardada (si es el mismo servidor y usuario).
  if (!password && previous && previous.server === server && previous.user === user) password = decryptLocal(previous.passwordEnc);
  if (!password) throw new HttpError(400, 'Indica la contraseña de SQL Server.');
  return {
    server, port, database, user, password,
    encrypt: b.encrypt === undefined ? true : !!b.encrypt,
    trustServerCertificate: b.trustServerCertificate === undefined ? true : !!b.trustServerCertificate
  };
}
type Conn = ReturnType<typeof normalizeInput>;

// ---------- Conexión ----------
type Sql = typeof import('mssql');
let sqlMod: Sql | null = null;
async function mssql(): Promise<Sql> {
  if (!sqlMod) {
    const m: any = await import('mssql');
    sqlMod = (m.default || m) as Sql;
  }
  return sqlMod;
}

function poolConfig(c: Conn, database = c.database): import('mssql').config {
  const [host, instanceName] = c.server.split('\\');
  return {
    server: host,
    ...(instanceName ? {} : { port: c.port || 1433 }),
    database,
    user: c.user,
    password: c.password,
    connectionTimeout: 15_000,
    requestTimeout: 60_000,
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    options: { encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate, instanceName: instanceName || undefined, enableArithAbort: true, appName: 'Prime Suite' }
  };
}

const errNumber = (e: any): number | undefined => e?.number ?? e?.originalError?.number ?? e?.originalError?.info?.number ?? e?.precedingErrors?.[0]?.number;
const isMissingDatabase = (e: any) => errNumber(e) === 4060 || /Cannot open database/i.test(String(e?.message));
const CONN_CODES = ['ESOCKET', 'ETIMEOUT', 'ECONNCLOSED', 'ELOGIN', 'ENOTOPEN', 'ENOCONN', 'EINSTLOOKUP', 'ECONNRESET'];
export const isConnectionError = (e: any) =>
  e?.name === 'ConnectionError' || CONN_CODES.includes(e?.code) || CONN_CODES.includes(e?.originalError?.code);

/** Mensaje claro en español para los errores de conexión más habituales. */
export function explain(e: any): string {
  const msg = String(e?.message || e || 'Error desconocido');
  const n = errNumber(e);
  if (n === 18456 || /Login failed/i.test(msg)) return 'Usuario o contraseña de SQL Server incorrectos.';
  if (n === 262 || /CREATE DATABASE permission denied/i.test(msg)) return 'La base de datos no existe y el usuario no tiene permiso para crearla. Créala o usa un usuario con permiso CREATE DATABASE.';
  if (/getaddrinfo|ENOTFOUND|EAI_AGAIN/i.test(msg)) return `No se encuentra el servidor (${msg}). Revisa el nombre o la IP.`;
  if (/ECONNREFUSED/i.test(msg)) return `El servidor rechaza la conexión (${msg}). Revisa el puerto y que SQL Server acepte conexiones TCP.`;
  if (/timeout|ETIMEOUT|Failed to connect/i.test(msg)) return `No responde el servidor (${msg}). Revisa nombre, puerto, cortafuegos y que el servicio esté arrancado.`;
  if (/certificate|self[- ]signed|SSL|TLS/i.test(msg)) return `Error de cifrado/certificado (${msg}). Prueba a marcar «Confiar en el certificado del servidor».`;
  return msg;
}

async function openPool(c: Conn): Promise<{ pool: import('mssql').ConnectionPool; createdDatabase: boolean }> {
  const sql = await mssql();
  try {
    const pool = await new sql.ConnectionPool(poolConfig(c)).connect();
    return { pool, createdDatabase: false };
  } catch (e: any) {
    // Si la base de datos no existe, SQL Server suele responder solo «Login failed» (como con una
    // contraseña mala). Para distinguirlo se prueba el mismo usuario contra master.
    const loginProblem = isMissingDatabase(e) || e?.code === 'ELOGIN' || errNumber(e) === 18456 || /Login failed/i.test(String(e?.message));
    if (!loginProblem || c.database.toLowerCase() === 'master') throw e;
  }
  // Si tampoco entra en master, el error (usuario/contraseña incorrectos…) sale tal cual.
  const master = await new sql.ConnectionPool(poolConfig(c, 'master')).connect();
  // Credenciales correctas: el problema es la base de datos. Si no existe, se crea.
  try {
    const exists = await master.request().input('n', sql.NVarChar(128), c.database).query('SELECT DB_ID(@n) AS id');
    if (exists.recordset[0]?.id != null) throw new Error(`No se puede abrir la base de datos "${c.database}" con el usuario "${c.user}". Dale acceso (p. ej. db_owner) a ese usuario.`);
    await master.request().input('n', sql.NVarChar(128), c.database).query("DECLARE @s NVARCHAR(400) = N'CREATE DATABASE ' + QUOTENAME(@n); EXEC (@s);");
  } finally {
    await master.close().catch(() => {});
  }
  const pool = await new sql.ConnectionPool(poolConfig(c)).connect();
  return { pool, createdDatabase: true };
}

async function ensureSchema(pool: import('mssql').ConnectionPool) {
  for (const stmt of SCHEMA_SQL) await pool.request().batch(stmt);
  const sql = await mssql();
  await pool.request()
    .input('k', sql.NVarChar(100), 'version-esquema')
    .input('v', sql.NVarChar(sql.MAX), String(SCHEMA_VERSION))
    .query(`UPDATE ${INFO_TABLE} SET Valor = @v, Actualizado = SYSUTCDATETIME() WHERE Clave = @k;
            IF @@ROWCOUNT = 0 INSERT INTO ${INFO_TABLE} (Clave, Valor) VALUES (@k, @v);`);
}

// ---------- Migración desde SQLite ----------
const migratedMark = () => sqlitePath() + '.migrado-a-sqlserver';

/** Copia a SQL Server todo lo que había en el SQLite anterior. Nunca sobrescribe claves que ya existan en SQL Server. */
async function migrateFromSqlite(pool: import('mssql').ConnectionPool, c: Conn): Promise<{ total: number; inserted: number } | null> {
  const file = sqlitePath();
  if (!existsSync(file) || existsSync(migratedMark())) return null;
  const require = createRequire(import.meta.url);
  const { DatabaseSync } = require('node:sqlite');
  const lite = new DatabaseSync(file);
  let rows: { k: string; v: string }[] = [];
  try {
    const hasKv = lite.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'kv'").get();
    if (hasKv) rows = lite.prepare('SELECT k, v FROM kv ORDER BY k').all() as { k: string; v: string }[];
  } finally {
    lite.close();
  }
  const sql = await mssql();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  let inserted = 0;
  try {
    for (const r of rows) {
      const res = await new sql.Request(tx)
        .input('k', sql.NVarChar(KEY_MAX), dbKey(r.k))
        .input('v', sql.NVarChar(sql.MAX), r.v)
        .query(`IF NOT EXISTS (SELECT 1 FROM ${DATA_TABLE} WHERE Clave = @k) INSERT INTO ${DATA_TABLE} (Clave, Valor) VALUES (@k, @v);`);
      inserted += res.rowsAffected.reduce((a, b) => a + b, 0);
    }
    const info = JSON.stringify({ at: new Date().toISOString(), file, total: rows.length, inserted });
    await new sql.Request(tx)
      .input('k', sql.NVarChar(100), 'migracion-sqlite')
      .input('v', sql.NVarChar(sql.MAX), info)
      .query(`UPDATE ${INFO_TABLE} SET Valor = @v, Actualizado = SYSUTCDATETIME() WHERE Clave = @k;
              IF @@ROWCOUNT = 0 INSERT INTO ${INFO_TABLE} (Clave, Valor) VALUES (@k, @v);`);
    await tx.commit();
  } catch (e) {
    await tx.rollback().catch(() => {});
    throw e;
  }
  // El fichero SQLite no se borra: queda como copia. La marca evita volver a migrarlo.
  writePrivate(migratedMark(), JSON.stringify({ at: new Date().toISOString(), server: c.server, database: c.database, total: rows.length, inserted }) + '\n');
  console.log(`[prime-suite] Migración SQLite → SQL Server: ${inserted} de ${rows.length} registros copiados (${file}).`);
  return { total: rows.length, inserted };
}

// ---------- Instalación dueña de la base de datos ----------
// Desarrollo y producción pueden usar el mismo servidor SQL Server: cada instalación se identifica con un
// id guardado en su volumen (/data/.instalacion) y marca su base de datos con él. Así, si dos instalaciones
// apuntan por error a la misma base de datos, la segunda no entra y no se pisan los datos.
interface Installation { id: string; name: string; at: string }
const installPath = () => path.join(dataDir(), '.instalacion');
export function installName() {
  return (process.env.PRIME_INSTALL_NAME || process.env.COMPOSE_PROJECT_NAME || process.env.PRIME_ISSUER || '').trim() || hostname();
}
export function installation(): Installation {
  try {
    const i = JSON.parse(readFileSync(installPath(), 'utf8')) as Installation;
    if (i?.id) return i;
  } catch {}
  const i: Installation = { id: randomUUID(), name: installName(), at: new Date().toISOString() };
  writePrivate(installPath(), JSON.stringify(i) + '\n');
  return i;
}
/** Nombre de base de datos que se sugiere en el formulario (distinto en producción). */
export function suggestedDatabase() {
  if (process.env.PRIME_DB_NAME) return process.env.PRIME_DB_NAME;
  const n = installName().toLowerCase();
  return /prod/.test(n) ? 'PrimeSuite_Prod' : 'PrimeSuite_Dev';
}

async function claimDatabase(pool: import('mssql').ConnectionPool, database: string, takeOver: boolean) {
  const sql = await mssql();
  const me = installation();
  const r = await pool.request().input('k', sql.NVarChar(100), 'instalacion').query(`SELECT Valor FROM ${INFO_TABLE} WHERE Clave = @k`);
  let owner: Installation | null = null;
  try { owner = r.recordset[0]?.Valor ? JSON.parse(r.recordset[0].Valor) : null; } catch {}
  if (owner?.id === me.id) return;
  if (owner?.id && !takeOver) {
    const since = owner.at ? new Date(owner.at).toLocaleDateString('es-ES') : '?';
    throw new HttpError(409, `La base de datos "${database}" ya la usa otra instalación de Prime Suite (${owner.name || 'sin nombre'}, desde el ${since}). Indica otro nombre de base de datos para que no se pisen los datos.`, 'DB_IN_USE');
  }
  const v = JSON.stringify({ ...me, name: installName(), at: new Date().toISOString(), previous: owner?.id ? owner : undefined });
  await pool.request().input('k', sql.NVarChar(100), 'instalacion').input('v', sql.NVarChar(sql.MAX), v)
    .query(`UPDATE ${INFO_TABLE} SET Valor = @v, Actualizado = SYSUTCDATETIME() WHERE Clave = @k;
            IF @@ROWCOUNT = 0 INSERT INTO ${INFO_TABLE} (Clave, Valor) VALUES (@k, @v);`);
}

// ---------- Estado ----------
export type DbStatus = 'iniciando' | 'conectando' | 'sin-configurar' | 'error' | 'lista';
interface State { status: DbStatus; error?: string; since: string; pool?: import('mssql').ConnectionPool; config?: DbConfig }
const state: State = { status: 'iniciando', since: new Date().toISOString() };
let connecting: Promise<void> | null = null;
let retryTimer: ReturnType<typeof setInterval> | null = null;
// Solo el servidor web anuncia el código de configuración y reintenta; las herramientas (backup/restore) no.
let serverProcess = false;

function setStatus(status: DbStatus, error?: string) {
  state.status = status;
  state.error = error;
  state.since = new Date().toISOString();
}

/** Arranque: lee el fichero y conecta. Si no hay fichero o falla, queda en modo configuración. */
export function initDb(opts?: { server?: boolean }): Promise<void> {
  if (opts?.server) serverProcess = true;
  if (connecting) return connecting;
  if (state.status === 'lista') return Promise.resolve();
  connecting = (async () => {
    const cfg = readConfig();
    if (!cfg) {
      setStatus('sin-configurar', existsSync(configPath()) ? `El fichero ${configPath()} no es válido.` : undefined);
      announceCode();
      return;
    }
    setStatus('conectando');
    try {
      await activate({ ...normalizeConfig(cfg) }, cfg);
    } catch (e) {
      setStatus('error', explain(e));
      state.config = cfg;
      console.error(`[prime-suite] No se pudo conectar a SQL Server (${cfg.server}/${cfg.database}): ${explain(e)}`);
      announceCode();
      scheduleRetry();
    }
  })().finally(() => { connecting = null; });
  return connecting;
}

function normalizeConfig(cfg: DbConfig): Conn {
  return { server: cfg.server, port: cfg.port, database: cfg.database, user: cfg.user, password: decryptLocal(cfg.passwordEnc), encrypt: cfg.encrypt, trustServerCertificate: cfg.trustServerCertificate };
}

async function activate(c: Conn, cfg: DbConfig, takeOver = false) {
  const { pool, createdDatabase } = await openPool(c);
  pool.on('error', (e: any) => { if (state.pool === pool) lost(e); });
  try {
    await ensureSchema(pool);
    await claimDatabase(pool, c.database, takeOver);
    const migrated = await migrateFromSqlite(pool, c);
    const old = state.pool;
    state.pool = pool;
    state.config = cfg;
    setStatus('lista');
    stopRetry();
    if (old && old !== pool) old.close().catch(() => {});
    console.log(`[prime-suite] Conectado a SQL Server ${c.server}/${c.database}.`);
    return { createdDatabase, migrated };
  } catch (e) {
    await pool.close().catch(() => {});
    throw e;
  }
}

/** Se ha perdido la conexión: se vuelve a modo configuración y se reintenta solo cada 30 s. */
function lost(e: any) {
  if (state.status !== 'lista') return;
  console.error('[prime-suite] Se ha perdido la conexión con SQL Server:', explain(e));
  const old = state.pool;
  state.pool = undefined;
  setStatus('error', explain(e));
  old?.close().catch(() => {});
  announceCode();
  scheduleRetry();
}
function scheduleRetry() {
  if (retryTimer || !serverProcess) return;
  retryTimer = setInterval(() => {
    if (state.status === 'error' && state.config && !connecting) initDb().catch(() => {});
  }, 30_000);
  retryTimer.unref?.();
}
function stopRetry() {
  if (retryTimer) clearInterval(retryTimer);
  retryTimer = null;
}

/** Pool listo para usar o error 503 (la web lo detecta y muestra el formulario de conexión). */
export async function getPool(): Promise<import('mssql').ConnectionPool> {
  if (state.status === 'iniciando' || connecting) await initDb();
  if (state.status === 'lista' && state.pool) return state.pool;
  throw dbUnavailable();
}
export const dbUnavailable = () => new HttpError(503, state.status === 'sin-configurar'
  ? 'Prime Suite aún no tiene configurada la base de datos SQL Server.'
  : `No hay conexión con la base de datos SQL Server${state.error ? `: ${state.error}` : '.'}`, 'DB_SETUP');

/** Ejecuta una operación y, si falla por conexión, pasa a modo configuración. */
export async function withPool<T>(fn: (pool: import('mssql').ConnectionPool, sql: Sql) => Promise<T>): Promise<T> {
  const pool = await getPool();
  const sql = await mssql();
  try {
    return await fn(pool, sql);
  } catch (e) {
    if (isConnectionError(e)) { lost(e); throw dbUnavailable(); }
    throw e;
  }
}

export function dbStatus() {
  const c = state.config || readConfig();
  return {
    store: 'sqlserver',
    status: state.status,
    ready: state.status === 'lista',
    error: state.error || null,
    since: state.since,
    configured: !!c,
    suggestedDatabase: state.status !== 'lista' ? suggestedDatabase() : undefined,
    installation: state.status !== 'lista' ? installName() : undefined,
    // Datos para rellenar el formulario (sin usuario ni contraseña). Solo mientras no está conectada.
    config: state.status !== 'lista' && c ? { server: c.server, port: c.port || null, database: c.database, encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate } : null,
    configFile: state.status !== 'lista' ? configPath() : undefined,
    sqlite: state.status !== 'lista' ? { file: sqlitePath(), exists: existsSync(sqlitePath()), migrated: existsSync(migratedMark()) } : undefined
  };
}

/** Reintento manual con la configuración guardada. */
export async function retryDb() {
  if (state.status === 'lista') return dbStatus();
  if (!readConfig()) throw new HttpError(400, 'No hay ninguna conexión guardada: rellena el formulario.');
  if (state.status === 'error') setStatus('iniciando');
  await initDb();
  return dbStatus();
}

/** Guarda una conexión nueva: prueba, crea BD/tablas, migra el SQLite y escribe el fichero. */
export async function configureDb(b: DbInput & { code?: string; takeOver?: boolean }) {
  if (state.status === 'lista') throw new HttpError(409, 'La base de datos ya está conectada. Para cambiarla, edita o borra el fichero de configuración y reinicia.');
  checkCode(b.code);
  const c = normalizeInput(b, readConfig());
  const cfg: DbConfig = {
    server: c.server, port: c.port, database: c.database, user: c.user, passwordEnc: encryptLocal(c.password),
    encrypt: c.encrypt, trustServerCertificate: c.trustServerCertificate, updatedAt: new Date().toISOString()
  };
  if (connecting) await connecting.catch(() => {});
  setStatus('conectando');
  try {
    const r = await activate(c, cfg, b.takeOver === true);
    writeConfig(cfg);
    return { ok: true, createdDatabase: r.createdDatabase, migrated: r.migrated, status: dbStatus() };
  } catch (e) {
    setStatus(readConfig() ? 'error' : 'sin-configurar', explain(e));
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, explain(e));
  }
}

// ---------- Código de configuración ----------
let setupCode: string | null = null;
let failures = 0;
let lockedUntil = 0;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function newSetupCode() {
  const bytes = randomBytes(10);
  let out = '';
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return `${out.slice(0, 5)}-${out.slice(5)}`;
}
function announceCode() {
  if (!serverProcess) return;
  if (!setupCode) setupCode = newSetupCode();
  try { writePrivate(codePath(), setupCode + '\n'); } catch {}
  console.log([
    '',
    '══════════════════════════════════════════════════════════════════',
    '  Prime Suite necesita los datos de conexión a SQL Server.',
    '  Ábrelo en el navegador y rellena el formulario. Código de configuración:',
    `      ${setupCode}`,
    `  (también en ${codePath()})`,
    '══════════════════════════════════════════════════════════════════',
    ''
  ].join('\n'));
}
export function checkCode(code: unknown, expected = setupCode) {
  if (Date.now() < lockedUntil) throw new HttpError(429, 'Demasiados intentos con un código incorrecto. Espera 15 minutos.');
  const given = String(code ?? '').trim().toUpperCase().replace(/\s+/g, '');
  const ok = !!expected && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
  if (!ok) {
    if (++failures >= 10) { lockedUntil = Date.now() + 15 * 60_000; failures = 0; }
    throw new HttpError(403, 'El código de configuración no es correcto. Está en el log del contenedor y en ' + codePath() + '.');
  }
  failures = 0;
}

/** Cierre ordenado (al parar el contenedor). */
export async function closeDb() {
  stopRetry();
  await state.pool?.close().catch(() => {});
}
