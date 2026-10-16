// Atajos de Evalos · Teletrabajo: API del gestor de teletrabajo / presencial.
// Los datos de teletrabajo se guardan en Prime Suite; empleados, departamentos, festivos y ausencias se leen de Evalos.
import { Router, json, body, HttpError, clientIp } from '../http.ts';
import { audit, id } from '../db.ts';
import type { Ctx } from '../access.ts';
import { requireEvalos } from './evalos.ts';
import { driverFor } from '../evalos/config.ts';
import type { EvalosDriver } from '../evalos/types.ts';
import * as tw from '../evalos/telework.ts';

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-\d{2}$/;
const DAY_VALUE = /^(O|T|H(\d{1,2})(\.5)?)$/;
const log = (c: Ctx, req: Request, action: string, target?: string, detail?: string) =>
  audit({ actorId: c.user.id, actorEmail: c.user.email, companyId: c.company.id, action, target, detail, ip: clientIp(req) });

const todayIso = () => {
  // Día de hoy en España (los cálculos de «consumido» dependen de él).
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.TZ || 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p;
};

/** Normaliza fechas de Evalos (AAAAMMDD, AAAA-MM-DD, DD/MM/AAAA) a AAAA-MM-DD; '' si no hay. */
function normDate(v: unknown): string {
  const s = String(v ?? '').trim();
  if (!s || s === '0') return '';
  if (/^\d{8}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
  if (DATE.test(s.slice(0, 10))) return s.slice(0, 10);
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

interface Loaded {
  ctx: tw.CalcCtx;
  config: tw.TwConfig;
  employees: tw.EmployeeInfo[];
  departments: { code: string; description: string }[];
  calendars: { code: string; name: string; year: number }[];
  warnings: string[];
  engine: string;
}

/** Carga de Evalos y de Prime Suite todo lo necesario para calcular entre dos fechas. */
async function load(c: Ctx, from: string, to: string): Promise<Loaded> {
  const cid = c.company.id;
  const { driver, config: evCfg } = await driverFor(cid);
  const d = driver as EvalosDriver;
  const config = await tw.getConfig(cid);
  const warnings: string[] = [];

  // Empleados con contrato en el periodo
  let employees: tw.EmployeeInfo[] = [];
  try {
    if (d.listPersonal) {
      employees = (await d.listPersonal())
        .map((p) => ({ code: p.code, name: p.name, department: p.department || '', hireDate: normDate(p.hireDate), endDate: normDate(p.endDate) }))
        .filter((e) => !e.endDate || e.endDate >= from);
    } else if (d.listEmployees) {
      employees = (await d.listEmployees()).map((e) => ({ code: e.code, name: e.name, department: '' }));
    }
  } catch (e: any) {
    warnings.push(`No se han podido leer los empleados de Evalos: ${e.message}`);
  }
  employees.sort((a, b) => a.name.localeCompare(b.name, 'es'));

  let departments: { code: string; description: string }[] = [];
  try {
    departments = (await d.listDepartments()).map((x) => ({ code: x.code, description: x.description }));
  } catch { /* sin departamentos: se muestran los códigos */ }

  // Festivos del calendario elegido
  const holidays = new Set<string>();
  let calendars: { code: string; name: string; year: number }[] = [];
  if (d.listCalendars) {
    try { calendars = (await d.listCalendars()).map((x) => ({ code: x.code, name: x.name, year: x.year })); } catch { /* opcional */ }
  }
  if (config.settings.calendarCode && d.getCalendar) {
    try {
      const cal = await d.getCalendar(config.settings.calendarCode);
      for (const h of cal?.days || []) holidays.add(h.date);
    } catch (e: any) {
      warnings.push(`No se han podido leer los festivos del calendario ${config.settings.calendarCode}: ${e.message}`);
    }
  }

  // Ausencias (vacaciones, bajas, permisos)
  const absences = new Map<string, Set<string>>();
  if (d.listAusencias) {
    try {
      for (const a of await d.listAusencias()) {
        const af = normDate(a.from), at = normDate(a.to) || af;
        if (!af || at < from || af > to) continue;
        let s = absences.get(a.employee);
        if (!s) absences.set(a.employee, (s = new Set()));
        for (const day of tw.eachDay(af < from ? from : af, at > to ? to : at)) s.add(day);
      }
    } catch { /* las ausencias son opcionales */ }
  }

  const plans = await tw.loadPlans(cid, from, to);
  const ctx: tw.CalcCtx = { today: todayIso(), settings: config.settings, policies: config.policies, assignments: config.assignments, holidays, absences, plans };
  return { ctx, config, employees, departments, calendars, warnings, engine: evCfg.engine };
}

/** Empleados con contrato en algún día entre dos fechas. */
const withContract = (emps: tw.EmployeeInfo[], from: string, to: string) =>
  emps.filter((e) => (!e.endDate || e.endDate >= from) && (!e.hireDate || e.hireDate <= to));

/** Rango que hace falta cargar para la vista de un mes (bolsas anuales, arrastre y ventana legal de 3 meses). */
function rangeForMonth(month: string, carryOver: boolean) {
  const y = Number(month.slice(0, 4));
  const [yy, mm] = month.split('-').map(Number);
  const legalStart = tw.iso(new Date(Date.UTC(yy, mm - 3, 1)));
  const yearStart = `${carryOver ? y - 1 : y}-01-01`;
  return { from: legalStart < yearStart ? legalStart : yearStart, to: `${y}-12-31` };
}

function sanitizePolicy(p: any): tw.TwPolicy {
  const name = str(p?.name, 80);
  if (!name) throw new HttpError(400, 'Cada política necesita un nombre');
  const mode: tw.PolicyMode = ['presencial', 'hibrido', 'remoto'].includes(p?.mode) ? p.mode : 'hibrido';
  const unit: tw.PolicyUnit = p?.unit === 'hours' ? 'hours' : 'days';
  const period: tw.PolicyPeriod = ['week', 'month', 'quarter', 'year'].includes(p?.period) ? p.period : 'week';
  const days = Array.isArray(p?.preferredDays) ? [...new Set(p.preferredDays.map(Number).filter((n: number) => n >= 1 && n <= 7))] as number[] : [];
  return {
    id: str(p?.id, 40).replace(/[^a-zA-Z0-9_-]/g, '') || id().slice(0, 8),
    name, mode, unit, period,
    amount: Math.max(0, Math.min(unit === 'days' ? 366 : 3000, Number(p?.amount) || 0)),
    preferredDays: days.sort(),
    minOfficeDaysWeek: Math.max(0, Math.min(7, Math.round(Number(p?.minOfficeDaysWeek) || 0))),
    hoursPerDay: Math.max(1, Math.min(24, Number(p?.hoursPerDay) || 8)),
    color: /^#[0-9a-fA-F]{6}$/.test(p?.color) ? p.color : '#0E7C66'
  };
}

export function teletrabajoRoutes(r: Router) {
  // Vista de un mes: plan efectivo, bolsas, ocupación de la oficina y avisos.
  r.get('/api/evalos/teletrabajo', async (req) => {
    const { c, canEdit, canDelete } = await requireEvalos(req);
    const q = new URL(req.url).searchParams;
    const month = MONTH.test(q.get('month') || '') ? q.get('month')! : todayIso().slice(0, 7);
    const cfg = await tw.getConfig(c.company.id);
    const { from, to } = rangeForMonth(month, cfg.settings.carryOver);
    const L = await load(c, from, to);
    const view = tw.monthView(L.ctx, withContract(L.employees, `${month}-01`, tw.monthEnd(month)), month);
    return json({
      month, today: L.ctx.today, engine: L.engine,
      settings: L.config.settings, policies: L.config.policies, assignments: L.config.assignments,
      departments: L.departments, calendars: L.calendars,
      holidays: [...L.ctx.holidays].filter((d) => d.startsWith(month)),
      view, warnings: L.warnings,
      canEdit, canAdmin: canDelete
    });
  });

  // Cambiar días concretos (un clic en la planificación o el calendario del empleado).
  r.put('/api/evalos/teletrabajo/dias', async (req) => {
    const { c, canEdit } = await requireEvalos(req);
    if (!canEdit) throw new HttpError(403, 'Tu rol en Atajos de Evalos es de solo lectura');
    const b = await body(req);
    const list = Array.isArray(b.changes) ? b.changes.slice(0, 3000) : [];
    const changes = list.map((x: any) => {
      const employee = str(x?.employee, 60);
      const date = str(x?.date, 10);
      const value = x?.value === null || x?.value === '' ? null : str(x?.value, 6);
      if (!employee || !DATE.test(date)) throw new HttpError(400, 'Cambio no válido');
      if (value !== null && !DAY_VALUE.test(value)) throw new HttpError(400, `Valor de día no válido: ${value}`);
      return { employee, date, value };
    });
    await tw.savePlanChanges(c.company.id, changes);
    if (changes.length) await log(c, req, 'evalos.teletrabajo_plan', changes.length === 1 ? changes[0].employee : `${changes.length} días`, changes.length === 1 ? `${changes[0].date} → ${changes[0].value ?? 'sin plan'}` : undefined);
    return json({ ok: true, changed: changes.length });
  });

  // Comprueba unos cambios ANTES de guardarlos: cupo superado, mínimo presencial semanal y aforo.
  // La pantalla lo usa para avisar con una ventana y dejar decidir si se asigna igualmente.
  r.post('/api/evalos/teletrabajo/comprobar', async (req) => {
    const { c } = await requireEvalos(req);
    const b = await body(req);
    const changes = (Array.isArray(b.changes) ? b.changes.slice(0, 3000) : [])
      .map((x: any) => ({ employee: str(x?.employee, 60), date: str(x?.date, 10), value: x?.value === null || x?.value === '' ? null : str(x?.value, 6) }))
      .filter((x: { employee: string; date: string; value: string | null }) => x.employee && DATE.test(x.date) && (x.value === null || DAY_VALUE.test(x.value)));
    if (!changes.length) return json({ warnings: [] });
    const dates = changes.map((x: { date: string }) => x.date).sort();
    const cfg = await tw.getConfig(c.company.id);
    const y0 = Number(dates[0].slice(0, 4)) - (cfg.settings.carryOver ? 1 : 0);
    const y1 = Number(dates[dates.length - 1].slice(0, 4));
    const L = await load(c, `${y0}-01-01`, `${y1}-12-31`);
    const byCode = new Map(L.employees.map((e) => [e.code, e]));
    const warnings = tw.checkChanges(L.ctx, L.employees, changes).map((w) => ({ ...w, name: w.employee ? byCode.get(w.employee)?.name || w.employee : undefined }));
    return json({ warnings });
  });

  // Aplicar un patrón semanal (o el de la política de cada uno) a varios empleados en un rango de fechas.
  r.post('/api/evalos/teletrabajo/patron', async (req) => {
    const { c, canEdit } = await requireEvalos(req);
    if (!canEdit) throw new HttpError(403, 'Tu rol en Atajos de Evalos es de solo lectura');
    const b = await body(req);
    const from = str(b.from, 10), to = str(b.to, 10);
    if (!DATE.test(from) || !DATE.test(to) || to < from) throw new HttpError(400, 'Indica un rango de fechas válido');
    if (tw.eachDay(from, to).length > 400) throw new HttpError(400, 'El rango no puede superar un año');
    const L = await load(c, from, to);
    const wanted = Array.isArray(b.employees) ? new Set(b.employees.map((x: unknown) => String(x))) : null;
    const dept = str(b.department, 60);
    const emps = L.employees.filter((e) => (!wanted || wanted.has(e.code)) && (!dept || e.department === dept));
    if (!emps.length) throw new HttpError(400, 'No hay empleados a los que aplicar el patrón');
    let changes: ReturnType<typeof tw.patternChanges> = [];
    if (b.usePolicy) {
      for (const e of emps) changes.push(...tw.patternChanges(L.ctx, [e], from, to, tw.policyPattern(tw.policyFor(L.ctx, e.code, from)), !!b.overwrite));
    } else {
      const pattern: Record<string, string | null> = {};
      for (let i = 1; i <= 7; i++) {
        const v = b.pattern?.[i] ?? b.pattern?.[String(i)];
        if (v === null || v === undefined || v === '') continue;
        if (v !== 'clear' && !DAY_VALUE.test(String(v))) throw new HttpError(400, `Valor no válido para el día ${i}`);
        pattern[String(i)] = String(v);
      }
      changes = tw.patternChanges(L.ctx, emps, from, to, pattern, !!b.overwrite);
    }
    await tw.savePlanChanges(c.company.id, changes);
    await log(c, req, 'evalos.teletrabajo_patron', `${emps.length} empleado(s)`, `${from} → ${to} · ${changes.length} día(s)${b.usePolicy ? ' · según política' : ''}`);
    return json({ ok: true, changed: changes.length, employees: emps.length });
  });

  // Asignar política (y acuerdo de teletrabajo) a uno o varios empleados. assignment = null la quita.
  r.put('/api/evalos/teletrabajo/asignaciones', async (req) => {
    const { c, canEdit } = await requireEvalos(req);
    if (!canEdit) throw new HttpError(403, 'Tu rol en Atajos de Evalos es de solo lectura');
    const b = await body(req);
    const codes: string[] = Array.isArray(b.codes) ? b.codes.map((x: unknown) => str(x, 60)).filter(Boolean).slice(0, 2000) : [];
    if (!codes.length) throw new HttpError(400, 'Indica los empleados');
    const cfg = await tw.getConfig(c.company.id);
    let a: tw.TwAssignment | null = null;
    if (b.assignment) {
      const policyId = str(b.assignment.policyId, 40);
      if (!cfg.policies.some((p) => p.id === policyId)) throw new HttpError(400, 'Política no encontrada');
      const from = str(b.assignment.from, 10) || todayIso();
      const to = str(b.assignment.to, 10);
      if (!DATE.test(from) || (to && !DATE.test(to)) || (to && to < from)) throw new HttpError(400, 'Fechas de vigencia no válidas');
      const agreementDate = str(b.assignment.agreementDate, 10);
      a = {
        policyId, from, to: to || undefined,
        agreementSigned: !!b.assignment.agreementSigned,
        agreementDate: DATE.test(agreementDate) ? agreementDate : undefined,
        notes: str(b.assignment.notes, 500) || undefined
      };
    }
    for (const code of codes) {
      const cur = cfg.assignments[code];
      // keepExisting: solo cambia la política y conserva vigencia, acuerdo y notas que ya tuviera.
      if (a) cfg.assignments[code] = b.keepExisting && cur ? { ...cur, policyId: a.policyId } : { ...a };
      else delete cfg.assignments[code];
    }
    await tw.putConfig(c.company.id, cfg);
    await log(c, req, 'evalos.teletrabajo_asignacion', codes.length === 1 ? codes[0] : `${codes.length} empleados`, a ? `${a.policyId} desde ${a.from}${a.agreementSigned ? ' · acuerdo firmado' : ''}` : 'sin política');
    return json({ ok: true });
  });

  // Políticas (plantillas de cupo).
  r.put('/api/evalos/teletrabajo/politicas', async (req) => {
    const { c, canDelete } = await requireEvalos(req);
    if (!canDelete) throw new HttpError(403, 'Solo un administrador de Atajos de Evalos puede cambiar las políticas');
    const b = await body(req);
    if (!Array.isArray(b.policies) || !b.policies.length) throw new HttpError(400, 'Debe haber al menos una política');
    const policies = b.policies.slice(0, 50).map(sanitizePolicy);
    const ids = new Set<string>();
    for (const p of policies) { if (ids.has(p.id)) p.id = id().slice(0, 8); ids.add(p.id); }
    const cfg = await tw.getConfig(c.company.id);
    const inUse = [...new Set(Object.values(cfg.assignments).map((a) => a.policyId))].filter((pid) => !ids.has(pid));
    if (inUse.length) throw new HttpError(409, `No se puede eliminar una política asignada a empleados (${inUse.join(', ')}). Cámbiales antes la política.`);
    cfg.policies = policies;
    if (cfg.settings.defaultPolicyId && !ids.has(cfg.settings.defaultPolicyId)) cfg.settings.defaultPolicyId = policies[0].id;
    await tw.putConfig(c.company.id, cfg);
    await log(c, req, 'evalos.teletrabajo_politicas', `${policies.length} política(s)`);
    return json({ ok: true, policies });
  });

  // Ajustes generales: aforo, compensación, umbral legal, arrastre, festivos, mínimos por departamento.
  r.put('/api/evalos/teletrabajo/ajustes', async (req) => {
    const { c, canDelete } = await requireEvalos(req);
    if (!canDelete) throw new HttpError(403, 'Solo un administrador de Atajos de Evalos puede cambiar los ajustes');
    const b = (await body(req)).settings || {};
    const cfg = await tw.getConfig(c.company.id);
    const s = cfg.settings;
    const cap = b.officeCapacity === null || b.officeCapacity === '' ? null : Math.max(0, Math.round(Number(b.officeCapacity) || 0));
    const minByDept: Record<string, number> = {};
    for (const [k, v] of Object.entries(b.minOfficeByDept || {})) {
      const n = Math.max(0, Math.min(999, Math.round(Number(v) || 0)));
      if (str(k, 60) && n) minByDept[str(k, 60)] = n;
    }
    const workDays = Array.isArray(b.workDays) ? [...new Set(b.workDays.map(Number).filter((n: number) => n >= 1 && n <= 7))] as number[] : s.workDays;
    cfg.settings = {
      officeCapacity: b.officeCapacity === undefined ? s.officeCapacity : cap,
      allowancePerDay: b.allowancePerDay === undefined ? s.allowancePerDay : Math.max(0, Math.min(1000, Number(b.allowancePerDay) || 0)),
      legalThresholdPct: b.legalThresholdPct === undefined ? s.legalThresholdPct : Math.max(1, Math.min(100, Number(b.legalThresholdPct) || 30)),
      carryOver: b.carryOver === undefined ? s.carryOver : !!b.carryOver,
      maxCarryOver: b.maxCarryOver === undefined ? s.maxCarryOver : Math.max(0, Math.min(3000, Number(b.maxCarryOver) || 0)),
      calendarCode: b.calendarCode === undefined ? s.calendarCode : str(b.calendarCode, 40) || undefined,
      workDays: workDays.length ? workDays.sort() : [1, 2, 3, 4, 5],
      minOfficeByDept: b.minOfficeByDept === undefined ? s.minOfficeByDept : minByDept,
      defaultPolicyId: b.defaultPolicyId === undefined ? s.defaultPolicyId : (cfg.policies.some((p) => p.id === b.defaultPolicyId) ? b.defaultPolicyId : s.defaultPolicyId)
    };
    await tw.putConfig(c.company.id, cfg);
    await log(c, req, 'evalos.teletrabajo_ajustes');
    return json({ ok: true, settings: cfg.settings });
  });

  // Informe anual por empleado.
  r.get('/api/evalos/teletrabajo/informe', async (req) => {
    const { c } = await requireEvalos(req);
    const y = Number(new URL(req.url).searchParams.get('year')) || Number(todayIso().slice(0, 4));
    const year = Math.min(2100, Math.max(2000, y));
    const L = await load(c, `${year}-01-01`, `${year}-12-31`);
    return json({ year, rows: tw.yearReport(L.ctx, withContract(L.employees, `${year}-01-01`, `${year}-12-31`), year), allowancePerDay: L.config.settings.allowancePerDay, departments: L.departments });
  });

  // Resumen de hoy para el widget del Inicio.
  r.get('/api/evalos/teletrabajo/hoy', async (req) => {
    const { c, canEdit } = await requireEvalos(req);
    const today = todayIso();
    const cfg = await tw.getConfig(c.company.id);
    const { from, to } = rangeForMonth(today.slice(0, 7), cfg.settings.carryOver);
    const L = await load(c, from, to);
    const emps = withContract(L.employees, today, today);
    const v = tw.monthView(L.ctx, emps, today.slice(0, 7));
    const occ = v.occupancy[today];
    const workday = tw.isWorkday(L.ctx, today);
    // Hoy (si es laborable) y los siguientes laborables hasta 5, aunque crucen de mes:
    // para cada día, quién está en la oficina, en teletrabajo, mixto o ausente.
    const all = withContract(L.employees, today, tw.addDays(today, 14));
    type Who = 'O' | 'T' | 'H' | 'A';
    const days: { date: string; office: number; remote: number; absent: number; who: Record<string, Who>; hours: Record<string, number> }[] = [];
    for (let d = today, guard = 0; days.length < 5 && guard < 20 && d <= to; d = tw.addDays(d, 1), guard++) {
      if (!tw.isWorkday(L.ctx, d)) continue;
      const day = { date: d, office: 0, remote: 0, absent: 0, who: {} as Record<string, Who>, hours: {} as Record<string, number> };
      for (const e of all) {
        const ef = tw.effectiveDay(L.ctx, e, d);
        if (ef.k === 'A') { day.who[e.code] = 'A'; day.absent++; }
        else if (ef.k === 'T') { day.who[e.code] = 'T'; day.remote++; }
        else if (ef.k === 'O' || ef.k === 'H') {
          day.who[e.code] = ef.k; day.office++;
          if (ef.k === 'H') day.hours[e.code] = ef.h;
        }
      }
      days.push(day);
    }
    const nameOf = new Map(all.map((e) => [e.code, e.name]));
    const deptName = new Map(L.departments.map((x) => [x.code, x.description || x.code]));
    // Avisos más graves primero, con el nombre del empleado para poder abrirlo.
    const rank = { bad: 0, warn: 1, info: 2 } as const;
    const topAlerts = [...v.alerts].sort((a, b) => rank[a.level] - rank[b.level]).slice(0, 4)
      .map((a) => ({ level: a.level, employee: a.employee, name: a.employee ? nameOf.get(a.employee) || a.employee : undefined, date: a.date, text: a.text }));
    return json({
      today, workday, office: occ?.office || 0, remote: occ?.remote || 0, absent: occ?.absent || 0,
      capacity: L.config.settings.officeCapacity, employees: emps.length,
      alerts: v.alerts.length, exceeded: v.rows.filter((r) => r.balance.exceeded).length,
      next: days.map((d) => ({ date: d.date, office: d.office, remote: d.remote })),
      days,
      people: all.map((e) => ({ code: e.code, name: e.name, department: deptName.get(e.department) || e.department || '' })),
      topAlerts, canEdit
    });
  });
}
