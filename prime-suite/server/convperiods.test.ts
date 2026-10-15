// Tests del cálculo de periodos de vacaciones y límites de incidencia a partir del convenio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computePeriod, currentRef, linePeriod, periodOfYear, excessAlerts, nextRef, plusFor, rowsFor, seniorityYears, syncPeriods, yearPeriod } from './evalos/convperiods.ts';
import type { Convenio, Personal } from './evalos/types.ts';

test('periodo de un año: la fecha fin es el día anterior', () => {
  assert.deepEqual(yearPeriod(1, 1, '2026-10-09'), { from: '2026-01-01', to: '2026-12-31' });
  assert.deepEqual(yearPeriod(15, 1, '2026-01-10'), { from: '2025-01-15', to: '2026-01-14' });
});

test('antigüedad en años cumplidos y plus del tramo más alto alcanzado', () => {
  assert.equal(seniorityYears('2020-01-01', '2026-01-01'), 6);
  assert.equal(seniorityYears('2020-06-15', '2026-06-14'), 5);
  assert.equal(seniorityYears('2027-06-01', '2027-01-01'), 0);
  const pl = [{ years: 5, value: 1 }, { years: 6, value: 2 }];
  assert.equal(plusFor(pl, 4), 0);
  assert.equal(plusFor(pl, 5), 1);
  assert.equal(plusFor(pl, 9), 2);
});

test('ejemplo 1: alta a mitad de periodo → empieza en el alta y se prorratea (al medio día)', () => {
  const ref = currentRef('2027-06-01', '2026-10-09');
  assert.equal(ref, '2027-06-01');
  const p = computePeriod({ day: 1, month: 1, value: 20 }, '2027-06-01', ref, 'D')!;
  // 20 días × 214 / 365 = 11,73 → 11,5
  assert.deepEqual(p, { from: '2027-06-01', to: '2027-12-31', value: 11.5, seniority: 0, plus: 0, prorated: true });
});

test('ejemplo 2: 20 días + 2 de plus a los 5 años, alta en 2020 → 22 días', () => {
  const p = computePeriod({ day: 1, month: 1, value: 20, pluses: [{ years: 5, value: 2 }] }, '2020-01-01', '2026-10-09', 'D')!;
  assert.deepEqual(p, { from: '2026-01-01', to: '2026-12-31', value: 22, seniority: 6, plus: 2, prorated: false });
});

test('límites en horas: prorrateo al minuto; sin alta en el periodo → null', () => {
  const p = computePeriod({ day: 1, month: 1, value: 1200 }, '2026-07-01', '2026-10-09', 'H')!;
  assert.equal(p.value, Math.round((1200 * 184) / 365));
  assert.equal(computePeriod({ day: 1, month: 1, value: 20 }, '2028-03-01', '2026-10-09', 'D'), null);
});

test('periodo siguiente', () => {
  assert.equal(nextRef({ day: 1, month: 1 }, '2026-10-09'), '2027-01-01');
  const p = computePeriod({ day: 1, month: 1, value: 20, pluses: [{ years: 5, value: 2 }] }, '2022-01-01', nextRef({ day: 1, month: 1 }, '2026-10-09'), 'D')!;
  assert.deepEqual([p.from, p.to, p.value], ['2027-01-01', '2027-12-31', 22]);
});

const CONV: Convenio = {
  code: 'METAL', name: 'METAL', incidenceDay: 1, incidenceMonth: 1,
  vacations: [{ type: 'V26', day: 1, month: 1, days: 20, pluses: [{ years: 5, value: 2 }] }],
  limits: [{ incidence: '001', unit: 'H', value: 1200 }, { incidence: '004', unit: 'H', value: 2400, pluses: [{ years: 4, value: 180 }] }]
};
const emp = (code: string, hireDate: string, active = true) => ({ code, hireDate, active, name: code, card: '', email: '', endDate: '', company: '', department: '', section: '', area: '', consultas: '', solicitudes: '', convenio: 'METAL' }) as Personal;

test('filas de VACACIONES e INCIDENCIALIMITE de una persona (TOTALHORAS = días × 8)', () => {
  const r = rowsFor(CONV, emp('1', '2019-03-01'), () => '2026-10-09');
  assert.deepEqual(r.vac, [{ employee: '1', type: 'V26', from: '2026-01-01', to: '2026-12-31', unit: 'D', days: 22, hours: 176 }]);
  // 004: 40 h + 3 h de plus a los 4 años (lleva 7 años a 01/01/2026).
  assert.deepEqual(r.inc.map((x) => [x.incidence, x.unit, x.value]), [['001', 'H', 1200], ['004', 'H', 2580]]);
});

test('avisos de exceso solo en periodos vigentes', () => {
  const a = excessAlerts(
    [{ employee: '1', type: 'V26', from: '2026-01-01', to: '2026-12-31', days: 20, hours: 160, assignedDays: 22, assignedHours: 0 },
     { employee: '2', type: 'V26', from: '2025-01-01', to: '2025-12-31', days: 20, hours: 160, assignedDays: 30, assignedHours: 0 }],
    [{ employee: '1', incidence: '001', from: '2026-01-01', to: '2026-12-31', unit: 'H', value: 600, used: 615 }], '2026-10-09');
  assert.equal(a.length, 2);
  assert.match(a[0].text, /22 días asignados y solo le corresponden 20/);
  assert.match(a[1].text, /lleva 10:15 h y el límite es 10:00 h/);
});

test('sincronizar: periodo en curso, el siguiente solo si existe, sin bajas, y avisos', async () => {
  const store = { vac: [] as any[], inc: [] as any[] };
  const key = (r: any) => `${r.employee}|${r.type ?? r.incidence}|${r.from}`;
  const upsert = (list: any[], rows: any[]) => {
    let created = 0, updated = 0;
    for (const r of rows) { const i = list.findIndex((x) => key(x) === key(r)); if (i >= 0) { list[i] = { ...list[i], ...r }; updated++; } else { list.push({ assignedDays: 0, assignedHours: 0, used: 0, ...r }); created++; } }
    return { created, updated };
  };
  const drv: any = {
    upsertVacationPeriods: async (rows: any[]) => upsert(store.vac, rows),
    upsertIncidenceLimits: async (rows: any[]) => upsert(store.inc, rows),
    listEmployeePeriods: async (codes: string[], from: string) => ({ vacations: store.vac.filter((v) => codes.includes(v.employee) && v.to >= from), limits: store.inc.filter((l) => codes.includes(l.employee) && l.to >= from) })
  };
  const stamp = { date: '20261009', time: '1500', user: 'SMO' };
  const people = [emp('1', '2019-03-01'), emp('2', '2020-01-01', false)];
  let r = await syncPeriods(drv, CONV, people, 'current', '2026-10-09', stamp);
  assert.deepEqual([r.created, r.updated, store.vac.length, store.inc.length], [3, 0, 1, 2]);
  // Ya disfrutados 23 días y el convenio baja a 18: se actualiza TOTALDIAS sin tocar lo asignado y avisa.
  store.vac[0].assignedDays = 23;
  r = await syncPeriods(drv, { ...CONV, vacations: [{ ...CONV.vacations[0], days: 18 }] }, people, 'current', '2026-10-09', stamp);
  assert.deepEqual([r.created, r.updated, store.vac[0].days, store.vac[0].assignedDays], [0, 3, 20, 23]);
  assert.match(r.alerts[0].text, /23 días asignados y solo le corresponden 20/);
  // Año siguiente.
  r = await syncPeriods(drv, CONV, people, 'next', '2026-10-09', stamp);
  assert.equal(r.created, 3);
  assert.ok(store.vac.some((v) => v.from === '2027-01-01' && v.days === 22));
});

/** Driver de periodos en memoria (con borrado y cambio de FECHAINICIO). */
function memPeriods() {
  const store = { vac: [] as any[], inc: [] as any[] };
  const k = (r: any, from = r.from) => `${r.employee}|${r.type ?? r.incidence}|${from}`;
  const upsert = (list: any[], rows: any[], fresh: any) => {
    let created = 0, updated = 0;
    for (const r of rows) {
      const { prevFrom, ...row } = r;
      const i = list.findIndex((x) => k(x) === k(r, prevFrom || r.from));
      if (i >= 0) { list[i] = { ...list[i], ...row }; updated++; } else { list.push({ ...fresh, ...row }); created++; }
    }
    return { created, updated };
  };
  const drv: any = {
    upsertVacationPeriods: async (rows: any[]) => upsert(store.vac, rows, { assignedDays: 0, assignedHours: 0 }),
    upsertIncidenceLimits: async (rows: any[]) => upsert(store.inc, rows, { used: 0 }),
    deletePeriods: async (t: string, keys: any[]) => {
      const list = t === 'vacations' ? store.vac : store.inc;
      const before = list.length;
      const keep = list.filter((x) => !keys.some((kk) => kk.employee === x.employee && kk.code === (x.type ?? x.incidence) && kk.from === x.from));
      list.splice(0, list.length, ...keep);
      return before - keep.length;
    },
    listEmployeePeriods: async (codes: string[], from: string) => ({ vacations: store.vac.filter((v) => codes.includes(v.employee) && v.to >= from), limits: store.inc.filter((l) => codes.includes(l.employee) && l.to >= from) })
  };
  return { store, drv };
}
const ST = { date: '20261014', time: '1400', user: 'SMO' };
const C20: Convenio = { code: 'C', name: 'C', incidenceDay: 1, incidenceMonth: 1, vacations: [{ type: 'V26', day: 1, month: 1, days: 20 }], limits: [{ incidence: '001', unit: 'H', value: 1200 }] };

test('fecha de alta corregida a una anterior: se corrige FECHAINICIO y se recalcula sin tocar lo disfrutado', async () => {
  const { store, drv } = memPeriods();
  await syncPeriods(drv, C20, [emp('1', '2026-06-01')], 'current', '2026-10-14', ST);
  assert.deepEqual([store.vac[0].from, store.vac[0].days], ['2026-06-01', 11.5]);
  store.vac[0].assignedDays = 3;
  const r = await syncPeriods(drv, C20, [emp('1', '2026-02-01')], 'current', '2026-10-14', ST, { from: '2026-06-01', to: '2026-02-01' });
  assert.equal(store.vac.length, 1);
  // 20 × 334 / 365 = 18,3 → 18,5
  assert.deepEqual([store.vac[0].from, store.vac[0].to, store.vac[0].days, store.vac[0].assignedDays], ['2026-02-01', '2026-12-31', 18.5, 3]);
  assert.equal(store.inc[0].from, '2026-02-01');
  assert.deepEqual([r.created, r.updated, r.deleted], [0, 2, 0]);
});

test('fecha de alta corregida a una posterior: se reduce el prorrateo', async () => {
  const { store, drv } = memPeriods();
  await syncPeriods(drv, C20, [emp('1', '2026-02-01')], 'current', '2026-10-14', ST);
  await syncPeriods(drv, C20, [emp('1', '2026-09-01')], 'current', '2026-10-14', ST, { from: '2026-02-01', to: '2026-09-01' });
  // 20 × 122 / 365 = 6,7 → 6,5
  assert.deepEqual(store.vac.map((v) => [v.from, v.days]), [['2026-09-01', 6.5]]);
});

test('fecha de alta corregida al año siguiente: el periodo que ya no corresponde se borra si no tiene nada disfrutado', async () => {
  const { store, drv } = memPeriods();
  await syncPeriods(drv, C20, [emp('1', '2026-03-01'), emp('2', '2026-03-01')], 'current', '2026-10-14', ST);
  store.vac.find((v) => v.employee === '2').assignedDays = 2;
  const r = await syncPeriods(drv, C20, [emp('1', '2027-03-01'), emp('2', '2027-03-01')], 'current', '2026-10-14', ST, { from: '2026-03-01', to: '2027-03-01' });
  assert.deepEqual(store.vac.filter((v) => v.employee === '1').map((v) => [v.from, v.to]), [['2027-03-01', '2027-12-31']]);
  // El de la persona 2 tiene días asignados: se deja y se avisa.
  assert.deepEqual(store.vac.filter((v) => v.employee === '2').map((v) => v.from).sort(), ['2026-03-01', '2027-03-01']);
  assert.ok(r.alerts.some((a) => a.employee === '2' && /anterior a la nueva fecha de alta/.test(a.text)));
  assert.equal(r.deleted, 3); // vacaciones e incidencia de 1, incidencia de 2 (sin uso)
});

test('periodos con fin propio: más de un año (se solapan) y de menos de un año (con hueco)', () => {
  const trece = { day: 1, month: 1, endDay: 31, endMonth: 1, endNextYear: true };
  assert.deepEqual(periodOfYear(trece, 2026), { from: '2026-01-01', to: '2027-01-31', year: 2026 });
  // En enero de 2027 están abiertos los dos: el en curso es el último que ha empezado.
  assert.deepEqual([linePeriod(trece, '2027-01-15').from, linePeriod(trece, '2027-01-15').to], ['2027-01-01', '2028-01-31']);
  assert.equal(nextRef(trece, '2026-10-14'), '2027-01-01');
  const medio = { day: 1, month: 1, endDay: 30, endMonth: 6, endNextYear: false };
  // En el hueco (julio a diciembre) el en curso es el del año siguiente.
  assert.deepEqual([linePeriod(medio, '2026-10-14').from, linePeriod(medio, '2026-10-14').to], ['2027-01-01', '2027-06-30']);
  // Prorrateo sobre la duración real: 20 días en 13 meses (396 días), alta el 01/07/2026 → 20 × 215 / 396 = 10,9 → 11.
  const p = computePeriod({ ...trece, value: 20 }, '2026-07-01', '2026-10-14', 'D')!;
  assert.deepEqual([p.from, p.to, p.value], ['2026-07-01', '2027-01-31', 11]);
});

test('periodo de vacaciones en horas: TOTALHORAS en horas, plus en minutos y prorrateo al minuto', () => {
  const conv: Convenio = { ...CONV, vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', days: 0, minutes: 16 * 60 + 30, pluses: [{ years: 5, value: 90 }] }], limits: [] };
  // 7 años de antigüedad: 16:30 + 1:30 = 18 h.
  assert.deepEqual(rowsFor(conv, emp('1', '2019-03-01'), () => '2026-10-09').vac,
    [{ employee: '1', type: 'AP', from: '2026-01-01', to: '2026-12-31', unit: 'H', days: 0, hours: 18 }]);
  // Alta el 02/07/2026 (183 de 365 días): 990 min × 183 / 365 = 496,4 → 496 min = 8,27 h.
  assert.deepEqual(rowsFor(conv, emp('2', '2026-07-02'), () => '2026-10-09').vac,
    [{ employee: '2', type: 'AP', from: '2026-07-02', to: '2026-12-31', unit: 'H', days: 0, hours: 8.27 }]);
});

test('avisos de exceso en periodos de vacaciones en horas', () => {
  const a = excessAlerts(
    [{ employee: '1', type: 'AP', from: '2026-01-01', to: '2026-12-31', unit: 'H', days: 0, hours: 16, assignedDays: 0, assignedHours: 16.5 },
     { employee: '2', type: 'AP', from: '2026-01-01', to: '2026-12-31', unit: 'H', days: 0, hours: 16, assignedDays: 1, assignedHours: 8 }], [], '2026-10-09');
  assert.equal(a.length, 1);
  assert.match(a[0].text, /16:30 h asignadas y solo le corresponden 16:00 h/);
});
