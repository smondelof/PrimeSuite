// Copia de seguridad por línea de comandos: vuelca todo el almacén a un fichero JSON.
// Uso (dentro del contenedor):  node --import tsx server/tools/backup.ts /data/backups/backup.json
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { store, storeMode } from '../store.ts';

const out = process.argv[2] || `prime-suite-backup-${new Date().toISOString().slice(0, 10)}.json`;
const kv = store();
const keys = await kv.keys('');
const data: Record<string, unknown> = {};
for (const k of keys) data[k] = await kv.get(k);
await mkdir(path.dirname(path.resolve(out)), { recursive: true });
await writeFile(out, JSON.stringify({ format: 'prime-suite-backup', version: 1, exportedAt: new Date().toISOString(), count: keys.length, data }));
console.log(`Copia de seguridad: ${keys.length} registros → ${out}`);
// Con SQL Server hay que cerrar la conexión para que el proceso termine.
if (storeMode() === 'sqlserver') await (await import('../sqlserver.ts')).closeDb();
