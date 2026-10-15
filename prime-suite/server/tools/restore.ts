// Restaurar/importar una copia de seguridad en el almacén actual.
// Uso (dentro del contenedor):  node --import tsx server/tools/restore.ts /data/backup.json
import { readFile } from 'node:fs/promises';
import { store, storeMode } from '../store.ts';

const file = process.argv[2];
if (!file) { console.error('Indica el fichero de copia: node --import tsx server/tools/restore.ts <fichero.json>'); process.exit(1); }
const parsed = JSON.parse(await readFile(file, 'utf8'));
if (parsed.format !== 'prime-suite-backup' || !parsed.data) { console.error('El fichero no es una copia de seguridad de Prime Suite válida.'); process.exit(1); }
const kv = store();
let n = 0;
for (const [k, v] of Object.entries(parsed.data)) { await kv.set(k, v); n++; }
console.log(`Importados ${n} registros en el almacén (${storeMode()}).`);
if (storeMode() === 'sqlserver') await (await import('../sqlserver.ts')).closeDb();
