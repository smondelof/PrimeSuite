// Capa de almacenamiento: Netlify Blobs (nube), SQL Server (autoalojado) o ficheros JSON (local).
import { getStore } from '@netlify/blobs';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface KV {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown, opts?: { onlyIfNew?: boolean }): Promise<boolean>;
  del(key: string): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

// Almacenamiento en SQL Server para instalaciones autoalojadas (ver server/sqlserver.ts).
// Una fila por clave en dbo.PrimeSuite_Datos; el valor es el JSON del registro.
class SqlServerKV implements KV {
  private mod = import('./sqlserver.ts');
  async get<T>(key: string) {
    const m = await this.mod;
    return m.withPool(async (pool, sql) => {
      const r = await pool.request().input('k', sql.NVarChar(m.KEY_MAX), m.dbKey(key)).query(`SELECT Valor FROM ${m.DATA_TABLE} WHERE Clave = @k`);
      const v = r.recordset[0]?.Valor as string | undefined;
      return v === undefined ? null : (JSON.parse(v) as T);
    });
  }
  async set(key: string, value: unknown, opts?: { onlyIfNew?: boolean }) {
    const m = await this.mod;
    const v = JSON.stringify(value ?? null);
    return m.withPool(async (pool, sql) => {
      const req = pool.request().input('k', sql.NVarChar(m.KEY_MAX), m.dbKey(key)).input('v', sql.NVarChar(sql.MAX), v);
      if (opts?.onlyIfNew) {
        try {
          await req.query(`INSERT INTO ${m.DATA_TABLE} (Clave, Valor) VALUES (@k, @v)`);
          return true;
        } catch (e: any) {
          if (e?.number === 2627 || e?.number === 2601) return false; // ya existía
          throw e;
        }
      }
      await req.query(`SET XACT_ABORT ON;
        BEGIN TRAN;
        UPDATE ${m.DATA_TABLE} WITH (UPDLOCK, SERIALIZABLE) SET Valor = @v, Actualizado = SYSUTCDATETIME() WHERE Clave = @k;
        IF @@ROWCOUNT = 0 INSERT INTO ${m.DATA_TABLE} (Clave, Valor) VALUES (@k, @v);
        COMMIT;`);
      return true;
    });
  }
  async del(key: string) {
    const m = await this.mod;
    await m.withPool((pool, sql) => pool.request().input('k', sql.NVarChar(m.KEY_MAX), m.dbKey(key)).query(`DELETE FROM ${m.DATA_TABLE} WHERE Clave = @k`));
  }
  async keys(prefix: string) {
    const m = await this.mod;
    return m.withPool(async (pool, sql) => {
      const r = await pool.request().input('p', sql.NVarChar(m.KEY_MAX + 10), m.likePrefix(prefix))
        .query(`SELECT Clave FROM ${m.DATA_TABLE} WHERE Clave LIKE @p ESCAPE N'\\' ORDER BY Clave`);
      return r.recordset.map((row: { Clave: string }) => row.Clave);
    });
  }
}

function makeBlobStore() {
  // Si se proporciona un token explícito (variable de entorno), se usa SIEMPRE:
  // evita el token que Netlify inyecta automáticamente y que puede caducar
  // ("Failed to decode token: Token expired").
  const siteID = process.env.NETLIFY_SITE_ID || process.env.SITE_ID;
  const token = process.env.NETLIFY_BLOBS_TOKEN || process.env.NETLIFY_API_TOKEN;
  if (siteID && token) {
    return getStore({ name: 'prime-suite', consistency: 'strong', siteID, token });
  }
  // Respaldo: configuración automática del runtime de Netlify Functions.
  return getStore({ name: 'prime-suite', consistency: 'strong' });
}

class BlobKV implements KV {
  private store = makeBlobStore();
  // Si el token automático de Netlify caduca, se descarta el almacén en caché para que
  // la siguiente petición (otra instancia) lo reconstruya con contexto fresco o el token propio.
  private guard<T>(p: Promise<T>): Promise<T> {
    return p.catch((e: any) => {
      if (/token expired|expired|invalid/i.test(String(e?.message))) kv = null;
      throw e;
    });
  }
  async get<T>(key: string) {
    return this.guard(this.store.get(key, { type: 'json' }).then((v) => (v ?? null) as T | null));
  }
  async set(key: string, value: unknown, opts?: { onlyIfNew?: boolean }) {
    return this.guard(this.store.setJSON(key, value, opts?.onlyIfNew ? { onlyIfNew: true } : {}).then((r) => r?.modified !== false));
  }
  async del(key: string) {
    await this.guard(this.store.delete(key));
  }
  async keys(prefix: string) {
    return this.guard(this.store.list({ prefix }).then((r) => r.blobs.map((b) => b.key)));
  }
}

class FileKV implements KV {
  constructor(private dir: string) {}
  private file(key: string) {
    return path.join(this.dir, encodeURIComponent(key) + '.json');
  }
  async get<T>(key: string) {
    try {
      return JSON.parse(await fs.readFile(this.file(key), 'utf8')) as T;
    } catch {
      return null;
    }
  }
  async set(key: string, value: unknown, opts?: { onlyIfNew?: boolean }) {
    await fs.mkdir(this.dir, { recursive: true });
    if (opts?.onlyIfNew) {
      try {
        await fs.writeFile(this.file(key), JSON.stringify(value), { flag: 'wx' });
        return true;
      } catch {
        return false;
      }
    }
    await fs.writeFile(this.file(key), JSON.stringify(value));
    return true;
  }
  async del(key: string) {
    await fs.rm(this.file(key), { force: true });
  }
  async keys(prefix: string) {
    try {
      const files = await fs.readdir(this.dir);
      return files
        .filter((f) => f.endsWith('.json'))
        .map((f) => decodeURIComponent(f.slice(0, -5)))
        .filter((k) => k.startsWith(prefix));
    } catch {
      return [];
    }
  }
}

let kv: KV | null = null;

/**
 * Motor de almacenamiento: 'sqlserver' (autoalojado), 'file' (desarrollo local) o 'blobs' (Netlify).
 * PRIME_STORE=sqlite (instalaciones anteriores) ahora significa SQL Server: el fichero SQLite
 * solo se lee una vez para migrar sus datos.
 */
export function storeMode(): 'sqlserver' | 'file' | 'blobs' {
  const m = (process.env.PRIME_STORE || '').toLowerCase();
  if (m === 'sqlserver' || m === 'mssql' || m === 'sqlite') return 'sqlserver';
  if (m === 'file') return 'file';
  return 'blobs';
}

export function store(): KV {
  if (kv) return kv;
  const mode = storeMode();
  if (mode === 'sqlserver') kv = new SqlServerKV();
  else if (mode === 'file') kv = new FileKV(process.env.PRIME_DATA_DIR || path.resolve('.data'));
  else kv = new BlobKV();
  return kv;
}

export function setStore(custom: KV) {
  kv = custom;
}
