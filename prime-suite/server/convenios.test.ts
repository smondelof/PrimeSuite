// Tests de Convenios: validación del formulario, periodos de un año y script de las tablas PS_CONVENIOS.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpError } from './http.ts';
import { VACATION_TYPE_DEFAULTS, conveniosSql, detectColorFormat, vacationTypeDefault, encodeColor, periodAround, sanitizeConvenio, validDayMonth } from './evalos/convenios.ts';
import { evalosColor } from './evalos/mssql.ts';

const base = {
  code: 'ofi', name: '  Convenio   de oficinas ', incidenceDay: 1, incidenceMonth: 9,
  vacations: [{ type: 'V26', day: 1, month: 4, days: 23 }, { type: 'AP', day: 1, month: 1, days: '2,5' }],
  limits: [{ incidence: '003', unit: 'H', value: 1230 }, { incidence: '001', value: 150 }]
};
const opts = { uppercase: true, incidences: new Set(['001', '003']), vacationTypes: new Set(['V26', 'AP']) };
const rejects = (b: any, re: RegExp) => assert.throws(() => sanitizeConvenio(b, opts), (e: any) => e instanceof HttpError && e.status === 400 && re.test(e.message));

test('normaliza el convenio: código en mayúsculas, nombre limpio y límites ordenados', () => {
  const c = sanitizeConvenio(base, opts);
  assert.equal(c.code, 'OFI');
  assert.equal(c.name, 'Convenio de oficinas');
  assert.deepEqual(c.limits.map((l) => l.incidence), ['001', '003']);
  assert.deepEqual(c.limits[1], { incidence: '003', unit: 'H', value: 1230, pluses: [] });
  // Sin fin: un año menos un día (01/04 → 31/03 del año siguiente; 01/01 → 31/12).
  assert.deepEqual(c.vacations, [
    { type: 'V26', day: 1, month: 4, endDay: 31, endMonth: 3, endNextYear: true, unit: 'D', days: 23, pluses: [] },
    { type: 'AP', day: 1, month: 1, endDay: 31, endMonth: 12, endNextYear: false, unit: 'D', days: 2.5, pluses: [] }
  ]);
  assert.deepEqual([c.incidenceEndDay, c.incidenceEndMonth, c.incidenceEndNextYear], [31, 8, true]);
  // Varios periodos del mismo tipo, con inicios distintos.
  const dos = sanitizeConvenio({ ...base, vacations: [{ type: 'V26', day: 1, month: 1, days: 15 }, { type: 'V26', day: 1, month: 7, days: 8 }] }, opts);
  assert.equal(dos.vacations.length, 2);
  assert.deepEqual(sanitizeConvenio({ ...base, vacations: [] }, opts).vacations, []);
});

test('rechaza datos no válidos', () => {
  rejects({ ...base, code: '' }, /código/);
  rejects({ ...base, code: 'DEMASIADOLARGO' }, /10 caracteres/);
  rejects({ ...base, name: ' ' }, /nombre/);
  rejects({ ...base, vacations: [{ type: 'V26', day: 29, month: 2, days: 22 }] }, /periodo de V26 no es una fecha/);
  rejects({ ...base, vacations: [{ type: 'V26', day: 1, month: 6, days: 22 }, { type: 'V26', day: 1, month: 6, days: 3 }] }, /V26 que empieza el 01\/06 está repetido/);
  rejects({ ...base, vacations: [{ type: 'XX', day: 1, month: 1, days: 22 }] }, /no existe en TIPOSVACACIONES/);
  rejects({ ...base, vacations: [{ type: '', day: 1, month: 1, days: 22 }] }, /tipo de vacaciones de la línea 1/);
  rejects({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, days: 22.3 }] }, /medios días/);
  rejects({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, days: 0 }] }, /0,5/);
  rejects({ ...base, incidenceDay: 31, incidenceMonth: 4 }, /incidencias no es una fecha/);
  rejects({ ...base, limits: [{ incidence: '001', value: 60 }, { incidence: '001', value: 60 }] }, /repetida/);
  rejects({ ...base, limits: [{ incidence: '999', value: 60 }] }, /no existe en la tabla INCIDENC/);
  rejects({ ...base, limits: [{ incidence: '001', value: 0 }] }, /horas mayor que 00:00/);
  rejects({ ...base, limits: [{ incidence: '003', value: 90.5 }] }, /horas/);
});

test('sin lista de incidencias no se comprueba que existan', () => {
  const c = sanitizeConvenio({ ...base, limits: [{ incidence: 'ZZZ', unit: 'D', value: 1 }] }, { uppercase: false });
  assert.equal(c.code, 'ofi');
  assert.equal(c.limits[0].incidence, 'ZZZ');
});

test('día/mes de inicio: febrero solo hasta el 28', () => {
  assert.equal(validDayMonth(28, 2), true);
  assert.equal(validDayMonth(29, 2), false);
  assert.equal(validDayMonth(31, 12), true);
  assert.equal(validDayMonth(31, 11), false);
  assert.equal(validDayMonth(1, 13), false);
});

test('periodo de un año que contiene la fecha de referencia', () => {
  assert.deepEqual(periodAround(1, 1, '2026-10-09'), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(periodAround(1, 9, '2026-10-09'), { from: '2026-09-01', to: '2027-08-31' });
  assert.deepEqual(periodAround(1, 11, '2026-10-09'), { from: '2025-11-01', to: '2026-10-31' });
  assert.deepEqual(periodAround(9, 10, '2026-10-09'), { from: '2026-10-09', to: '2027-10-08' });
  assert.deepEqual(periodAround(1, 3, '2028-02-29'), { from: '2027-03-01', to: '2028-02-29' });
});

test('el script crea las tres tablas solo si no existen, en el esquema indicado', () => {
  const sql = conveniosSql('evalos');
  assert.match(sql, /IF OBJECT_ID\(N'\[evalos\]\.\[PS_CONVENIOS\]', N'U'\) IS NULL/);
  assert.match(sql, /CREATE TABLE \[evalos\]\.\[PS_CONVENIOS_LIMITES\]/);
  assert.match(sql, /CREATE TABLE \[evalos\]\.\[PS_CONVENIOS_VACACIONES\][\s\S]*PRIMARY KEY \(CA_CONV, CA_LINE\)/);
  assert.match(sql, /IF COL_LENGTH\(N'\[evalos\]\.\[PS_CONVENIOS_VACACIONES\]', N'CA_LINE'\) IS NULL/);
  assert.match(conveniosSql("o'x"), /EXEC \(N'WITH n AS \(SELECT CA_LINE[\s\S]*FROM \[o''x\]\.\[PS_CONVENIOS_VACACIONES\]/);
  assert.match(sql, /REFERENCES \[evalos\]\.\[PS_CONVENIOS\] \(CV_CODI\) ON DELETE CASCADE/);
  assert.match(conveniosSql(), /\[dbo\]\.\[PS_CONVENIOS\]/);
  assert.match(conveniosSql('ra]ro'), /\[ra\]\]ro\]/);
});

test('color del tipo de vacaciones en el formato de la tabla, y se lee igual', () => {
  assert.equal(encodeColor('#1565c0', 'hex'), '1565C0');
  assert.equal(encodeColor('#ff0000', 'ole'), 255);
  assert.equal(encodeColor('#0000ff', 'argb'), -16776961);
  assert.equal(encodeColor('rojo', 'hex'), null);
  for (const f of ['hex', 'ole', 'argb'] as const) assert.equal(evalosColor(encodeColor('#2e7d32', f)), '#2e7d32');
  assert.equal(detectColorFormat(true, ['000066', 'FF8800']), 'hex');
  assert.equal(detectColorFormat(true, []), 'hex');
  assert.equal(detectColorFormat(false, [255, 65280]), 'ole');
  assert.equal(detectColorFormat(false, [-16776961]), 'argb');
  assert.equal(detectColorFormat(true, ['255', '16711680']), 'ole');
});

test('valores de un tipo de vacaciones nuevo según el tipo de columna', () => {
  const kinds = { text: ['char', 'nvarchar'], num: ['int', 'bit', 'smallint'] };
  assert.equal(VACATION_TYPE_DEFAULTS.TEORICAS_HORARIO, 'S');
  assert.equal(VACATION_TYPE_DEFAULTS.PERMITIRMEDIODIA, 'S');
  assert.equal(VACATION_TYPE_DEFAULTS.FESTIVO, 'N');
  assert.equal(vacationTypeDefault('S', { type: 'char', nullable: false }, kinds), 'S');
  assert.equal(vacationTypeDefault('', { type: 'nvarchar', nullable: true }, kinds), '');
  assert.equal(vacationTypeDefault('S', { type: 'bit', nullable: false }, kinds), 1);
  assert.equal(vacationTypeDefault('N', { type: 'int', nullable: true }, kinds), 0);
  assert.equal(vacationTypeDefault('', { type: 'int', nullable: true }, kinds), null);
  assert.equal(vacationTypeDefault('', { type: 'smallint', nullable: false }, kinds), 0);
  assert.equal(vacationTypeDefault('', { type: 'datetime', nullable: true }, kinds), null);
  assert.equal(vacationTypeDefault('S', { type: 'datetime', nullable: true }, kinds), undefined);
});

test('pluses por antigüedad en periodos de vacaciones y límites de incidencia', () => {
  const c = sanitizeConvenio({
    ...base,
    vacations: [{ type: 'V26', day: 1, month: 1, days: 22, pluses: [{ years: 6, value: 2 }, { years: '5', value: '1' }] }],
    limits: [{ incidence: '003', unit: 'H', value: 600, pluses: [{ years: 4, value: 180 }] }, { incidence: '001', value: 120 }]
  }, opts);
  assert.deepEqual(c.vacations[0].pluses, [{ years: 5, value: 1 }, { years: 6, value: 2 }]);
  assert.deepEqual(c.limits.find((l) => l.incidence === '003')!.pluses, [{ years: 4, value: 180 }]);
  assert.deepEqual(c.limits.find((l) => l.incidence === '001')!.pluses, []);
  rejects({ ...base, vacations: [{ type: 'V26', day: 1, month: 1, days: 22, pluses: [{ years: 5, value: 1 }, { years: 5, value: 2 }] }] }, /dos pluses a los 5 años/);
  rejects({ ...base, vacations: [{ type: 'V26', day: 1, month: 1, days: 22, pluses: [{ years: 0, value: 1 }] }] }, /años de los pluses/);
  rejects({ ...base, vacations: [{ type: 'V26', day: 1, month: 1, days: 22, pluses: [{ years: 5, value: 1.3 }] }] }, /medios días/);
  rejects({ ...base, limits: [{ incidence: '003', unit: 'H', value: 600, pluses: [{ years: 4, value: 0 }] }] }, /horas mayor que 00:00/);
});

test('el script crea la tabla de pluses', () => {
  assert.match(conveniosSql(), /CREATE TABLE \[dbo\]\.\[PS_CONVENIOS_PLUSES\][\s\S]*PRIMARY KEY \(CP_CONV, CP_TIPO, CP_REF, CP_ANOS\)/);
});

test('las incidencias van siempre en horas, aunque llegue otra unidad', () => {
  const c = sanitizeConvenio({ ...base, limits: [{ incidence: '001', unit: 'D', value: 480, pluses: [{ years: 3, value: 60 }] }] }, opts);
  assert.deepEqual(c.limits, [{ incidence: '001', unit: 'H', value: 480, pluses: [{ years: 3, value: 60 }] }]);
});

test('fin del periodo: mismo año posterior al inicio, o del año siguiente (también más de un año)', () => {
  const c = sanitizeConvenio({ ...base, vacations: [{ type: 'V26', day: 1, month: 1, endDay: 31, endMonth: 1, endNextYear: true, days: 22 }],
    incidenceDay: 1, incidenceMonth: 1, incidenceEndDay: 30, incidenceEndMonth: 6, incidenceEndNextYear: false }, opts);
  assert.deepEqual([c.vacations[0].endDay, c.vacations[0].endMonth, c.vacations[0].endNextYear], [31, 1, true]);
  assert.deepEqual([c.incidenceEndDay, c.incidenceEndMonth, c.incidenceEndNextYear], [30, 6, false]);
  rejects({ ...base, vacations: [{ type: 'V26', day: 1, month: 6, endDay: 31, endMonth: 5, endNextYear: false, days: 22 }] }, /anterior o igual a su inicio/);
  rejects({ ...base, vacations: [{ type: 'V26', day: 1, month: 6, endDay: 31, endMonth: 6, days: 22 }] }, /fin del periodo de V26 no es una fecha/);
  rejects({ ...base, incidenceEndDay: 29, incidenceEndMonth: 2, incidenceEndNextYear: true }, /fin del periodo de incidencias/);
});

test('periodos de vacaciones en horas: valor y pluses en minutos', () => {
  const c = sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 990, days: 3, pluses: [{ years: 5, value: 120 }] }] }, opts);
  assert.deepEqual(c.vacations[0], { type: 'AP', day: 1, month: 1, endDay: 31, endMonth: 12, endNextYear: false, unit: 'H', days: 0, minutes: 990, minutesPerDay: 480, pluses: [{ years: 5, value: 120 }] });
  // Horas de un día de vacaciones: por defecto 8 h; se puede indicar otra (7:30 h = 450).
  assert.equal(sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 990, minutesPerDay: 450 }] }, opts).vacations[0].minutesPerDay, 450);
  assert.throws(() => sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 990, minutesPerDay: 0 }] }, opts), /un día de vacaciones/);
  assert.throws(() => sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 990, minutesPerDay: 1500 }] }, opts), /un día de vacaciones/);
  // En días no lleva horas por día.
  assert.equal(sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, days: 22, minutesPerDay: 450 }] }, opts).vacations[0].minutesPerDay, undefined);
  assert.throws(() => sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 0 }] }, opts), /mayor que 00:00/);
  assert.throws(() => sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 12.5 }] }, opts), /mayor que 00:00/);
  assert.throws(() => sanitizeConvenio({ ...base, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', minutes: 60, pluses: [{ years: 2, value: 0.5 }] }] }, opts), /00:00/);
});

test('el script añade las columnas de periodos en horas y deja CA_DIAS opcional', () => {
  const sql = conveniosSql('evalos');
  assert.match(sql, /COL_LENGTH\(N'\[evalos\]\.\[PS_CONVENIOS_VACACIONES\]', N'CA_UNID'\) IS NULL[\s\S]*ADD CA_UNID char\(1\) NULL, CA_MINU int NULL/);
  assert.match(sql, /DROP CONSTRAINT CK_PS_CONVENIOS_VACACIONES_DIAS[\s\S]*ALTER COLUMN CA_DIAS decimal\(5, 1\) NULL[\s\S]*CK_PS_CONVENIOS_VACACIONES_VALOR/);
  assert.match(conveniosSql("o'x"), /OBJECT_ID\(N''\[o''''x\]\.\[PS_CONVENIOS_VACACIONES\]''\)/);
  assert.match(sql, /COL_LENGTH\(N'\[evalos\]\.\[PS_CONVENIOS_VACACIONES\]', N'CA_MDIA'\) IS NULL\s*ALTER TABLE \[evalos\]\.\[PS_CONVENIOS_VACACIONES\] ADD CA_MDIA int NULL/);
});
