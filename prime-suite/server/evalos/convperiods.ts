// Atajos de Evalos · Convenios → periodos de vacaciones (VACACIONES) y de límites de incidencia (INCIDENCIALIMITE).
//
// Al entrar una persona en un convenio (o al modificar el convenio) se le crean o actualizan sus periodos:
//  - Periodo: un año desde el día/mes de inicio de la línea del convenio; la fecha fin es el día anterior.
//  - Se genera el periodo en curso (o el primero, si la fecha de alta es futura). Los del año siguiente se crean
//    con el botón «Generar periodos del año siguiente»; al recalcular, los siguientes solo se actualizan si ya existen.
//  - Periodos de vacaciones en días (PERIODOENDIAS 1, TOTALDIAS y TOTALHORAS) o en horas (PERIODOENDIAS 0, solo
//    TOTALHORAS); los límites de incidencia, siempre en horas (LIMITE en minutos).
//  - Primer periodo: si el alta cae dentro, empieza en la fecha de alta y el total se prorratea por los días que
//    quedan (días: al medio día más cercano; horas: al minuto).
//  - Antigüedad: años cumplidos al inicio del periodo; se aplica el plus del tramo más alto alcanzado.
//  - Una fila que ya existe (misma persona, tipo/incidencia y FECHAINICIO) se actualiza sin tocar lo ya
//    disfrutado (DIASASIGNADOS, HORASASIGNADAS, VALOR).
//  - Personas de baja: no se les generan periodos. Quitar a alguien del convenio no borra sus periodos.
import type { Convenio, ConvenioPlus, EvalosDriver, IncidenceLimitRow, Personal, StoredIncidenceLimit, StoredVacationPeriod, VacationPeriodRow } from './types.ts';
export type { IncidenceLimitRow, StoredIncidenceLimit, StoredVacationPeriod, VacationPeriodRow };

/** Horas de un día de vacaciones para TOTALHORAS (provisional: luego saldrá de las horas teóricas del turno). */
export const HOURS_PER_DAY = 8;

export interface PeriodAlert { employee: string; text: string }
export interface PeriodSyncResult { created: number; updated: number; deleted?: number; alerts: PeriodAlert[]; warnings: string[] }

const DAY = 86400000;
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const ms = (d: string) => Date.parse(`${d}T00:00:00Z`);
export const addDays = (d: string, n: number) => iso(ms(d) + n * DAY);
const daysIncl = (a: string, b: string) => Math.round((ms(b) - ms(a)) / DAY) + 1;

/** Periodo de un año que empieza el día/mes indicado y contiene `ref` (AAAA-MM-DD). */
export function yearPeriod(day: number, month: number, ref: string) {
  const [y, m, d] = ref.split('-').map(Number);
  const start = m > month || (m === month && d >= day) ? y : y - 1;
  return { from: iso(Date.UTC(start, month - 1, day)), to: iso(Date.UTC(start + 1, month - 1, day - 1)) };
}

/**
 * Línea con periodo: inicio (día/mes) y fin (día/mes, del mismo año o del siguiente). Sin fin, un año menos un día
 * (01/01 → 31/12 del mismo año; 01/04 → 31/03 del siguiente). Un periodo puede durar más de un año
 * (p. ej. del 01/01 al 31/01 del año siguiente): entonces se solapa con el del año siguiente.
 */
export interface PeriodLine { day: number; month: number; endDay?: number; endMonth?: number; endNextYear?: boolean }

/** Fin por defecto: el día anterior al inicio, del año siguiente (o 31/12 del mismo año si empieza el 01/01). */
export function defaultEnd(day: number, month: number) {
  const prev = new Date(Date.UTC(2001, month - 1, day - 1)); // 2001: año no bisiesto
  return { endDay: prev.getUTCDate(), endMonth: prev.getUTCMonth() + 1, endNextYear: !(day === 1 && month === 1) };
}

/** Periodo de una línea que empieza en el año indicado. */
export function periodOfYear(line: PeriodLine, year: number) {
  const e = line.endDay && line.endMonth ? { endDay: line.endDay, endMonth: line.endMonth, endNextYear: !!line.endNextYear } : defaultEnd(line.day, line.month);
  return { from: iso(Date.UTC(year, line.month - 1, line.day)), to: iso(Date.UTC(year + (e.endNextYear ? 1 : 0), e.endMonth - 1, e.endDay)), year };
}

/**
 * Periodo «en curso» de una línea en una fecha: el último que ha empezado; si ya ha terminado (periodos de menos de
 * un año), el siguiente.
 */
export function linePeriod(line: PeriodLine, ref: string) {
  const [y, m, d] = ref.split('-').map(Number);
  const start = m > line.month || (m === line.month && d >= line.day) ? y : y - 1;
  const p = periodOfYear(line, start);
  return p.to < ref ? periodOfYear(line, start + 1) : p;
}

/** Años cumplidos entre el alta y una fecha (0 si el alta es posterior). */
export function seniorityYears(hire: string, at: string) {
  if (!hire || hire >= at) return 0;
  const [hy, hm, hd] = hire.split('-').map(Number);
  const [y, m, d] = at.split('-').map(Number);
  return Math.max(0, y - hy - (m < hm || (m === hm && d < hd) ? 1 : 0));
}

/** Plus del tramo más alto alcanzado (0 si ninguno). */
export function plusFor(pluses: ConvenioPlus[] = [], years: number) {
  return pluses.filter((p) => years >= p.years).reduce((best, p) => (!best || p.years > best.years ? p : best), null as ConvenioPlus | null)?.value || 0;
}

export interface ComputedPeriod { from: string; to: string; value: number; seniority: number; plus: number; prorated: boolean }

/**
 * Periodo de una línea del convenio para una persona: el que contiene `ref`, recortado a la fecha de alta y con el
 * total prorrateado si el alta cae dentro. null si la persona no está de alta en ningún día del periodo.
 * `unit` D = días (redondeo al medio día) u H = minutos (redondeo al minuto).
 */
export function computePeriod(line: PeriodLine & { value: number; pluses?: ConvenioPlus[] }, hire: string, ref: string, unit: 'D' | 'H'): ComputedPeriod | null {
  const { from, to } = linePeriod(line, ref);
  const p = { from, to };
  if (hire && hire > p.to) return null;
  const seniority = seniorityYears(hire, p.from);
  const plus = plusFor(line.pluses, seniority);
  const full = line.value + plus;
  if (!hire || hire <= p.from) return { ...p, value: full, seniority, plus, prorated: false };
  const raw = (full * daysIncl(hire, p.to)) / daysIncl(p.from, p.to);
  const value = unit === 'D' ? Math.round(raw * 2) / 2 : Math.round(raw);
  return { from: hire, to: p.to, value, seniority, plus, prorated: true };
}

/** Fecha de referencia del periodo en curso: hoy, o la fecha de alta si es futura. */
export const currentRef = (hire: string, today: string) => (hire && hire > today ? hire : today);
/** Fecha de referencia del periodo siguiente al que está en curso en `ref` (su fecha de inicio). */
export const nextRef = (line: PeriodLine, ref: string) => periodOfYear(line, linePeriod(line, ref).year + 1).from;

/** Filas de VACACIONES e INCIDENCIALIMITE que corresponden a una persona en el periodo que contiene `ref` de cada línea. */
export function rowsFor(conv: Convenio, emp: Pick<Personal, 'code' | 'hireDate'>, refOf: (line: PeriodLine) => string) {
  const vac: VacationPeriodRow[] = [];
  for (const v of conv.vacations) {
    // En días: TOTALDIAS y TOTALHORAS (días × horas por día). En horas: solo TOTALHORAS (minutos → horas con decimales).
    const unit: 'D' | 'H' = v.unit === 'H' ? 'H' : 'D';
    const p = computePeriod({ day: v.day, month: v.month, endDay: v.endDay, endMonth: v.endMonth, endNextYear: v.endNextYear, value: unit === 'H' ? v.minutes || 0 : v.days, pluses: v.pluses }, emp.hireDate, refOf(v), unit);
    if (!p) continue;
    if (unit === 'H') vac.push({ employee: emp.code, type: v.type, from: p.from, to: p.to, unit, days: 0, hours: Math.round((p.value / 60) * 100) / 100, minutesPerDay: v.minutesPerDay || HOURS_PER_DAY * 60 });
    else vac.push({ employee: emp.code, type: v.type, from: p.from, to: p.to, unit, days: p.value, hours: Math.round(p.value * HOURS_PER_DAY * 100) / 100 });
  }
  const inc: IncidenceLimitRow[] = [];
  const incLine: PeriodLine = { day: conv.incidenceDay, month: conv.incidenceMonth, endDay: conv.incidenceEndDay, endMonth: conv.incidenceEndMonth, endNextYear: conv.incidenceEndNextYear };
  for (const l of conv.limits) {
    const p = computePeriod({ ...incLine, value: l.value, pluses: l.pluses }, emp.hireDate, refOf(incLine), l.unit);
    if (p) inc.push({ employee: emp.code, incidence: l.incidence, from: p.from, to: p.to, unit: l.unit, value: p.value });
  }
  return { vac, inc };
}

/**
 * Columnas de VACACIONES de un periodo, como las graba Evalos 8:
 *  - en días:  TOTALDIAS = días, TOTALHORAS = días × 8 (provisional), MINUTOSDIA 0;
 *  - en horas: TOTALDIAS = total en minutos (150 h = 9000), MINUTOSDIA = minutos de un día de vacaciones, TOTALHORAS 0.
 */
export function vacationColumns(r: Pick<VacationPeriodRow, 'unit' | 'days' | 'hours' | 'minutesPerDay'>) {
  if (r.unit === 'H') return { totalDias: Math.round(r.hours * 60), totalHoras: 0, minutosDia: r.minutesPerDay || HOURS_PER_DAY * 60 };
  return { totalDias: r.days, totalHoras: r.hours, minutosDia: 0 };
}

/**
 * Lee una fila de VACACIONES (PERIODOENDIAS 0 = en horas). En horas el total va en minutos en TOTALDIAS; las filas
 * grabadas por la versión anterior (TOTALDIAS 0 y horas en TOTALHORAS) también se leen. Lo disfrutado en un periodo en
 * horas se toma de DIASASIGNADOS en minutos (como el total) o, si está a 0, de HORASASIGNADAS (pendiente de confirmar).
 */
export function readVacationColumns(r: { pd: unknown; totalDias: number; totalHoras: number; diasAsignados: number; horasAsignadas: number; minutosDia: number }) {
  if (String(r.pd ?? '1').trim() !== '0') {
    return { unit: 'D' as const, days: r.totalDias, hours: r.totalHoras, assignedDays: r.diasAsignados, assignedHours: r.horasAsignadas };
  }
  const minutes = r.totalDias > 0 ? r.totalDias : Math.round(r.totalHoras * 60);
  const assigned = r.diasAsignados > 0 ? r.diasAsignados / 60 : r.horasAsignadas;
  return { unit: 'H' as const, days: 0, hours: Math.round((minutes / 60) * 100) / 100, assignedDays: 0, assignedHours: Math.round(assigned * 100) / 100,
    ...(r.minutosDia > 0 ? { minutesPerDay: r.minutosDia } : {}) };
}

const fmt = (d: string) => d.split('-').reverse().join('/');
const fmtNum = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 2 });
const fmtHours = (h: number) => fmtMin(Math.round(h * 60));
const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** Avisos de periodos vigentes (que acaban hoy o después) con más disfrutado que disponible. */
export function excessAlerts(vac: StoredVacationPeriod[], inc: StoredIncidenceLimit[], today: string): PeriodAlert[] {
  const out: PeriodAlert[] = [];
  for (const v of vac) {
    if (v.to < today) continue;
    if (v.unit === 'H') {
      if (v.assignedHours > v.hours) out.push({ employee: v.employee, text: `Vacaciones ${v.type} (${fmt(v.from)}–${fmt(v.to)}): tiene ${fmtHours(v.assignedHours)} h asignadas y solo le corresponden ${fmtHours(v.hours)} h.` });
      continue;
    }
    if (v.assignedDays > v.days) out.push({ employee: v.employee, text: `Vacaciones ${v.type} (${fmt(v.from)}–${fmt(v.to)}): tiene ${fmtNum(v.assignedDays)} días asignados y solo le corresponden ${fmtNum(v.days)}.` });
    else if (v.hours > 0 && v.assignedHours > v.hours) out.push({ employee: v.employee, text: `Vacaciones ${v.type} (${fmt(v.from)}–${fmt(v.to)}): tiene ${fmtNum(v.assignedHours)} horas asignadas y solo le corresponden ${fmtNum(v.hours)}.` });
  }
  for (const l of inc) {
    if (l.to < today || l.used <= l.value) continue;
    const show = (n: number) => (l.unit === 'D' ? `${fmtNum(n)} días` : `${fmtMin(n)} h`);
    out.push({ employee: l.employee, text: `Incidencia ${l.incidence} (${fmt(l.from)}–${fmt(l.to)}): lleva ${show(l.used)} y el límite es ${show(l.value)}.` });
  }
  return out;
}

/** Operaciones de los motores para los periodos (SQL Server y demostración). */
type PeriodDriver = Required<Pick<EvalosDriver, 'upsertVacationPeriods' | 'upsertIncidenceLimits' | 'listEmployeePeriods'>> & Pick<EvalosDriver, 'deletePeriods'>;
export function periodDriver(d: EvalosDriver): PeriodDriver | null {
  return d.upsertVacationPeriods && d.upsertIncidenceLimits && d.listEmployeePeriods ? (d as PeriodDriver) : null;
}

/**
 * Crea o actualiza los periodos de las personas indicadas según su convenio.
 *  mode 'current': periodo en curso (y actualiza el siguiente si ya existe).
 *  mode 'next': crea o actualiza el periodo siguiente al que está en curso.
 * Un periodo ya grabado se reconoce por persona + tipo/incidencia + FECHAFIN (que no depende de la fecha de alta):
 * si cambia la fecha de alta, se le corrige FECHAINICIO y se recalcula sin tocar lo disfrutado.
 * hireChange: corrección de la fecha de alta; los periodos que acaban antes de la nueva fecha se borran si no tienen
 * nada disfrutado (si lo tienen, se dejan y se avisa).
 * Solo personas en alta. Devuelve cuántas filas se han creado/actualizado/borrado y los avisos de exceso.
 */
export async function syncPeriods(driver: EvalosDriver, conv: Convenio, employees: Personal[], mode: 'current' | 'next', today: string,
  stamp: { date: string; time: string; user: string }, hireChange?: { from: string; to: string }): Promise<PeriodSyncResult> {
  const pd = periodDriver(driver);
  if (!pd) return { created: 0, updated: 0, alerts: [], warnings: ['Este motor no permite generar periodos de vacaciones ni de límites.'] };
  const people = employees.filter((e) => e.active);
  if (!people.length) return { created: 0, updated: 0, alerts: [], warnings: [] };
  const codes = people.map((e) => e.code);
  // Con corrección de la fecha de alta se miran también los periodos desde la fecha antigua (pueden ser futuros).
  const since = hireChange && hireChange.from < today ? hireChange.from : today;
  const existing = await pd.listEmployeePeriods(codes, since);
  const byEnd = {
    vac: new Map(existing.vacations.map((v) => [`${v.employee}|${v.type}|${v.to}`, v])),
    inc: new Map(existing.limits.map((l) => [`${l.employee}|${l.incidence}|${l.to}`, l]))
  };
  /** Periodo ya grabado con la misma FECHAFIN: se actualiza (y se le corrige FECHAINICIO si ha cambiado). */
  const link = <T extends { from: string; prevFrom?: string }>(row: T, found?: { from: string }) => (found && found.from !== row.from ? { ...row, prevFrom: found.from } : row);
  const vac: VacationPeriodRow[] = [], inc: IncidenceLimitRow[] = [];
  for (const e of people) {
    const cur = (_line: PeriodLine) => currentRef(e.hireDate, today);
    const nxt = (line: PeriodLine) => nextRef(line, currentRef(e.hireDate, today));
    const fv = (v: VacationPeriodRow) => byEnd.vac.get(`${v.employee}|${v.type}|${v.to}`);
    const fi = (l: IncidenceLimitRow) => byEnd.inc.get(`${l.employee}|${l.incidence}|${l.to}`);
    const r = rowsFor(conv, e, mode === 'next' ? nxt : cur);
    vac.push(...r.vac.map((v) => link(v, fv(v)))); inc.push(...r.inc.map((l) => link(l, fi(l))));
    if (mode === 'current') {
      // El siguiente solo se recalcula si ya se había generado.
      const n = rowsFor(conv, e, nxt);
      vac.push(...n.vac.filter((v) => fv(v)).map((v) => link(v, fv(v))));
      inc.push(...n.inc.filter((l) => fi(l)).map((l) => link(l, fi(l))));
    }
  }
  const warnings: string[] = [];
  const alerts: PeriodAlert[] = [];
  let created = 0, updated = 0, deleted = 0;
  // Corrección de la fecha de alta: periodos que acaban antes de la nueva fecha (ya no le corresponden).
  if (hireChange && pd.deletePeriods) {
    const gone = (x: { employee: string; to: string }) => x.to < hireChange.to && codes.includes(x.employee);
    const vGone = existing.vacations.filter(gone), iGone = existing.limits.filter(gone);
    const vDel = vGone.filter((v) => !v.assignedDays && !v.assignedHours), iDel = iGone.filter((l) => !l.used);
    for (const v of vGone.filter((x) => !vDel.includes(x))) alerts.push({ employee: v.employee, text: `El periodo de vacaciones ${v.type} (${fmt(v.from)}–${fmt(v.to)}) es anterior a la nueva fecha de alta, pero tiene ${v.unit === 'H' ? `${fmtHours(v.assignedHours)} h asignadas` : `${fmtNum(v.assignedDays)} días asignados`}: no se ha borrado. Revísalo en Evalos.` });
    for (const l of iGone.filter((x) => !iDel.includes(x))) alerts.push({ employee: l.employee, text: `El límite de la incidencia ${l.incidence} (${fmt(l.from)}–${fmt(l.to)}) es anterior a la nueva fecha de alta, pero ya tiene uso: no se ha borrado. Revísalo en Evalos.` });
    try {
      if (vDel.length) deleted += await pd.deletePeriods('vacations', vDel.map((v) => ({ employee: v.employee, code: v.type, from: v.from })));
      if (iDel.length) deleted += await pd.deletePeriods('limits', iDel.map((l) => ({ employee: l.employee, code: l.incidence, from: l.from })));
    } catch (e: any) { warnings.push(`No se pudieron borrar los periodos anteriores a la nueva fecha de alta: ${e?.message || e}`); }
  }
  if (vac.length) {
    try { const r = await pd.upsertVacationPeriods(vac, stamp); created += r.created; updated += r.updated; }
    catch (e: any) { warnings.push(`No se pudieron grabar los periodos de vacaciones: ${e?.message || e}`); }
  }
  if (inc.length) {
    try { const r = await pd.upsertIncidenceLimits(inc); created += r.created; updated += r.updated; }
    catch (e: any) { warnings.push(`No se pudieron grabar los límites de incidencia: ${e?.message || e}`); }
  }
  // Periodos vigentes de tipos o incidencias que el convenio no tiene (p. ej. del convenio anterior): se dejan.
  const types = new Set(conv.vacations.map((v) => v.type)), incs = new Set(conv.limits.map((l) => l.incidence));
  const after = await pd.listEmployeePeriods(codes, today);
  alerts.push(...excessAlerts(after.vacations, after.limits, today));
  for (const v of after.vacations) if (v.to >= today && !types.has(v.type)) alerts.push({ employee: v.employee, text: `Tiene un periodo de vacaciones ${v.type} (${fmt(v.from)}–${fmt(v.to)}) que no es de este convenio: se ha dejado como estaba.` });
  for (const l of after.limits) if (l.to >= today && !incs.has(l.incidence)) alerts.push({ employee: l.employee, text: `Tiene un límite de la incidencia ${l.incidence} (${fmt(l.from)}–${fmt(l.to)}) que no es de este convenio: se ha dejado como estaba.` });
  return { created, updated, deleted, alerts, warnings };
}

/** Avisos vigentes de unas personas (para la ficha de Personal y la pestaña Personal del convenio). */
export async function alertsFor(driver: EvalosDriver, employees: string[], today: string): Promise<PeriodAlert[]> {
  const pd = periodDriver(driver);
  if (!pd || !employees.length) return [];
  const p = await pd.listEmployeePeriods(employees, today);
  return excessAlerts(p.vacations, p.limits, today);
}
