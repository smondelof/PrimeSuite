// Tests de la pantalla Personal de Atajos de Evalos: validación de la ficha, driver de demostración
// y SQL que genera el driver de SQL Server sobre la tabla PERSONAL (con la BD simulada).
// Ejecutar con:  npm test   (node --import tsx --test server/*.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRIME_STORE = 'file';
process.env.PRIME_DATA_DIR = mkdtempSync(join(tmpdir(), 'ps-personal-'));

const { sanitizePersonal, sanitizeNewNames, sanitizeOrgValue } = await import('./evalos/personal.ts');
const { DemoDriver } = await import('./evalos/demo.ts');
const { SqlServerDriver } = await import('./evalos/mssql.ts');
const { DEFAULT_MAPPING } = await import('./evalos/types.ts');
const { madridNow, nextCode, prevDay } = await import('./evalos/history.ts');
type Lookups = import('./evalos/types.ts').PersonalLookups;
type ColumnInfo = import('./evalos/types.ts').ColumnInfo;

const LOOKUPS: Lookups = {
  company: [{ code: 'PRI', description: 'PRIMION' }],
  department: [{ code: 'IT', description: 'INFORMÁTICA' }],
  section: [], area: null, consultas: [{ code: '001', description: 'BÁSICA' }], solicitudes: [{ code: '001', description: 'ESTÁNDAR' }],
  convenio: [{ code: 'METAL', description: 'METAL' }]
};
const LIMITS = { code: 50, name: 100, card: 50, email: 100, company: 15, department: 15, section: 15, area: 15, consultas: 3, solicitudes: 3 };
const BASE = { code: '1000000001', name: 'garcía  pérez,   ana', card: '0000001234', email: 'ana@primion.es', hireDate: '2026-10-01', endDate: '', company: 'PRI', department: 'IT', section: '', area: 'LIBRE', consultas: '001', solicitudes: '001' };
const opts = { uppercase: true, limits: LIMITS, lookups: LOOKUPS };
const STAMP = { date: '20261007', time: '1559', user: 'SMO' };

const status = (fn: () => unknown) => {
  try { fn(); return 0; } catch (e: any) { return e.status ?? -1; }
};

test('validación: normaliza código y nombre en mayúsculas', () => {
  const p = sanitizePersonal(BASE, opts);
  assert.equal(p.code, '1000000001');
  assert.equal(p.name, 'GARCÍA PÉREZ, ANA');
  assert.equal(p.email, 'ANA@PRIMION.ES', 'EM_WFEM en mayúsculas');
  assert.equal(p.area, 'LIBRE'); // sin tabla AREA: texto libre
});

test('validación: código, nombre, tarjeta y alta son obligatorios', () => {
  for (const k of ['code', 'name', 'card', 'hireDate']) assert.equal(status(() => sanitizePersonal({ ...BASE, [k]: '' }, opts)), 400, k);
  assert.equal(status(() => sanitizePersonal({ ...BASE, email: '' }, opts)), 0);
});

test('validación: fechas, email, longitudes y valores de los desplegables', () => {
  assert.equal(status(() => sanitizePersonal({ ...BASE, hireDate: '2026-02-30' }, opts)), 400);
  assert.equal(status(() => sanitizePersonal({ ...BASE, endDate: '2026-09-30' }, opts)), 400); // baja anterior al alta
  assert.equal(status(() => sanitizePersonal({ ...BASE, endDate: '2026-12-31' }, opts)), 0);
  assert.equal(status(() => sanitizePersonal({ ...BASE, email: 'no-es-un-email' }, opts)), 400);
  assert.equal(status(() => sanitizePersonal({ ...BASE, card: 'x'.repeat(51) }, opts)), 400);
  assert.equal(status(() => sanitizePersonal({ ...BASE, department: 'NOEXISTE' }, opts)), 400);
  assert.equal(status(() => sanitizePersonal({ ...BASE, consultas: '' }, opts)), 0);
});

test('validación: al modificar, el código lo fija la URL y la tarjeta no se pide', () => {
  const p = sanitizePersonal({ ...BASE, code: 'OTRO', card: '' }, { ...opts, code: '1000000001' });
  assert.equal(p.code, '1000000001');
  assert.equal(p.card, '');
});

test('fecha y hora de los cambios en hora de Madrid', () => {
  // 7 oct 2026 13:59 UTC = 15:59 en Madrid (horario de verano); 31 dic 23:30 UTC = 1 ene 00:30
  assert.deepEqual(madridNow(new Date('2026-10-07T13:59:00Z')), { date: '20261007', time: '1559' });
  assert.deepEqual(madridNow(new Date('2026-12-31T23:30:00Z')), { date: '20270101', time: '0030' });
});

test('demo: alta, modificación, tarjeta duplicada y eliminación', async () => {
  const d = new DemoDriver('co-test');
  const emp = sanitizePersonal(BASE, opts);
  await d.createPersonal(emp, STAMP);
  await assert.rejects(d.createPersonal(emp, STAMP), (e: any) => e.status === 409);
  await assert.rejects(d.createPersonal({ ...emp, code: '1000000002' }, STAMP), (e: any) => e.status === 409 && /tarjeta 0000001234/.test(e.message));
  const [a] = await d.personalHistory('1000000001').then((h) => h.card);
  assert.deepEqual({ value: a.value, from: a.from, to: a.to, type: a.type, user: a.user }, { value: '0000001234', from: '2026-10-01', to: '', type: 'A', user: 'SMO' });

  const { code: _c, ...rest } = emp;
  await d.updatePersonal('1000000001', { ...rest, name: 'NUEVO NOMBRE', endDate: '2026-10-02' }, STAMP);
  const got = await d.getPersonal('1000000001');
  assert.equal(got?.name, 'NUEVO NOMBRE');
  assert.equal(got?.code, '1000000001');
  assert.equal(got?.endDate, '2026-10-02');
  assert.equal(got?.active, false);
  assert.ok((await d.listPersonal()).some((x) => x.code === '1000000001'));

  await d.deletePersonal('1000000001');
  assert.equal(await d.getPersonal('1000000001'), null);
  assert.equal((await d.personalHistory('1000000001').then((h) => h.card)).length, 0, 'se borran sus asignaciones');
});

test('demo: asignar y desasignar tarjetas, varias por empleado y sin solapes', async () => {
  const d = new DemoDriver('co-cards');
  const today = madridNow().date;
  const iso = (y: string) => `${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}`;
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000011', card: '0000009001', hireDate: '2026-01-01' }, opts), STAMP);
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000021', card: '0000009009', hireDate: '2026-01-01' }, opts), STAMP);

  // Segunda tarjeta para A1: EM_TARJ pasa a la más reciente.
  await d.assignHistory('card', '1000000011', { code: '0000009002' }, '2026-02-01', STAMP);
  assert.equal((await d.getPersonal('1000000011'))?.card, '0000009002');
  assert.equal((await d.personalHistory('1000000011').then((h) => h.card)).filter((c) => c.active).length, 2);

  // Otro empleado no puede coger una tarjeta vigente; tampoco repetir la misma en el mismo empleado.
  await assert.rejects(d.assignHistory('card', '1000000021', { code: '0000009001' }, iso(today), STAMP), (e: any) => e.status === 409 && /1000000011/.test(e.message));
  await assert.rejects(d.assignHistory('card', '1000000011', { code: '0000009001' }, '2026-03-01', STAMP), (e: any) => e.status === 409);

  // Desasignar T2 con baja ayer: se cierra el tramo (B) y EM_TARJ vuelve a T1.
  const y = new Date(); y.setDate(y.getDate() - 1);
  const yesterday = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  await d.closeHistory('card', '1000000011', '0000009002', '2026-02-01', yesterday, { ...STAMP, date: today });
  const t2 = (await d.personalHistory('1000000011').then((h) => h.card)).find((c) => c.value === '0000009002')!;
  assert.equal(t2.type, 'B');
  assert.equal(t2.to, yesterday);
  assert.equal(t2.active, false);
  assert.equal((await d.getPersonal('1000000011'))?.card, '0000009001');

  // Una vez cerrada, otro empleado puede tenerla desde hoy.
  await d.assignHistory('card', '1000000021', { code: '0000009002' }, iso(today), STAMP);
  assert.ok((await d.personalHistory('1000000021').then((h) => h.card)).some((c) => c.value === '0000009002' && c.active));

  // No se puede cerrar dos veces ni con baja anterior al alta.
  await assert.rejects(d.closeHistory('card', '1000000011', '0000009002', '2026-02-01', yesterday, { ...STAMP, date: today }), (e: any) => e.status === 404);
  await assert.rejects(d.closeHistory('card', '1000000011', '0000009001', '2026-01-01', '2025-12-31', STAMP), (e: any) => e.status === 400);

  // Al modificar la ficha (con la misma fecha de alta) no se toca la tarjeta.
  const { code: _c, ...rest } = sanitizePersonal({ ...BASE, card: '', hireDate: '2026-01-01' }, { ...opts, code: '1000000011' });
  await d.updatePersonal('1000000011', rest, STAMP);
  assert.equal((await d.getPersonal('1000000011'))?.card, '0000009001');
});

test('demo: no deja eliminar a un empleado con marcajes', async () => {
  const d = new DemoDriver('co-test-2');
  const withPunches = (await d.listMarcajes())[0].employee;
  await assert.rejects(d.deletePersonal(withPunches), (e: any) => e.status === 409 && /marcajes/.test(e.message));
});

// ---------- SQL Server simulado ----------
const col = (name: string, type = 'nvarchar', maxLength: number | null = 15, nullable = true): ColumnInfo => ({ name, type, maxLength, nullable, hasDefault: false, identity: false, computed: false });
const PERSONAL_COLS = [
  col('EM_CODI', 'varchar', 50, false), col('EM_NOMB', 'nvarchar', 100), col('EM_TARJ', 'varchar', 50), col('EM_WFEM', 'nvarchar', 100),
  col('EM_FALT', 'nvarchar', 8), col('EM_FBAJ', 'nvarchar', 8), col('EM_CEMP'), col('EM_DEPA'), col('EM_SECC'), col('EM_AREA'),
  col('EM_KOPC', 'nvarchar', 3), col('EM_WFOP', 'nvarchar', 3), col('EM_CACC', 'nvarchar', 3), col('EM_CAUT', 'nvarchar', 3), col('EM_TURN', 'nvarchar', 3),
  col('EM_OBLI', 'int', null, false) // columna obligatoria ajena a la ficha: se rellena con 0
];

const TABLES: Record<string, ColumnInfo[]> = {
  PERSONAL: PERSONAL_COLS,
  TARJETA: [col('TA_CODI', 'nvarchar', 50, false), col('TA_DESC', 'nvarchar', 60)],
  HIS_TARJETA: ['HT_PCOD', 'HT_CODI', 'HT_FALT', 'HT_FBAJ', 'HT_TIPO', 'HT_FECH', 'HT_HORA', 'HT_USUA'].map((n) => col(n, 'nvarchar', 50)),
  DEPMENTO: [col('DP_CODI', 'nvarchar', 15, false), col('DP_DESC', 'nvarchar', 100)],
  HIS_VIGENCIA: ['HV_PCOD', 'HV_FALT', 'HV_FBAJ', 'HV_TIPO', 'HV_FECH', 'HV_HORA', 'HV_USUA'].map((n) => col(n, 'nvarchar', 50)),
  HIS_DEPMENTO: ['HD_PCOD', 'HD_CODI', 'HD_FALT', 'HD_FBAJ', 'HD_TIPO', 'HD_FECH', 'HD_HORA', 'HD_USUA'].map((n) => col(n, 'nvarchar', 50))
};

function fakeSql(handler: (text: string, params: Record<string, unknown>) => { rows?: any[]; affected?: number } | void, employee?: Record<string, unknown>) {
  const drv: any = new SqlServerDriver('Server=x;Database=y', DEFAULT_MAPPING);
  const calls: { text: string; params: Record<string, unknown> }[] = [];
  drv.columns = async (t: { table: string }) => TABLES[t.table] || [];
  drv.inTx = async (fn: any) => fn((text: string, params?: Record<string, unknown>) => drv.query(text, params));
  drv.query = async (text: string, params: Record<string, unknown> = {}) => {
    calls.push({ text, params });
    if (employee && text.startsWith('SELECT p.')) return { rows: [{ code: '1000000001', ...employee }], affected: 1 };
    const r = handler(text, params) || {};
    return { rows: r.rows || [], affected: r.affected ?? 1 };
  };
  return { drv, calls };
}

test('SQL Server: el alta escribe la ficha, los valores fijos y las fechas en aaaammdd', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [] }));
  await drv.createPersonal({ ...sanitizePersonal(BASE, opts), endDate: '2027-01-31' }, STAMP);
  const ins = calls.find((c) => c.text.startsWith('INSERT INTO [PERSONAL]'))!;
  assert.ok(ins, 'debe hacer INSERT');
  const cols = ins.text.match(/\(([^)]*)\) VALUES/)![1].split(', ').map((x) => x.replace(/[[\]]/g, ''));
  const val = (c: string) => ins.params[`v${cols.indexOf(c)}`];
  assert.equal(val('EM_CODI'), '1000000001');
  assert.equal(val('EM_FALT'), '20261001');
  assert.equal(val('EM_FBAJ'), '20270131');
  assert.equal(val('EM_SECC'), null); // vacío → NULL
  assert.equal(val('EM_CACC'), '999');
  assert.equal(val('EM_CAUT'), '001');
  assert.equal(val('EM_TURN'), 'DEF');
  assert.equal(val('EM_OBLI'), 0);
  assert.equal(val('EM_TARJ'), '0000001234');
});

test('SQL Server: el alta crea la tarjeta si no existe y su asignación en HIS_TARJETA', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [] }));
  await drv.createPersonal(sanitizePersonal(BASE, opts), STAMP);
  const order = calls.map((c) => c.text.replace(/\s+/g, ' ').slice(0, 40));
  const iPers = order.findIndex((t) => t.startsWith('INSERT INTO [PERSONAL]'));
  const iCard = calls.findIndex((c) => /IF NOT EXISTS[\s\S]*INSERT INTO \[TARJETA\] \(\[TA_CODI\], \[TA_DESC\]\)/.test(c.text));
  const iHis = calls.findIndex((c) => c.text.includes('INSERT INTO [HIS_TARJETA]'));
  assert.ok(iPers >= 0 && iCard > iPers && iHis > iCard, order.join(' | '));
  assert.deepEqual(calls[iCard].params, { card: '0000001234', desc: 'Tarjeta: 0000001234' });
  assert.match(calls[iHis].text, /VALUES \(@code, @value, @from, '0', 'A', @fech, @hora, @usua\)/);
  assert.deepEqual(calls[iHis].params, { code: '1000000001', value: '0000001234', from: '20261001', fech: '20261007', hora: '1559', usua: 'SMO' });
  // El departamento también abre su tramo desde la fecha de alta (EMPRESA no existe en esta BD simulada: solo EM_CEMP).
  const dep = calls.find((c) => c.text.includes('INSERT INTO [HIS_DEPMENTO] ([HD_PCOD], [HD_CODI], [HD_FALT]'))!;
  assert.deepEqual(dep.params, { code: '1000000001', value: 'IT', from: '20261001', fech: '20261007', hora: '1559', usua: 'SMO' });
  assert.ok(!calls.some((c) => c.text.includes('HIS_EMPRESA')));
  // Antes de nada se comprueba que nadie la tenga vigente en la fecha de alta, bloqueando las filas.
  const chk = calls.find((c) => c.text.includes('WITH (UPDLOCK, HOLDLOCK)') && c.text.includes('[HT_PCOD] <> @code'))!;
  assert.equal(chk.params.from, '20261001');
});

test('SQL Server: modificar no toca el código ni los valores fijos', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [] }), { hireDate: '20261001' });
  const { code: _c, ...rest } = sanitizePersonal(BASE, opts);
  await drv.updatePersonal('1000000001', rest, STAMP);
  const upd = calls.find((c) => c.text.startsWith('UPDATE'))!;
  const set = upd.text.slice(upd.text.indexOf('SET'), upd.text.indexOf('WHERE'));
  assert.ok(!/EM_CODI|EM_CACC|EM_CAUT|EM_TURN/.test(set), set);
  assert.match(upd.text, /WHERE \[EM_CODI\] = @code/);
  assert.equal(upd.params.code, '1000000001');
});

test('SQL Server: tarjeta vigente en otro empleado → 409 y no se inserta nada', async () => {
  const { drv, calls } = fakeSql((text) => (text.includes('[HT_PCOD] <> @code') ? { rows: [{ emp: '1000000099', fbaj: '0' }] } : { rows: [] }));
  await assert.rejects(drv.createPersonal(sanitizePersonal(BASE, opts), STAMP), (e: any) => e.status === 409 && /1000000099 sin fecha de baja/.test(e.message));
  assert.ok(!calls.some((c) => c.text.startsWith('INSERT')));
  const { drv: d2 } = fakeSql((text) => (text.includes('[HT_PCOD] <> @code') ? { rows: [{ emp: '1000000098', fbaj: '20261231' }] } : { rows: [{ code: '1000000001' }] }));
  await assert.rejects(d2.assignHistory('card', '1000000001', { code: '0000001234' }, '2026-10-07', STAMP), (e: any) => e.status === 409 && /1000000098 hasta el 31\/12\/2026/.test(e.message));
});

test('SQL Server: modificar no reescribe la tarjeta (EM_TARJ)', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [] }), { hireDate: '20261001' });
  const { code: _c, ...rest } = sanitizePersonal({ ...BASE, card: '0000009999' }, opts);
  await drv.updatePersonal('1000000001', rest, STAMP);
  const upd = calls.find((c) => c.text.startsWith('UPDATE'))!;
  assert.ok(!upd.text.includes('EM_TARJ'), upd.text);
});

test('SQL Server: asignar inserta tramo A y deja EM_TARJ con la vigente más reciente', async () => {
  const { drv, calls } = fakeSql((text) => (text.startsWith('SELECT p.') ? { rows: [{ code: '1000000001' }] } : { rows: [] }));
  await drv.assignHistory('card', '1000000001', { code: '0000009002' }, '2026-10-07', STAMP);
  const his = calls.find((c) => c.text.includes('INSERT INTO [HIS_TARJETA]'))!;
  assert.equal(his.params.from, '20261007');
  const sync = calls.find((c) => c.text.startsWith('UPDATE [PERSONAL] SET [EM_TARJ]'))!;
  assert.ok(sync, 'sincroniza EM_TARJ');
  assert.match(sync.text.replace(/\s+/g, ' '), /ORDER BY CASE WHEN .* THEN 0 ELSE 1 END, h\.\[HT_FALT\] DESC/);
  assert.equal(sync.params.today, '20261007');
});

test('SQL Server: desasignar cierra el tramo con baja, tipo B, fecha, hora e iniciales', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [], affected: 1 }));
  await drv.closeHistory('card', '1000000001', '0000009002', '2026-01-01', '2026-10-07', STAMP);
  const upd = calls.find((c) => c.text.startsWith('UPDATE [HIS_TARJETA]'))!;
  assert.match(upd.text, /SET \[HT_FBAJ\] = @to, \[HT_TIPO\] = 'B', \[HT_FECH\] = @fech, \[HT_HORA\] = @hora, \[HT_USUA\] = @usua/);
  assert.match(upd.text, /WHERE \[HT_PCOD\] = @code AND \[HT_CODI\] = @value AND \[HT_FALT\] = @from/);
  assert.equal(upd.params.to, '20261007');
  assert.equal(upd.params.from, '20260101');
  assert.ok(calls.some((c) => c.text.startsWith('UPDATE [PERSONAL] SET [EM_TARJ]')));
  // Si no hay tramo vigente que cerrar → 404
  const { drv: d2 } = fakeSql(() => ({ rows: [], affected: 0 }));
  await assert.rejects(d2.closeHistory('card', '1000000001', '0000009002', '2026-01-01', '2026-10-07', STAMP), (e: any) => e.status === 404);
});

test('SQL Server: historial de tarjetas, vigencia y registro', async () => {
  const { drv } = fakeSql(() => ({ rows: [
    { value: '0000009002', falt: '20261001', fbaj: '0', tipo: 'A', fech: '20261001', hora: '0905', usua: 'SMO' },
    { value: '0000009001', falt: '20250101', fbaj: '20250930', tipo: 'B', fech: '20250930', hora: '1800', usua: 'ABC' }
  ] }));
  const [a, b] = await drv.personalHistory('1000000001').then((h: any) => h.card);
  assert.deepEqual(a, { value: '0000009002', from: '2026-10-01', to: '', type: 'A', active: true, recordedAt: '2026-10-01 09:05', user: 'SMO' });
  assert.equal(b.active, false);
  assert.equal(b.to, '2025-09-30');
});

test('SQL Server: no elimina si el empleado tiene marcajes', async () => {
  const { drv, calls } = fakeSql((text) => {
    if (text.includes('INFORMATION_SCHEMA.COLUMNS')) return { rows: [{ t: 'MARCAPRES', c: 'MP_CODI' }, { t: 'PERSONALACCESO', c: 'PA_CODIEMP' }] };
    if (text.includes('UNION ALL') || text.includes('COUNT(*)')) return { rows: [{ what: 'marcajes de presencia', n: 3 }, { what: 'accesos asignados', n: 0 }] };
  });
  await assert.rejects(drv.deletePersonal('1000000001'), (e: any) => e.status === 409 && /marcajes de presencia \(3\)/.test(e.message));
  assert.ok(!calls.some((c) => c.text.startsWith('DELETE')));
});

test('SQL Server: elimina si no hay datos relacionados', async () => {
  const { drv, calls } = fakeSql((text) => {
    if (text.includes('INFORMATION_SCHEMA.COLUMNS')) return { rows: [{ t: 'MARCAPRES', c: 'MP_CODI' }] };
    if (text.includes('COUNT(*)')) return { rows: [{ what: 'marcajes de presencia', n: 0 }] };
  });
  await drv.deletePersonal('1000000001');
  const iHis = calls.findIndex((c) => c.text.startsWith('DELETE FROM [HIS_TARJETA] WHERE [HT_PCOD] = @code'));
  const iPer = calls.findIndex((c) => c.text.startsWith('DELETE FROM [PERSONAL] WHERE [EM_CODI] = @code'));
  assert.ok(iHis >= 0 && iPer > iHis, 'borra sus asignaciones y después el empleado');
  assert.ok(!calls.some((c) => c.text.includes('DELETE FROM [TARJETA]')), 'las tarjetas se conservan');
});

test('SQL Server: lectura convierte fechas aaaammdd y calcula activo', async () => {
  const { drv } = fakeSql((text) => (text.startsWith('SELECT') ? { rows: [{ code: '1000000001 ', name: 'ANA', hireDate: '20261001', endDate: null, active: 1 }] } : undefined));
  const [e] = await drv.listPersonal();
  assert.equal(e.code, '1000000001');
  assert.equal(e.hireDate, '2026-10-01');
  assert.equal(e.endDate, '');
  assert.equal(e.active, true);
});

// ---------- Organización: empresa, departamento, sección y área ----------

test('códigos automáticos y día anterior', () => {
  assert.equal(nextCode([], 15), '1');
  assert.equal(nextCode(['ADMIN', 'RRHH'], 15), '1');
  assert.equal(nextCode(['1', '2', '10', 'X'], 15), '11');
  assert.equal(nextCode(['001', '007'], 15), '008');
  assert.throws(() => nextCode(['99'], 2));
  assert.equal(prevDay('2026-03-01'), '2026-02-28');
  assert.equal(prevDay('2026-01-01'), '2025-12-31');
});

test('código de empleado: 10 dígitos solo números; tarjeta: 10 caracteres alfanuméricos en mayúsculas; ambos con ceros', () => {
  const p = sanitizePersonal({ ...BASE, code: '42', card: ' 1234 ' }, opts);
  assert.equal(p.code, '0000000042');
  assert.equal(p.card, '0000001234');
  assert.equal(sanitizePersonal({ ...BASE, code: '1234567890' }, opts).code, '1234567890');
  assert.equal(status(() => sanitizePersonal({ ...BASE, code: '12345678901' }, opts)), 400, 'más de 10 dígitos');
  assert.equal(status(() => sanitizePersonal({ ...BASE, code: 'A12' }, opts)), 400, 'letras en el código');
  assert.equal(status(() => sanitizePersonal({ ...BASE, card: '12-34' }, opts)), 400, 'símbolos en la tarjeta');
  assert.equal(sanitizePersonal({ ...BASE, card: 'ab12' }, opts).card, '000000AB12', 'la tarjeta admite letras, en mayúsculas y con ceros');
  assert.equal(status(() => sanitizePersonal({ ...BASE, card: 'ABCDEFGHIJK' }, opts)), 400, 'más de 10 caracteres en la tarjeta');
  assert.equal(status(() => sanitizePersonal({ ...BASE, card: '' }, opts)), 400, 'tarjeta obligatoria');
});

test('validación: nombres escritos en el alta → código existente o nombre nuevo', () => {
  const emp = sanitizePersonal({ ...BASE, company: '', department: '' }, opts);
  const names = sanitizeNewNames({ company: 'primion', department: '  logística   norte ' }, emp, { uppercase: true, lookups: LOOKUPS });
  assert.equal(emp.company, 'PRI'); // coincide con el nombre de una existente
  assert.deepEqual(names, { department: 'LOGÍSTICA NORTE' });
  assert.deepEqual(sanitizeOrgValue({ name: 'informática' }, 'department', { uppercase: true, lookups: LOOKUPS }), { code: 'IT' });
  assert.deepEqual(sanitizeOrgValue({ name: 'Nuevo' }, 'department', { uppercase: true, lookups: LOOKUPS }), { name: 'NUEVO' });
  assert.equal(status(() => sanitizeOrgValue({ code: 'XX' }, 'department', { uppercase: true, lookups: LOOKUPS })), 400);
});

test('demo: alta con un departamento nuevo lo crea y abre su tramo', async () => {
  const d = new DemoDriver('co-org-1');
  const emp = sanitizePersonal({ ...BASE, code: '1000000031', card: '0000009301', company: '', department: '', section: '', area: '' }, opts);
  await d.createPersonal(emp, STAMP, { department: 'CALIDAD' });
  const dep = (await d.personalLookups()).department!.find((x) => x.description === 'CALIDAD')!;
  assert.ok(dep, 'se crea en DEPMENTO');
  assert.equal((await d.getPersonal('1000000031'))?.department, dep.code);
  const [t] = (await d.personalHistory('1000000031')).department;
  assert.deepEqual({ value: t.value, from: t.from, to: t.to, type: t.type }, { value: dep.code, from: '2026-10-01', to: '', type: 'A' });
});

test('demo: cambiar de departamento cierra el anterior el día antes; solo uno vigente', async () => {
  const d = new DemoDriver('co-org-2');
  const deps = (await d.personalLookups()).department!;
  const [d1, d2, d3] = deps.map((x) => x.code);
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000041', card: '0000009302', department: '', hireDate: '2026-01-01' }, opts), STAMP);
  await d.assignHistory('department', '1000000041', { code: d1 }, '2026-01-01', STAMP);
  await assert.rejects(d.assignHistory('department', '1000000041', { code: d1 }, '2026-05-01', STAMP), (e: any) => e.status === 409 && /ya está/.test(e.message));
  await assert.rejects(d.assignHistory('department', '1000000041', { code: d2 }, '2026-01-01', STAMP), (e: any) => e.status === 409 && /posterior/.test(e.message));

  await d.assignHistory('department', '1000000041', { code: d2 }, '2026-06-01', STAMP);
  const h = (await d.personalHistory('1000000041')).department;
  const old = h.find((x) => x.value === d1)!;
  const cur = h.find((x) => x.value === d2)!;
  assert.equal(old.to, '2026-05-31');
  assert.equal(old.type, 'B');
  assert.equal(old.active, false);
  assert.equal(cur.to, '');
  assert.equal(h.filter((x) => !x.to).length, 1, 'un único tramo abierto');
  assert.equal((await d.getPersonal('1000000041'))?.department, d2);

  // Un nombre nuevo desde la ficha también se crea.
  await d.assignHistory('department', '1000000041', { name: 'I+D' }, '2026-09-01', STAMP);
  const nuevo = (await d.personalLookups()).department!.find((x) => x.description === 'I+D')!;
  assert.equal((await d.getPersonal('1000000041'))?.department, nuevo.code);
  assert.equal((await d.personalHistory('1000000041')).department.find((x) => x.value === d2)!.to, '2026-08-31');

  // Quitar: cierra el vigente y deja el campo vacío.
  await d.closeHistory('department', '1000000041', nuevo.code, '2026-09-01', '2026-09-15', { ...STAMP, date: '20261007' });
  assert.equal((await d.getPersonal('1000000041'))?.department, '');
  void d3;
});

test('demo: varios empleados pueden compartir departamento (a diferencia de las tarjetas)', async () => {
  const d = new DemoDriver('co-org-3');
  const dep = (await d.personalLookups()).department![0].code;
  const o = { ...opts, lookups: await d.personalLookups() };
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000051', card: '0000009303', company: '', area: '', department: dep }, o), STAMP);
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000052', card: '0000009304', company: '', area: '', department: dep }, o), STAMP);
  assert.equal((await d.personalHistory('1000000052')).department[0].value, dep);
});

test('SQL Server: cambiar de departamento cierra el abierto el día antes, abre el nuevo y actualiza EM_DEPA', async () => {
  const { drv, calls } = fakeSql((text) => {
    if (text.startsWith('SELECT p.')) return { rows: [{ code: '1000000001' }] };
    if (text.includes('FROM [HIS_DEPMENTO] WITH (UPDLOCK, HOLDLOCK)')) return { rows: [{ value: 'IT', falt: '20260101' }] };
    return { rows: [] };
  });
  await drv.assignHistory('department', '1000000001', { code: 'RRHH' }, '2026-10-07', STAMP);
  const close = calls.find((c) => c.text.startsWith('UPDATE [HIS_DEPMENTO]'))!;
  assert.match(close.text, /SET \[HD_FBAJ\] = @to, \[HD_TIPO\] = 'B'/);
  assert.equal(close.params.to, '20261006');
  const iClose = calls.indexOf(close);
  const iIns = calls.findIndex((c) => c.text.startsWith('INSERT INTO [HIS_DEPMENTO]'));
  const iSync = calls.findIndex((c) => c.text.startsWith('UPDATE [PERSONAL] SET [EM_DEPA]'));
  assert.ok(iClose < iIns && iIns < iSync, 'cierra, abre y sincroniza en ese orden');
  assert.equal(calls[iIns].params.value, 'RRHH');
});

test('SQL Server: no deja abrir un tramo anterior o igual al vigente', async () => {
  const { drv, calls } = fakeSql((text) => {
    if (text.startsWith('SELECT p.')) return { rows: [{ code: '1000000001' }] };
    if (text.includes('FROM [HIS_DEPMENTO] WITH (UPDLOCK, HOLDLOCK)')) return { rows: [{ value: 'IT', falt: '20261007' }] };
    return { rows: [] };
  });
  await assert.rejects(drv.assignHistory('department', '1000000001', { code: 'RRHH' }, '2026-10-07', STAMP), (e: any) => e.status === 409 && /posterior/.test(e.message));
  assert.ok(!calls.some((c) => c.text.startsWith('UPDATE') || c.text.startsWith('INSERT')));
});

test('SQL Server: un departamento nuevo se crea con el siguiente código libre', async () => {
  const { drv, calls } = fakeSql((text) => {
    if (text.startsWith('SELECT p.')) return { rows: [{ code: '1000000001' }] };
    if (text.includes('FROM [DEPMENTO] WITH (UPDLOCK, HOLDLOCK)')) return { rows: [{ code: '001', description: 'ADMIN' }, { code: '007', description: 'RRHH' }] };
    return { rows: [] };
  });
  await drv.assignHistory('department', '1000000001', { name: 'CALIDAD' }, '2026-10-07', STAMP);
  const ins = calls.find((c) => c.text.startsWith('INSERT INTO [DEPMENTO]'))!;
  assert.deepEqual(ins.params, { code: '008', name: 'CALIDAD' });
  assert.equal(calls.find((c) => c.text.startsWith('INSERT INTO [HIS_DEPMENTO]'))!.params.value, '008');
  // Si ya existe con ese nombre, se reutiliza.
  const { drv: d2, calls: c2 } = fakeSql((text) => {
    if (text.startsWith('SELECT p.')) return { rows: [{ code: '1000000001' }] };
    if (text.includes('FROM [DEPMENTO] WITH (UPDLOCK, HOLDLOCK)')) return { rows: [{ code: '007', description: 'Calidad' }] };
    return { rows: [] };
  });
  await d2.assignHistory('department', '1000000001', { name: 'CALIDAD' }, '2026-10-07', STAMP);
  assert.ok(!c2.some((c) => c.text.startsWith('INSERT INTO [DEPMENTO]')));
  assert.equal(c2.find((c) => c.text.startsWith('INSERT INTO [HIS_DEPMENTO]'))!.params.value, '007');
});

test('SQL Server: modificar la ficha no toca tarjeta ni organización', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [] }), { hireDate: '20261001' });
  const { code: _c, ...rest } = sanitizePersonal(BASE, opts);
  await drv.updatePersonal('1000000001', rest, STAMP);
  const set = calls.find((c) => c.text.startsWith('UPDATE'))!.text;
  assert.ok(!/EM_TARJ|EM_CEMP|EM_DEPA|EM_SECC|EM_AREA/.test(set), set);
  assert.match(set, /EM_NOMB/);
});

test('SQL Server: eliminar borra también sus históricos de organización', async () => {
  const { drv, calls } = fakeSql((text) => (text.includes('INFORMATION_SCHEMA.COLUMNS') ? { rows: [] } : undefined));
  await drv.deletePersonal('1000000001');
  assert.ok(calls.some((c) => c.text === 'DELETE FROM [HIS_DEPMENTO] WHERE [HD_PCOD] = @code'));
  assert.ok(!calls.some((c) => c.text.includes('DELETE FROM [DEPMENTO]')));
});

// ---------- Baja del empleado: cierra todas sus asignaciones ----------

test('demo: al dar de baja al empleado se cierran todos sus tramos con la fecha de baja', async () => {
  const d = new DemoDriver('co-baja-1');
  const o = { ...opts, lookups: await d.personalLookups() };
  const dep = o.lookups.department![0].code;
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000021', card: '0000009401', company: '', area: '', department: dep, hireDate: '2026-01-01' }, o), STAMP);
  await d.assignHistory('card', '1000000021', { code: '0000009402' }, '2026-02-01', STAMP);
  await d.assignHistory('card', '1000000021', { code: '0000009403' }, '2026-03-01', STAMP);
  await d.closeHistory('card', '1000000021', '0000009403', '2026-03-01', '2026-12-31', STAMP); // cerrada después de la baja → se acorta
  await d.closeHistory('card', '1000000021', '0000009402', '2026-02-01', '2026-02-15', STAMP); // cerrada antes → no se toca

  const { code: _c, ...rest } = sanitizePersonal({ ...BASE, company: '', area: '', department: '', endDate: '2026-09-30', hireDate: '2026-01-01' }, { ...o, code: '1000000021' });
  await d.updatePersonal('1000000021', rest, { date: '20261007', time: '1630', user: 'SMO' });
  const h = await d.personalHistory('1000000021');
  const card = (v: string) => h.card.find((x) => x.value === v)!;
  assert.equal(card('0000009401').to, '2026-09-30');
  assert.equal(card('0000009401').type, 'B');
  assert.equal(card('0000009403').to, '2026-09-30');
  assert.equal(card('0000009402').to, '2026-02-15');
  assert.equal(h.department[0].to, '2026-09-30');
  assert.equal(h.department[0].user, 'SMO');
  assert.ok([...h.card, ...h.department].every((x) => x.to), 'no queda ningún tramo abierto');
  // Los campos EM_* conservan el último valor.
  assert.equal((await d.getPersonal('1000000021'))?.department, dep);
  // La tarjeta queda libre para otro empleado desde el día siguiente.
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000022', card: '0000009401', company: '', area: '', department: '', hireDate: '2026-10-01' }, o), STAMP);
});

test('demo: no deja dar de baja antes de un tramo que empieza después', async () => {
  const d = new DemoDriver('co-baja-2');
  const o = { ...opts, lookups: await d.personalLookups() };
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000023', card: '0000009430', company: '', area: '', department: '', hireDate: '2026-01-01' }, o), STAMP);
  await d.assignHistory('card', '1000000023', { code: '0000009431' }, '2026-11-01', STAMP);
  const { code: _c, ...rest } = sanitizePersonal({ ...BASE, company: '', area: '', department: '', endDate: '2026-10-15', hireDate: '2026-01-01' }, { ...o, code: '1000000023' });
  await assert.rejects(d.updatePersonal('1000000023', rest, STAMP), (e: any) => e.status === 409 && /0000009431/.test(e.message));
  assert.equal((await d.personalHistory('1000000023')).card.find((x) => x.value === '0000009430')!.to, '', 'no se ha cerrado nada');
});

test('demo: alta con fecha de baja deja sus tramos cerrados', async () => {
  const d = new DemoDriver('co-baja-3');
  const o = { ...opts, lookups: await d.personalLookups() };
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000024', card: '0000009440', company: '', area: '', department: '', hireDate: '2026-01-01', endDate: '2026-06-30' }, o), STAMP);
  const [t] = (await d.personalHistory('1000000024')).card;
  assert.deepEqual({ from: t.from, to: t.to, type: t.type }, { from: '2026-01-01', to: '2026-06-30', type: 'B' });
});

test('SQL Server: la baja cierra los tramos abiertos de todos los históricos en la misma transacción', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [], affected: 1 }), { hireDate: '20261001' });
  let inTx = 0;
  const orig = drv.inTx;
  drv.inTx = async (fn: any) => { inTx++; return orig(fn); };
  const { code: _c, ...rest } = sanitizePersonal({ ...BASE, endDate: '2026-10-31' }, opts);
  await drv.updatePersonal('1000000001', rest, STAMP);
  assert.equal(inTx, 1);
  const upd = calls.filter((c) => /^UPDATE \[HIS_(TARJETA|DEPMENTO)\]/.test(c.text));
  assert.equal(upd.length, 2, 'tarjetas y departamento (los que existen en la BD simulada)');
  const vig = calls.find((c) => c.text.startsWith('UPDATE [HIS_VIGENCIA]'))!;
  assert.match(vig.text, /SET \[HV_FBAJ\] = @end, \[HV_TIPO\] = 'B'/);
  assert.equal(vig.params.end, '20261031');
  const dep = upd.find((c) => c.text.includes('HIS_DEPMENTO'))!;
  assert.match(dep.text.replace(/\s+/g, ' '), /SET \[HD_FBAJ\] = @end, \[HD_TIPO\] = 'B', \[HD_FECH\] = @fech, \[HD_HORA\] = @hora, \[HD_USUA\] = @usua WHERE \[HD_PCOD\] = @code AND \(\(\[HD_FBAJ\] IS NULL OR LTRIM\(RTRIM\(\[HD_FBAJ\]\)\) IN \('', '0'\)\) OR \[HD_FBAJ\] > @end\)/);
  assert.deepEqual(dep.params, { code: '1000000001', end: '20261031', fech: '20261007', hora: '1559', usua: 'SMO' });
  // Sin fecha de baja no se toca ningún histórico.
  const { drv: d2, calls: c2 } = fakeSql(() => ({ rows: [], affected: 1 }), { hireDate: '20261001' });
  const { code: _c2, ...rest2 } = sanitizePersonal(BASE, opts);
  await d2.updatePersonal('1000000001', rest2, STAMP);
  assert.ok(!c2.some((c) => c.text.includes('HIS_')), 'sin baja nueva no se toca ningún histórico');
});

test('SQL Server: la baja se rechaza si hay tramos que empiezan después', async () => {
  const { drv, calls } = fakeSql((text) => (text.includes('[HT_FALT] > @end') ? { rows: [{ value: '0000009009', falt: '20261101' }] } : { rows: [], affected: 1 }), { hireDate: '20261001' });
  const { code: _c, ...rest } = sanitizePersonal({ ...BASE, endDate: '2026-10-31' }, opts);
  await assert.rejects(drv.updatePersonal('1000000001', rest, STAMP), (e: any) => e.status === 409 && /la tarjeta 0000009009 \(desde el 01\/11\/2026\)/.test(e.message));
  assert.ok(!calls.some((c) => /^UPDATE \[HIS_/.test(c.text)));
});

// ---------- Periodos de alta (HIS_VIGENCIA) y volver a dar de alta ----------

test('reglas: la baja de un empleado de baja solo se puede adelantar; readmisión posterior a la baja', async () => {
  const { checkEndChange, checkReadmit } = await import('./evalos/history.ts');
  assert.doesNotThrow(() => checkEndChange('E', '', '2026-10-01'));
  assert.doesNotThrow(() => checkEndChange('E', '2026-10-01', '2026-09-01'));
  assert.doesNotThrow(() => checkEndChange('E', '2026-10-01', '2026-10-01'));
  assert.throws(() => checkEndChange('E', '2026-10-01', ''), /Volver a dar de alta/);
  assert.throws(() => checkEndChange('E', '2026-10-01', '2026-10-02'), /adelantar/);
  assert.throws(() => checkReadmit('E', '', '2026-10-02'), /no está de baja/);
  assert.throws(() => checkReadmit('E', '2026-10-01', '2026-10-01'), /posterior/);
  assert.doesNotThrow(() => checkReadmit('E', '2026-10-01', '2026-10-02'));
});

test('demo: alta, baja y readmisión con formulario vacío', async () => {
  const d = new DemoDriver('co-readmit');
  const o = { ...opts, lookups: await d.personalLookups() };
  const [dep1, dep2] = o.lookups.department!.map((x) => x.code);
  await d.createPersonal(sanitizePersonal({ ...BASE, code: '1000000061', card: '0000009101', company: '', area: '', department: dep1, hireDate: '2025-01-01' }, o), STAMP);
  assert.deepEqual((await d.personalPeriods('1000000061')).map((p) => [p.from, p.to, p.type]), [['2025-01-01', '', 'A']]);

  const base = { ...BASE, company: '', area: '', department: '', hireDate: '2025-01-01' };
  const { code: _a, ...baja } = sanitizePersonal({ ...base, endDate: '2025-12-31' }, { ...o, code: '1000000061' });
  await d.updatePersonal('1000000061', baja, STAMP);
  assert.deepEqual((await d.personalPeriods('1000000061')).map((p) => [p.from, p.to, p.type]), [['2025-01-01', '2025-12-31', 'B']]);
  // Ya de baja: no se puede quitar ni retrasar la baja.
  const { code: _b, ...sinBaja } = sanitizePersonal(base, { ...o, code: '1000000061' });
  await assert.rejects(d.updatePersonal('1000000061', sinBaja, STAMP), (e: any) => e.status === 409 && /Volver a dar de alta/.test(e.message));
  await assert.rejects(d.readmitPersonal('1000000061', { hireDate: '2025-12-31', card: '0000009102', company: '', department: '', section: '', area: '' }, STAMP), (e: any) => e.status === 409);

  // Readmisión: nuevo periodo y asignaciones nuevas desde la fecha (las anteriores siguen cerradas).
  await d.readmitPersonal('1000000061', { hireDate: '2026-03-01', card: '0000009102', company: '', department: dep2, section: '', area: '' }, STAMP, { area: 'ZONA SUR' });
  const e = (await d.getPersonal('1000000061'))!;
  assert.equal(e.hireDate, '2026-03-01');
  assert.equal(e.endDate, '');
  assert.equal(e.active, true);
  assert.equal(e.card, '0000009102');
  assert.equal(e.department, dep2);
  assert.equal(e.company, '', 'formulario vacío: lo que no se indica queda vacío');
  const periods = await d.personalPeriods('1000000061');
  assert.deepEqual(periods.map((p) => [p.from, p.to, p.type]), [['2026-03-01', '', 'A'], ['2025-01-01', '2025-12-31', 'B']]);
  const h = await d.personalHistory('1000000061');
  assert.deepEqual(h.card.map((x) => [x.value, x.from, x.to]), [['0000009102', '2026-03-01', ''], ['0000009101', '2025-01-01', '2025-12-31']]);
  assert.deepEqual(h.department.map((x) => [x.value, x.from, x.to]), [[dep2, '2026-03-01', ''], [dep1, '2025-01-01', '2025-12-31']]);
  const sur = (await d.personalLookups()).area!.find((x) => x.description === 'ZONA SUR')!;
  assert.equal(h.area[0].value, sur.code, 'el área nueva se crea');
  await assert.rejects(d.readmitPersonal('1000000061', { hireDate: '2026-05-01', card: '0000009999', company: '', department: '', section: '', area: '' }, STAMP), (e: any) => /no está de baja/.test(e.message));
});

test('SQL Server: el alta abre el periodo en HIS_VIGENCIA', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [] }));
  await drv.createPersonal(sanitizePersonal(BASE, opts), STAMP);
  const v = calls.find((c) => c.text.startsWith('INSERT INTO [HIS_VIGENCIA]'))!;
  assert.match(v.text, /VALUES \(@code, @from, '0', 'A', @fech, @hora, @usua\)/);
  assert.equal(v.params.from, '20261001');
});

test('SQL Server: readmitir abre periodo y tramos nuevos, deja EM_FBAJ vacía y en una transacción', async () => {
  const { drv, calls } = fakeSql(() => ({ rows: [], affected: 0 }), { hireDate: '20250101', endDate: '20251231' });
  let inTx = 0;
  const orig = drv.inTx;
  drv.inTx = async (fn: any) => { inTx++; return orig(fn); };
  await drv.readmitPersonal('1000000001', { hireDate: '2026-03-01', card: '0000009005', company: '', department: 'IT', section: '', area: '' }, STAMP);
  assert.equal(inTx, 1);
  const upd = calls.find((c) => c.text.startsWith('UPDATE [PERSONAL] SET'))!;
  const cols = [...upd.text.matchAll(/\[(EM_\w+)\] = @(v\d+)/g)].reduce((m, [, c, p]) => ({ ...m, [c]: upd.params[p] }), {} as Record<string, unknown>);
  assert.deepEqual(cols, { EM_FALT: '20260301', EM_FBAJ: null, EM_TARJ: '0000009005', EM_CEMP: null, EM_DEPA: 'IT', EM_SECC: null, EM_AREA: null });
  const iUpd = calls.indexOf(upd);
  const vig = calls.findIndex((c) => c.text.startsWith('INSERT INTO [HIS_VIGENCIA]') && c.params.from === '20260301');
  const card = calls.findIndex((c) => c.text.startsWith('INSERT INTO [HIS_TARJETA]') && c.params.value === '0000009005' && c.params.from === '20260301');
  const dep = calls.findIndex((c) => c.text.startsWith('INSERT INTO [HIS_DEPMENTO]') && c.params.value === 'IT' && c.params.from === '20260301');
  assert.ok(vig > iUpd && card > iUpd && dep > iUpd, calls.map((c) => c.text.slice(0, 30)).join(' | '));
  // Antes se aseguran cerrados los tramos anteriores a la fecha de baja.
  assert.ok(calls.some((c, i) => i < iUpd && c.text.startsWith('UPDATE [HIS_TARJETA]') && c.params.end === '20251231'));
});

test('SQL Server: readmitir rechaza a un empleado activo o una fecha no posterior a la baja', async () => {
  const { drv } = fakeSql(() => ({ rows: [] }), { hireDate: '20250101', endDate: null });
  await assert.rejects(drv.readmitPersonal('1000000001', { hireDate: '2026-03-01', card: '0000009005', company: '', department: '', section: '', area: '' }, STAMP), (e: any) => e.status === 409 && /no está de baja/.test(e.message));
  const { drv: d2, calls } = fakeSql(() => ({ rows: [] }), { hireDate: '20250101', endDate: '20251231' });
  await assert.rejects(d2.readmitPersonal('1000000001', { hireDate: '2025-12-31', card: '0000009005', company: '', department: '', section: '', area: '' }, STAMP), (e: any) => e.status === 409 && /posterior/.test(e.message));
  assert.ok(!calls.some((c) => c.text.startsWith('UPDATE') || c.text.startsWith('INSERT')));
});

test('validación: consultas y solicitudes solo admiten valores existentes de KIOSKO y WORKFLOW', () => {
  assert.equal(sanitizePersonal(BASE, opts).consultas, '001');
  assert.equal(status(() => sanitizePersonal({ ...BASE, consultas: '999' }, opts)), 400);
  assert.equal(status(() => sanitizePersonal({ ...BASE, solicitudes: 'XX' }, opts)), 400);
  const sinTabla = { ...opts, lookups: { ...LOOKUPS, consultas: null } };
  assert.equal(status(() => sanitizePersonal({ ...BASE, consultas: '001' }, sinTabla)), 400);
  assert.equal(status(() => sanitizePersonal({ ...BASE, consultas: '' }, sinTabla)), 0);
});

// ---------- Alta de usuario del portal como empleado y acceso a Evalos (USUARIOS) por rol ----------

test('usuarios: alta como empleado vinculado y sincronización de nombre y email', async () => {
  const { putConfig } = await import('./evalos/config.ts');
  const { createLinkedEmployee, syncLinkedEmployee, employeeFormInfo } = await import('./evalos/employees.ts');
  await putConfig({ companyId: 'co-users', engine: 'demo', mapping: DEFAULT_MAPPING, uppercase: true, updatedAt: '' } as any);
  const info = await employeeFormInfo('co-users');
  assert.equal(info.configured, true);
  assert.ok(info.configured && info.lookups.department!.length > 0);

  const code = await createLinkedEmployee('co-users', 'admin@primion.es',
    { code: '1000000071', card: '0000009201', hireDate: '2026-10-07', newNames: { department: 'Soporte' } }, 'Ana García Pérez', 'ana@primion.es');
  assert.equal(code, '1000000071');
  const d = new DemoDriver('co-users');
  const e = (await d.getPersonal('1000000071'))!;
  assert.equal(e.name, 'ANA GARCÍA PÉREZ');
  assert.equal(e.email, 'ANA@PRIMION.ES');
  assert.equal(e.card, '0000009201');
  const dep = (await d.personalLookups()).department!.find((x) => x.description === 'SOPORTE')!;
  assert.equal(e.department, dep.code, 'el departamento escrito se crea');
  assert.equal((await d.personalPeriods('1000000071')).length, 1);

  // Faltan datos de empleado → no se crea nada.
  await assert.rejects(createLinkedEmployee('co-users', 'admin@primion.es', { code: '1000000072', hireDate: '2026-10-07' }, 'Luis', 'luis@primion.es'), (e: any) => e.status === 400 && /tarjeta/.test(e.message));
  assert.equal(await d.getPersonal('1000000072'), null);

  await syncLinkedEmployee('co-users', '1000000071', 'Ana García López', 'ana.garcia@primion.es');
  const e2 = (await d.getPersonal('1000000071'))!;
  assert.equal(e2.name, 'ANA GARCÍA LÓPEZ');
  assert.equal(e2.email, 'ANA.GARCIA@PRIMION.ES');
});

test('usuarios: sin conexión con Evalos el formulario no ofrece el alta como empleado', async () => {
  const { employeeFormInfo } = await import('./evalos/employees.ts');
  assert.deepEqual(await employeeFormInfo('co-sin-evalos'), { configured: false });
});

test('usuarios: solo los roles distintos de «Usuario» tienen acceso a Evalos (USUARIOS)', async () => {
  const { wantsEvalosAccess, deprovisionEvalosUser } = await import('./evalos/users.ts');
  assert.equal(wantsEvalosAccess({ role: 'user' }), false);
  assert.equal(wantsEvalosAccess({ role: 'admin' }), true);
  assert.equal(wantsEvalosAccess({ role: 'superadmin' }), true);
  // Al bajar a «Usuario» se le quita el acceso (en demo no hay tabla USUARIOS real: solo se limpia el enlace).
  const db = await import('./db.ts');
  const u = { id: db.id(), companyId: 'co-users', email: 'jefe@primion.es', firstName: 'Jefe', lastName: '', passwordHash: 'x', role: 'user', groupIds: [], status: 'active', sessionVersion: 1, createdAt: '', evalos: { initials: 'JEF', at: '' } } as any;
  await db.Users.put(u);
  const after = await deprovisionEvalosUser(u, null);
  assert.equal(after.evalos, undefined);
  assert.equal((await db.Users.get(u.id))?.evalos, undefined);
});


test('SQL Server: incidencias de INCIDENC (código y descripción) para Correcciones', async () => {
  TABLES.INCIDENC = [col('IN_CODI', 'nvarchar', 3, false), col('IN_DESC', 'nvarchar', 40)];
  const { drv, calls } = fakeSql((text) => (text.includes('FROM [INCIDENC]') ? { rows: [{ code: '002 ', name: 'MEDICO ' }, { code: '001', name: 'ASUNTOS PROPIOS' }] } : { rows: [] }));
  assert.deepEqual(await drv.listIncidences(), [{ code: '002', name: 'MEDICO' }, { code: '001', name: 'ASUNTOS PROPIOS' }]);
  assert.match(calls[0].text, /SELECT RTRIM\(\[IN_CODI\]\) AS code, RTRIM\(ISNULL\(\[IN_DESC\], ''\)\) AS name, '' AS type FROM \[INCIDENC\] ORDER BY \[IN_CODI\]/);
  delete TABLES.INCIDENC;
});

test('SQL Server: incidencias de tipo A (IN_TIPO) para las ausencias', async () => {
  TABLES.INCIDENC = [col('IN_CODI', 'nvarchar', 3, false), col('IN_DESC', 'nvarchar', 40), col('IN_TIPO', 'nvarchar', 1)];
  const { drv, calls } = fakeSql((text, params) => (text.includes('FROM [INCIDENC]') && params.tipo === 'A' ? { rows: [{ code: '004', name: 'MEDICO' }] } : { rows: [] }));
  assert.deepEqual(await drv.listIncidences('a'), [{ code: '004', name: 'MEDICO' }]);
  assert.match(calls[0].text, /UPPER\(LTRIM\(RTRIM\(ISNULL\(\[IN_TIPO\], ''\)\)\)\) AS type FROM \[INCIDENC\]/);
  assert.match(calls[0].text, /WHERE UPPER\(LTRIM\(RTRIM\(\[IN_TIPO\]\)\)\) = @tipo ORDER BY \[IN_CODI\]/);
  delete TABLES.INCIDENC;
});

test('colores de Evalos a #rrggbb', async () => {
  const { evalosColor } = await import('./evalos/mssql.ts');
  assert.equal(evalosColor('000066'), '#000066');
  assert.equal(evalosColor('#FF8800'), '#ff8800');
  assert.equal(evalosColor(-16776961), '#0000ff');   // ARGB .NET (azul opaco)
  assert.equal(evalosColor(255), '#ff0000');         // BGR OLE (rojo)
  assert.equal(evalosColor(''), null);
  assert.equal(evalosColor(null), null);
});

test('SQL Server: descripciones y colores de turnos, vacaciones e incidencias', async () => {
  TABLES.GESTURNO = [col('TN_CODI', 'nvarchar', 3, false), col('TN_DESC', 'nvarchar', 40), col('TN_COLO', 'nvarchar', 10)];
  TABLES.TIPOSVACACIONES = [col('CODIGO', 'nvarchar', 3, false), col('DESCRIPCION', 'nvarchar', 40), col('COLOR', 'int', null)];
  TABLES.INCIDENC = [col('IN_CODI', 'nvarchar', 3, false), col('IN_DESC', 'nvarchar', 40)];
  const { drv } = fakeSql((text) => {
    if (text.includes('[GESTURNO]')) return { rows: [{ code: 'DEF', name: 'TURNO GENERAL', color: '000066' }] };
    if (text.includes('[TIPOSVACACIONES]')) return { rows: [{ code: 'V1', name: 'VACACIONES 2026', color: '255' }] };
    if (text.includes('[INCIDENC]')) return { rows: [{ code: '003', name: 'MEDICO', color: null }] };
    return { rows: [] };
  });
  assert.deepEqual(await drv.dayLabels(), {
    shifts: [{ code: 'DEF', name: 'TURNO GENERAL', color: '#000066' }],
    holidays: [{ code: 'V1', name: 'VACACIONES 2026', color: '#ff0000' }],
    absences: [{ code: '003', name: 'MEDICO', color: null }]
  });
  delete TABLES.GESTURNO; delete TABLES.TIPOSVACACIONES; delete TABLES.INCIDENC;
});

test('SQL Server: alta de tipo de vacaciones con las opciones que marca Evalos', async () => {
  TABLES.TIPOSVACACIONES = [
    col('CODIGO', 'nvarchar', 3, false), col('DESCRIPCION', 'nvarchar', 40), col('COLOR', 'int', null),
    col('TEORICAS_HORARIO', 'char', 1), col('TEORICAS_VACACIONES', 'char', 1), col('FESTIVO', 'char', 1, false),
    col('PERMITIRDIA', 'char', 1), col('PERMITIRMEDIODIA', 'char', 1), col('PERMITIRHORAS', 'char', 1),
    col('HORASDISPO', 'bit', null, false), col('DIASTRIENIO', 'int', null), col('MAXDAYS', 'nvarchar', 5), col('OTRA', 'int', null, false)
  ];
  const { drv, calls } = fakeSql((text) => {
    if (text.includes('SELECT TOP (20)')) return { rows: [{ v: '255' }] };
    if (text.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
    if (text.includes('SELECT TOP (1) *')) return { rows: [{ CODIGO: 'V27' }] };
  });
  const res = await drv.createVacationType({ code: 'V27', name: 'VACACIONES 2027', color: '#0000ff' });
  const ins = calls.find((c) => c.text.startsWith('INSERT INTO [TIPOSVACACIONES]'))!;
  const cols = ins.text.match(/\(([^)]*)\) VALUES/)![1].split(', ').map((x) => x.replace(/[[\]]/g, ''));
  const val = (c: string) => ins.params[`p${cols.indexOf(c)}`];
  assert.equal(val('CODIGO'), 'V27');
  assert.equal(val('COLOR'), 16711680); // OLE (BGR), como las filas que ya hay
  assert.equal(val('TEORICAS_HORARIO'), 'S');
  assert.equal(val('TEORICAS_VACACIONES'), 'N');
  assert.equal(val('FESTIVO'), 'N');
  assert.equal(val('PERMITIRDIA'), 'S');
  assert.equal(val('PERMITIRMEDIODIA'), 'S');
  assert.equal(val('PERMITIRHORAS'), 'S');
  assert.equal(val('HORASDISPO'), 0);
  assert.equal(val('DIASTRIENIO'), null);
  assert.equal(val('MAXDAYS'), '');
  assert.equal(val('OTRA'), 0);
  assert.deepEqual(res.filled, ['OTRA']);
  delete TABLES.TIPOSVACACIONES;
});

test('ficha: el convenio solo admite convenios existentes y se guarda en EM_CONV', async () => {
  assert.equal(sanitizePersonal({ ...BASE, convenio: 'METAL' }, opts).convenio, 'METAL');
  assert.equal(sanitizePersonal(BASE, opts).convenio, '');
  assert.throws(() => sanitizePersonal({ ...BASE, convenio: 'XX' }, opts), /El convenio XX no existe/);
  assert.throws(() => sanitizePersonal({ ...BASE, convenio: 'METAL' }, { ...opts, lookups: { ...LOOKUPS, convenio: null } }), /convenio no se puede asignar/);
  TABLES.PERSONAL.push(col('EM_CONV', 'nvarchar', 10));
  const { drv, calls } = fakeSql(() => ({ rows: [] }), { name: 'X', hireDate: '20260101' });
  await drv.updatePersonal('1000000001', { ...sanitizePersonal({ ...BASE, convenio: 'METAL' }, { ...opts, code: '1000000001' }) }, STAMP);
  const up = calls.find((c) => c.text.startsWith('UPDATE [PERSONAL]'))!;
  assert.match(up.text, /\[EM_CONV\] = @v\d+/);
  assert.ok(Object.values(up.params).includes('METAL'));
  TABLES.PERSONAL.pop();
});

test('SQL Server: asignar y quitar el convenio a varios empleados (EM_CONV)', async () => {
  TABLES.PERSONAL.push(col('EM_CONV', 'nvarchar', 10, true));
  const { drv, calls } = fakeSql(() => ({ rows: [], affected: 2 }));
  assert.equal(await drv.setEmployeesConvenio(['1', '2'], 'METAL'), 2);
  assert.match(calls[0].text, /UPDATE \[PERSONAL\] SET \[EM_CONV\] = @conv WHERE \[EM_CODI\] IN \(@e0, @e1\)/);
  assert.equal(calls[0].params.conv, 'METAL');
  await drv.setEmployeesConvenio(['3'], '');
  assert.equal(calls[1].params.conv, null);
  TABLES.PERSONAL.pop();
  const { drv: d2 } = fakeSql(() => ({ rows: [] }));
  await assert.rejects(d2.setEmployeesConvenio(['1'], 'METAL'), /no tiene la columna EM_CONV/);
});

test('SQL Server: al guardar un convenio se escriben sus periodos, límites y pluses', async () => {
  const c4 = (n: string) => [col(n, 'nvarchar', 10, false)];
  TABLES.PS_CONVENIOS = [...c4('CV_CODI'), col('CV_IFDI', 'tinyint', null)]; TABLES.PS_CONVENIOS_VACACIONES = [...c4('CA_CONV'), col('CA_LINE', 'smallint', null, false), col('CA_FDIA', 'tinyint', null), col('CA_UNID', 'char', 1), col('CA_MDIA', 'int', null)];
  TABLES.PS_CONVENIOS_LIMITES = c4('CL_CONV'); TABLES.PS_CONVENIOS_PLUSES = c4('CP_CONV');
  const { drv, calls } = fakeSql((text) => (text.includes('COUNT(*)') ? { rows: [{ n: 0 }] } : { rows: [] }));
  await drv.saveConvenio({
    code: 'METAL', name: 'METAL', incidenceDay: 1, incidenceMonth: 1,
    vacations: [{ type: 'V26', day: 1, month: 1, days: 22, pluses: [{ years: 5, value: 1 }, { years: 6, value: 2 }] },
      { type: 'AP', day: 1, month: 1, unit: 'H', days: 0, minutes: 960, pluses: [{ years: 3, value: 120 }] }],
    limits: [{ incidence: '003', unit: 'H', value: 600, pluses: [{ years: 4, value: 180 }] }]
  }, true, { date: '20261009', time: '1300', user: 'SMO' });
  const vac = calls.filter((c) => c.text.startsWith('INSERT INTO [PS_CONVENIOS_VACACIONES]')).map((c) => c.params);
  assert.deepEqual(vac.map((p) => [p.line, p.tvac, p.unit, p.dias, p.minu]), [[1, 'V26', 'D', 22, null], [2, 'AP', 'H', null, 960]]);
  const plus = calls.filter((c) => c.text.startsWith('INSERT INTO [PS_CONVENIOS_PLUSES]')).map((c) => c.params);
  assert.deepEqual(plus.map((p) => [p.tipo, p.ref, p.anos, p.dias, p.minu]), [['V', '1', 5, 1, null], ['V', '1', 6, 2, null], ['V', '2', 3, null, 120], ['I', '003', 4, null, 180]]);
  for (const t of ['PS_CONVENIOS', 'PS_CONVENIOS_VACACIONES', 'PS_CONVENIOS_LIMITES', 'PS_CONVENIOS_PLUSES']) delete TABLES[t];
});

test('SQL Server: periodos de VACACIONES (alta con valores fijos; actualización sin tocar lo asignado)', async () => {
  TABLES.VACACIONES = ['CODIGO', 'FECHAINICIO', 'FECHAFIN', 'VACACIONES', 'USUARIO'].map((n) => col(n, 'nvarchar', 10, false))
    .concat(['TOTALDIAS', 'DIASASIGNADOS', 'MINUTOSDIA', 'PERIODOENDIAS', 'TRIENIOSAPLICADOS', 'QUINQUENIOSAPLICADOS', 'TOTALHORAS', 'HORASASIGNADAS'].map((n) => col(n, 'decimal', null)))
    .concat([col('FECHA', 'nvarchar', 8), col('HORA', 'nvarchar', 4)]);
  let exists = 0;
  const { drv, calls } = fakeSql((text) => (text.includes('COUNT(*)') ? { rows: [{ n: exists }] } : { rows: [] }));
  const row = { employee: '0000000001', type: 'V26', from: '2026-01-01', to: '2026-12-31', days: 22, hours: 176 };
  const stamp = { date: '20261009', time: '1500', user: 'SMO' };
  await drv.upsertVacationPeriods([row], stamp);
  const ins = calls.find((c) => c.text.startsWith('INSERT INTO [VACACIONES]'))!;
  const cols = ins.text.match(/\(([^)]*)\) VALUES/)![1].split(', ').map((x) => x.replace(/[[\]]/g, ''));
  const marks = ins.text.match(/VALUES \(([^)]*)\)/)![1].split(', ').map((x) => x.slice(1));
  const val = (c: string) => ins.params[marks[cols.indexOf(c)]];
  assert.deepEqual([val('CODIGO'), val('VACACIONES'), val('FECHAINICIO'), val('FECHAFIN'), val('TOTALDIAS'), val('DIASASIGNADOS'), val('PERIODOENDIAS'), val('MINUTOSDIA'), val('TOTALHORAS'), val('HORASASIGNADAS'), val('FECHA'), val('HORA'), val('USUARIO')],
    ['0000000001', 'V26', '20260101', '20261231', 22, 0, 1, 0, 176, 0, '20261009', '1500', 'SMO']);
  exists = 1; calls.length = 0;
  await drv.upsertVacationPeriods([{ ...row, days: 20 }], stamp);
  const up = calls.find((c) => c.text.startsWith('UPDATE [VACACIONES]'))!;
  assert.ok(up && !/DIASASIGNADOS/.test(up.text) && /\[TOTALDIAS\] = @p\d/.test(up.text));
  // Periodo en horas, como lo graba Evalos: PERIODOENDIAS 0, TOTALDIAS = minutos (16:30 h = 990), MINUTOSDIA = minutos de un día y TOTALHORAS 0.
  exists = 0; calls.length = 0;
  await drv.upsertVacationPeriods([{ ...row, type: 'AP', unit: 'H', days: 0, hours: 16.5, minutesPerDay: 450 }], stamp);
  const ih = calls.find((c) => c.text.startsWith('INSERT INTO [VACACIONES]'))!;
  const mh = ih.text.match(/VALUES \(([^)]*)\)/)![1].split(', ').map((x) => x.slice(1));
  const ch = ih.text.match(/\(([^)]*)\) VALUES/)![1].split(', ').map((x) => x.replace(/[[\]]/g, ''));
  const vh = (c: string) => ih.params[mh[ch.indexOf(c)]];
  assert.deepEqual([vh('TOTALDIAS'), vh('PERIODOENDIAS'), vh('MINUTOSDIA'), vh('TOTALHORAS'), vh('HORASASIGNADAS')], [990, 0, 450, 0, 0]);
  // Al actualizarlo se corrigen también MINUTOSDIA y TOTALHORAS (filas grabadas con la versión anterior).
  exists = 1; calls.length = 0;
  await drv.upsertVacationPeriods([{ ...row, type: 'AP', unit: 'H', days: 0, hours: 150, minutesPerDay: 480 }], stamp);
  const uh = calls.find((c) => c.text.startsWith('UPDATE [VACACIONES]'))!;
  const setv = (c: string) => uh.params[uh.text.match(new RegExp(`\\[${c}\\] = @(p\\d+)`))![1]];
  assert.deepEqual([setv('TOTALDIAS'), setv('MINUTOSDIA'), setv('TOTALHORAS'), setv('PERIODOENDIAS')], [9000, 480, 0, 0]);
  assert.ok(!/DIASASIGNADOS|HORASASIGNADAS/.test(uh.text));
  delete TABLES.VACACIONES;
});

test('SQL Server: periodos de INCIDENCIALIMITE (límite en minutos y PERIODOENDIAS 0 si es en horas)', async () => {
  TABLES.INCIDENCIALIMITE = ['CODIGO', 'FECHAINICIO', 'FECHAFIN', 'INCIDENCIA', 'INCIDENCIAEXCESO'].map((n) => col(n, 'nvarchar', 10, false))
    .concat(['LIMITE', 'VALOR', 'VALOREXCESO', 'NOTIFICAREMPLEADO', 'NOTIFICARSUPERVISOR', 'PERIODOENDIAS'].map((n) => col(n, 'int', null)));
  const { drv, calls } = fakeSql((text) => (text.includes('COUNT(*)') ? { rows: [{ n: 0 }] } : { rows: [] }));
  await drv.upsertIncidenceLimits([{ employee: '1', incidence: '001', from: '2026-01-01', to: '2026-12-31', unit: 'H', value: 1200 }]);
  const ins = calls.find((c) => c.text.startsWith('INSERT INTO [INCIDENCIALIMITE]'))!;
  const cols = ins.text.match(/\(([^)]*)\) VALUES/)![1].split(', ').map((x) => x.replace(/[[\]]/g, ''));
  const marks = ins.text.match(/VALUES \(([^)]*)\)/)![1].split(', ').map((x) => x.slice(1));
  const val = (c: string) => ins.params[marks[cols.indexOf(c)]];
  assert.deepEqual([val('LIMITE'), val('INCIDENCIAEXCESO'), val('VALOR'), val('VALOREXCESO'), val('NOTIFICAREMPLEADO'), val('NOTIFICARSUPERVISOR'), val('PERIODOENDIAS')], [1200, '999', 0, 0, 0, 0, 0]);
  delete TABLES.INCIDENCIALIMITE;
});

test('SQL Server: los límites guardados en días se leen en horas (8 h por día) y se guardan en minutos', async () => {
  const c4 = (n: string) => [col(n, 'nvarchar', 10, false)];
  TABLES.PS_CONVENIOS = [...c4('CV_CODI'), col('CV_IFDI', 'tinyint', null)]; TABLES.PS_CONVENIOS_VACACIONES = [...c4('CA_CONV'), col('CA_LINE', 'smallint', null, false), col('CA_FDIA', 'tinyint', null), col('CA_UNID', 'char', 1), col('CA_MDIA', 'int', null)];
  TABLES.PS_CONVENIOS_LIMITES = c4('CL_CONV'); TABLES.PS_CONVENIOS_PLUSES = c4('CP_CONV');
  const { drv, calls } = fakeSql((text) => {
    if (text.includes('FROM [PS_CONVENIOS] ORDER BY')) return { rows: [{ code: 'METAL', name: 'METAL', id: 1, im: 1 }] };
    if (text.includes('FROM [PS_CONVENIOS_LIMITES]')) return { rows: [{ conv: 'METAL', inci: '004', unit: 'D', dias: 5, minu: null }, { conv: 'METAL', inci: '001', unit: 'H', dias: null, minu: 1200 }] };
    if (text.includes('FROM [PS_CONVENIOS_PLUSES]')) return { rows: [{ conv: 'METAL', tipo: 'I', ref: '004', anos: 5, dias: 1, minu: null }] };
    if (text.includes('COUNT(*)')) return { rows: [{ n: 1 }] };
    return { rows: [] };
  });
  const [conv] = await drv.listConvenios();
  assert.deepEqual(conv.limits.find((l: any) => l.incidence === '004'), { incidence: '004', unit: 'H', value: 2400, pluses: [{ years: 5, value: 480 }], fromDays: 5 });
  assert.deepEqual(conv.limits.find((l: any) => l.incidence === '001'), { incidence: '001', unit: 'H', value: 1200, pluses: [] });
  calls.length = 0;
  await drv.saveConvenio({ ...conv, limits: conv.limits.map(({ fromDays, ...l }: any) => l) }, false, { date: '20261013', time: '1530', user: 'SMO' });
  const ins = calls.filter((c) => c.text.startsWith('INSERT INTO [PS_CONVENIOS_LIMITES]')).map((c) => [c.params.inci, c.params.unit, c.params.dias, c.params.minu]);
  assert.deepEqual(ins, [['004', 'H', null, 2400], ['001', 'H', null, 1200]]);
  const plus = calls.filter((c) => c.text.startsWith('INSERT INTO [PS_CONVENIOS_PLUSES]')).map((c) => [c.params.ref, c.params.dias, c.params.minu]);
  assert.deepEqual(plus, [['004', null, 480]]);
  for (const t of ['PS_CONVENIOS', 'PS_CONVENIOS_VACACIONES', 'PS_CONVENIOS_LIMITES', 'PS_CONVENIOS_PLUSES']) delete TABLES[t];
});

test('rol de Workflow en la ficha', () => {
  assert.equal(sanitizePersonal({ ...BASE, workflowRol: 'responsable' }, opts).workflowRol, 'RESPONSABLE');
  assert.equal(sanitizePersonal({ ...BASE, workflowRol: 'RESP' }, opts).workflowRol, 'RESPONSABLE', 'la abreviatura guardada se entiende');
  assert.equal(sanitizePersonal(BASE, opts).workflowRol, '');
  assert.throws(() => sanitizePersonal({ ...BASE, workflowRol: 'JEFE' }, opts), /EMPLEADO, RESPONSABLE, RRHH/);
});

test('SQL Server: corregir la fecha de alta mueve los tramos que empezaban en la antigua (en la misma transacción)', async () => {
  const { drv, calls } = fakeSql((text) => {
    if (/FROM \[HIS_VIGENCIA\] WITH \(UPDLOCK, HOLDLOCK\) WHERE \[HV_PCOD\] = @code AND \[HV_FALT\] = @o/.test(text)) return { rows: [{ fbaj: '0' }] };
    if (/SELECT RTRIM\(\[H[TD]_CODI\]\) AS value, RTRIM\(ISNULL\(\[H[TD]_FBAJ\]/.test(text)) return { rows: [{ value: text.includes('[HT_') ? '0000001234' : 'IT', fbaj: '0' }] };
    return { rows: [] };
  }, { name: 'X', hireDate: '20260601', card: '0000001234', department: 'IT' });
  const r = await drv.updatePersonal('1000000001', { ...sanitizePersonal({ ...BASE, hireDate: '2026-02-01' }, { ...opts, code: '1000000001' }) }, STAMP);
  assert.deepEqual(r.movedTramos, ['periodo de alta', 'tarjeta', 'departamento']);
  const ups = calls.filter((c) => /^UPDATE \[HIS_/.test(c.text));
  assert.equal(ups.length, 3);
  for (const u of ups) assert.deepEqual([u.params.o, u.params.n, u.params.usua], ['20260601', '20260201', 'SMO']);
  // Adelantar: comprueba que nadie más tuviera la tarjeta entre las dos fechas.
  assert.ok(calls.some((c) => /\[HT_CODI\] = @card AND \[HT_PCOD\] <> @code AND \[HT_FALT\] < @o/.test(c.text)));
});

test('SQL Server: corregir la fecha de alta con un tramo que acaba antes de la nueva → 409', async () => {
  const { drv } = fakeSql((text) => {
    if (/SELECT RTRIM\(\[HD_CODI\]\) AS value, RTRIM\(ISNULL\(\[HD_FBAJ\]/.test(text)) return { rows: [{ value: 'IT', fbaj: '20260630' }] };
    return { rows: [] };
  }, { name: 'X', hireDate: '20260601' });
  await assert.rejects(drv.updatePersonal('1000000001', { ...sanitizePersonal({ ...BASE, hireDate: '2026-08-01' }, { ...opts, code: '1000000001' }) }, STAMP),
    /El departamento IT se le quitó el 30\/06\/2026, antes de la nueva fecha de alta/);
});
