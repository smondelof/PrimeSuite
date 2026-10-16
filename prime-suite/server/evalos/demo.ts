// Driver de demostración: datos ficticios guardados en el almacén del portal, para probar la interfaz
// sin una base de datos de Evalos 8. Se activa eligiendo "Demostración" en Configuración.
import { VACATION_TYPE_DEFAULTS } from './convenios.ts';
import { defaultEnd } from './convperiods.ts';
import { HttpError } from '../http.ts';
import { rawGet, rawSet, id as newId } from '../db.ts';
import {
  DEFAULT_MAPPING, type Ausencia, type Calendar, type CalendarDetail, type Convenio, type Department,
  type DepartmentEmployee, type DetectResult, type EmployeeBrief, type EvalosDriver, type Holiday,
  type ChangeStamp, type HistoryKind, type HistoryValue, type LookupItem, type NewNames, type PersonalHistory, type ReadmitInput, type Marcaje, type MarcajePunch, type Personal, type PersonalInput, type PersonalLimits, type PersonalLookups,
  type IncidenceLimitRow, type PeriodKey, type StoredIncidenceLimit, type StoredVacationPeriod, type VacationPeriodRow,
  type Solicitud, type VacationType, type VacationTypeCreated, type VacationTypesInfo,
  type WorkflowColumns, type WorkflowPlan, type WorkflowRow
} from './types.ts';
import { HISTORY, HISTORY_KINDS, ORG_KINDS, checkEndChange, checkReadmit, cardDescription, dmy, isoOf, madridNow, nextCode, prevDay, toEntry, ymdOf } from './history.ts';

interface DemoCalendar { code: string; name: string; year: number; employees: number; days: Holiday[] }

/** Tipos de vacaciones de ejemplo (equivalen a la tabla TIPOSVACACIONES). */
const DEMO_VACATION_TYPES: VacationType[] = [
  { code: 'V26', name: 'VACACIONES 2026', color: '#2e7d32' },
  { code: 'V27', name: 'VACACIONES 2027', color: '#1565c0' },
  { code: 'AP', name: 'ASUNTOS PROPIOS', color: '#ef6c00' }
];

/** Incidencias de ejemplo (equivalen a la tabla INCIDENC; tipo A = absentismo, S = salida en el día). */
const DEMO_INCIDENCES = [
  { code: '001', name: 'ASUNTOS PROPIOS', type: 'A' },
  { code: '002', name: 'ENFERMEDAD SIN BAJA', type: 'A' },
  { code: '003', name: 'VISITA MEDICO', type: 'S' },
  { code: '004', name: 'ACOMPANAMIENTO FAMILIAR', type: 'S' },
  { code: '005', name: 'MATRIMONIO', type: 'A' },
  { code: '006', name: 'FALLECIMIENTO FAMILIAR', type: 'A' },
  { code: '007', name: 'MUDANZA', type: 'A' },
  { code: '008', name: 'FORMACION', type: 'S' },
  { code: '009', name: 'CONSULTA ESPECIALISTA', type: 'S' },
  { code: '010', name: 'DEBER INEXCUSABLE', type: 'S' }
];
/** Empleado de demo. Fechas: endDate en aaaammdd (como Evalos), hireDate en AAAA-MM-DD. */
interface DemoEmployee {
  code: string; name: string; department: string; endDate: string; hireDate?: string;
  card?: string; email?: string; company?: string; section?: string; area?: string; consultas?: string; solicitudes?: string; convenio?: string;
  workflowRol?: string;
}
/** Fila de HIS_TARJETA en demo (fechas aaaammdd, baja '0' = sin baja). */
interface DemoRow { emp: string; value: string; falt: string; fbaj: string; tipo: string; fech: string; hora: string; usua: string }
interface DemoData {
  /** Tabla TARJETA y catálogos EMPRESA, SECCION y AREA (DEPMENTO es departments). */
  tarjetas?: { code: string; description: string }[];
  catalogs?: Record<'company' | 'section' | 'area', LookupItem[]>;
  /** Históricos HIS_TARJETA, HIS_EMPRESA, HIS_DEPMENTO, HIS_SECCION y HIS_AREA. */
  history?: Record<HistoryKind, DemoRow[]>;
  /** Periodos de alta/baja (HIS_VIGENCIA); value siempre ''. */
  periods?: DemoRow[];
  /** Formato anterior (solo tarjetas): se migra a history. */
  cardHistory?: { emp: string; card: string; falt: string; fbaj: string; tipo: string; fech: string; hora: string; usua: string }[];
  departments: { code: string; description: string }[];
  employees: DemoEmployee[];
  calendars: DemoCalendar[];
  convenios: Convenio[];
  vacationTypes?: VacationType[];
  /** Equivalentes a VACACIONES e INCIDENCIALIMITE. */
  vacPeriods?: StoredVacationPeriod[];
  incLimits?: StoredIncidenceLimit[];
  marcajes: Marcaje[];
  solicitudes: Solicitud[];
  ausencias: Ausencia[];
  /** Equivalentes a WORKFLOW, PS_WF2PERFILES y PS_WF2VALIDA. */
  workflow?: WorkflowRow[];
  wf2Profiles?: { code: string; clave: string }[];
  wfValida?: { employee: string; tipo: 'V' | 'D'; valor: string }[];
  /** Registro de la versión anterior por equipos (solo para borrar sus perfiles). */
  wfProfiles?: { code: string }[];
}

const FIRST = ['ANA', 'LUIS', 'MARTA', 'JORGE', 'LAURA', 'PABLO', 'ELENA', 'DAVID', 'SARA', 'RAÚL', 'NURIA', 'IVÁN', 'CLARA', 'ÓSCAR'];
const LAST = ['GARCÍA', 'MARTÍNEZ', 'LÓPEZ', 'SÁNCHEZ', 'PÉREZ', 'GÓMEZ', 'RUIZ', 'DÍAZ', 'MORENO', 'MUÑOZ', 'ÁLVAREZ', 'ROMERO', 'NAVARRO', 'TORRES'];

// Festivos de ejemplo (Cataluña / Barcelona) para el año en curso del calendario demo.
function holidays2026(): Holiday[] {
  return [
    { date: '2026-01-01', type: 'NACIONAL', description: 'Año Nuevo' },
    { date: '2026-01-06', type: 'NACIONAL', description: 'Reyes' },
    { date: '2026-04-03', type: 'NACIONAL', description: 'Viernes Santo' },
    { date: '2026-04-06', type: 'AUTONOMICO', description: 'Lunes de Pascua' },
    { date: '2026-05-01', type: 'NACIONAL', description: 'Fiesta del Trabajo' },
    { date: '2026-06-24', type: 'AUTONOMICO', description: 'Sant Joan' },
    { date: '2026-08-15', type: 'NACIONAL', description: 'Asunción' },
    { date: '2026-09-11', type: 'AUTONOMICO', description: 'Diada de Catalunya' },
    { date: '2026-09-24', type: 'LOCAL', description: 'La Mercè (Barcelona)' },
    { date: '2026-10-12', type: 'NACIONAL', description: 'Fiesta Nacional' },
    { date: '2026-11-01', type: 'NACIONAL', description: 'Todos los Santos' },
    { date: '2026-12-06', type: 'NACIONAL', description: 'Constitución' },
    { date: '2026-12-08', type: 'NACIONAL', description: 'Inmaculada' },
    { date: '2026-12-25', type: 'NACIONAL', description: 'Navidad' },
    { date: '2026-12-26', type: 'AUTONOMICO', description: 'Sant Esteve' }
  ];
}

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function recentWeekdays(n: number): string[] {
  const out: string[] = [];
  const d = new Date();
  while (out.length < n) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) out.push(iso(d));
    d.setDate(d.getDate() - 1);
  }
  return out;
}

function seed(): DemoData {
  const departments = [
    { code: 'ADMIN', description: 'ADMINISTRACIÓN' },
    { code: 'COMERCIAL', description: 'COMERCIAL' },
    { code: 'INFORMATICA', description: 'INFORMÁTICA' },
    { code: 'LOGISTICA', description: 'LOGÍSTICA Y ALMACÉN' },
    { code: 'PRODUCCION', description: 'PRODUCCIÓN' },
    { code: 'RRHH', description: 'RECURSOS HUMANOS' },
    { code: 'SAT', description: 'SERVICIO TÉCNICO' }
  ];
  const sizes = [5, 8, 6, 9, 14, 4, 0];
  const employees: DemoData['employees'] = [];
  let n = 1;
  departments.forEach((d, di) => {
    for (let i = 0; i < sizes[di]; i++, n++) {
      const name = `${LAST[(n * 3) % LAST.length]} ${LAST[(n * 5 + 1) % LAST.length]}, ${FIRST[(n * 7) % FIRST.length]}`;
      const hy = 2003 + ((n * 7) % 22); // antigüedad variada 2003-2024
      const hireDate = `${hy}-${String(1 + ((n * 3) % 12)).padStart(2, '0')}-${String(1 + ((n * 5) % 27)).padStart(2, '0')}`;
      employees.push({
        code: String(10000000 + n), name, department: d.code, endDate: n % 6 === 0 ? '20250630' : '', hireDate,
        card: String(4000 + n), company: 'PRIMION', section: ['OFI', 'TALLER', 'CAMPO'][n % 3], area: ['NORTE', 'CENTRO', 'ESTE'][n % 3], consultas: '001', solicitudes: '001', convenio: ['OFI', 'PROD', 'COM'][n % 3]
      });
    }
  });

  const convenios: Convenio[] = [
    { code: 'OFI', name: 'CONVENIO OFICINAS', vacations: [{ type: 'AP', day: 1, month: 1, unit: 'H', days: 0, minutes: 16 * 60, minutesPerDay: 480 }, { type: 'V26', day: 1, month: 1, days: 23, pluses: [{ years: 5, value: 1 }, { years: 10, value: 2 }] }], incidenceDay: 1, incidenceMonth: 1,
      limits: [{ incidence: '001', unit: 'H', value: 24 * 60 }, { incidence: '003', unit: 'H', value: 20 * 60 }, { incidence: '007', unit: 'H', value: 8 * 60 }] },
    { code: 'PROD', name: 'CONVENIO PRODUCCION', vacations: [{ type: 'V26', day: 1, month: 4, days: 22 }], incidenceDay: 1, incidenceMonth: 1,
      limits: [{ incidence: '001', unit: 'H', value: 16 * 60 }, { incidence: '003', unit: 'H', value: 16 * 60 }, { incidence: '005', unit: 'H', value: 120 * 60 }] },
    { code: 'COM', name: 'CONVENIO COMERCIO', vacations: [{ type: 'V26', day: 1, month: 1, days: 30 }], incidenceDay: 1, incidenceMonth: 9,
      limits: [{ incidence: '003', unit: 'H', value: 35 * 60 + 30 }] }
  ];
  const calendars: DemoCalendar[] = [
    { code: 'OFI2026', name: 'Oficinas 2026', year: 2026, employees: 15, days: holidays2026() },
    { code: 'FAB2026', name: 'Fábrica · turnos 2026', year: 2026, employees: 23, days: holidays2026() },
    { code: 'COM2026', name: 'Comercial 2026', year: 2026, employees: 8, days: holidays2026() }
  ];

  // Marcajes de los últimos días laborables, con alguna incidencia.
  const days = recentWeekdays(6);
  const pick = employees.slice(0, 10);
  const marcajes: Marcaje[] = [];
  pick.forEach((e, i) => {
    const day = days[i % days.length];
    const anomaly = i % 4;
    if (anomaly === 1) marcajes.push({ id: `${e.code}-${day}`, employee: e.code, employeeName: e.name, date: day, punches: [{ time: '08:03', type: 'E' }], status: 'INCIDENCIA', issue: 'Falta el marcaje de salida' });
    else if (anomaly === 2) marcajes.push({ id: `${e.code}-${day}`, employee: e.code, employeeName: e.name, date: day, punches: [{ time: '09:47', type: 'E' }, { time: '18:10', type: 'S' }], status: 'INCIDENCIA', issue: 'Entrada fuera de horario (retraso)' });
    else marcajes.push({ id: `${e.code}-${day}`, employee: e.code, employeeName: e.name, date: day, punches: [{ time: '08:00', type: 'E' }, { time: '13:30', type: 'S' }, { time: '14:30', type: 'E' }, { time: '17:30', type: 'S' }], status: 'OK' });
  });

  const d0 = days[0];
  const solicitudes: Solicitud[] = [
    { id: 's1', employee: pick[0].code, employeeName: pick[0].name, type: 'Vacaciones', from: '2026-08-03', to: '2026-08-14', days: 10, reason: 'Vacaciones de verano', status: 'PENDIENTE', createdAt: d0 },
    { id: 's2', employee: pick[2].code, employeeName: pick[2].name, type: 'Permiso retribuido', from: '2026-10-09', to: '2026-10-09', days: 1, reason: 'Asunto médico', status: 'PENDIENTE', createdAt: d0 },
    { id: 's3', employee: pick[4].code, employeeName: pick[4].name, type: 'Cambio de turno', from: '2026-10-15', to: '2026-10-15', days: 1, reason: 'Turno de tarde por mañana', status: 'PENDIENTE', createdAt: d0 },
    { id: 's4', employee: pick[6].code, employeeName: pick[6].name, type: 'Asuntos propios', from: '2026-11-02', to: '2026-11-02', days: 1, status: 'APROBADA', createdAt: d0 }
  ];
  const ausencias: Ausencia[] = [
    { id: 'a1', employee: pick[1].code, employeeName: pick[1].name, type: 'Enfermedad común', from: '2026-09-28', to: '2026-10-02', days: 5, reason: 'Baja IT' },
    { id: 'a2', employee: pick[3].code, employeeName: pick[3].name, type: 'Permiso retribuido', from: '2026-10-01', to: '2026-10-01', days: 1, reason: 'Mudanza' },
    { id: 'a3', employee: pick[5].code, employeeName: pick[5].name, type: 'Vacaciones', from: '2026-08-01', to: '2026-08-15', days: 11 }
  ];

  return { departments, employees, calendars, convenios, marcajes, solicitudes, ausencias };
}

/** Perfil de WORKFLOW de ejemplo con las columnas que usa Prime Suite. */
function demoWfRow(code: string, desc: string, extra: WorkflowRow = {}): WorkflowRow {
  const r: WorkflowRow = { WF_CODI: code, WF_DESC: desc, WF_NIV1: '', WF_NIV2: '', WF_NIV3: '', WF_NIV4: '' };
  for (const c of ['WF_CAHO', 'WF_OLMA', 'WF_MAHA', 'WF_HDIA', 'WF_DCAB', 'WF_VACA', 'WF_PEIN', 'WF_CAINMA', 'WF_HOIN']) r[c] = '';
  return { ...r, WF_ANUL: '0', WF_ANUL_TIP: '2,3,6,9', WF_VFIL: 'N', WF_FILT: '', WF_VIGENTES: 'N', WF_WOFL: 'N', WF_WOFL_ANUL: 'N', WF_AELIOU: 'N', WF_AINSOU: 'N', WF_AANUOU: 'N', WF_AADJ: 'S', ...extra };
}
/** WORKFLOW de ejemplo: dos perfiles manuales y las plantillas de los tres roles (997, 998, 999). */
const DEMO_WORKFLOW: WorkflowRow[] = [
  demoWfRow('001', 'SOLICITUDES ESTÁNDAR', { WF_NIV1: '10000006', WF_CAHO: '1', WF_VACA: '1', WF_DCAB: '1' }),
  demoWfRow('002', 'SOLICITUDES RESPONSABLES', { WF_VFIL: 'S', WF_WOFL: 'S' }),
  demoWfRow('997', 'PLANTILLA EMPLEADO'),
  demoWfRow('998', 'PLANTILLA RESPONSABLE', { WF_VFIL: 'S', WF_VIGENTES: 'S', WF_WOFL: 'S', WF_WOFL_ANUL: 'S', WF_AELIOU: 'S', WF_AINSOU: 'S', WF_AANUOU: 'S' }),
  demoWfRow('999', 'PLANTILLA RRHH', { WF_VFIL: 'S', WF_VIGENTES: 'S', WF_WOFL: 'S', WF_WOFL_ANUL: 'S', WF_AELIOU: 'S', WF_AINSOU: 'S', WF_AANUOU: 'S' })
];

/** Catálogos de los desplegables de Personal en modo demostración. */
const DEMO_LOOKUPS: Omit<PersonalLookups, 'department' | 'convenio'> = {
  company: [{ code: 'PRIMION', description: 'PRIMION DIGITEK S.L.' }, { code: 'FILIAL', description: 'PRIMION SERVICIOS' }],
  section: [{ code: 'OFI', description: 'OFICINAS' }, { code: 'TALLER', description: 'TALLER' }, { code: 'CAMPO', description: 'PERSONAL DE CAMPO' }],
  area: [{ code: 'NORTE', description: 'ZONA NORTE' }, { code: 'CENTRO', description: 'ZONA CENTRO' }, { code: 'ESTE', description: 'ZONA ESTE' }],
  consultas: [{ code: '001', description: 'CONSULTA BÁSICA' }, { code: '002', description: 'CONSULTA COMPLETA' }],
  solicitudes: [{ code: '001', description: 'SOLICITUDES ESTÁNDAR' }, { code: '002', description: 'SOLICITUDES RESPONSABLES' }]
};
const ymdToIso = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '');

const ymd = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};
const isActive = (end: string) => !end || end === '0' || end >= ymd();
const daysBetween = (from: string, to: string) => Math.max(1, Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1);

export class DemoDriver implements EvalosDriver {
  constructor(private companyId: string) {}
  private key() { return `evalos-demo/${this.companyId}`; }
  private async load(): Promise<DemoData> {
    let d = await rawGet<DemoData>(this.key());
    if (!d) { d = seed(); await rawSet(this.key(), d); }
    // Compatibilidad con almacenes de demo anteriores (solo departamentos/empleados).
    if (!d.calendars || !d.convenios || !d.marcajes) { const s = seed(); d = { ...s, departments: d.departments, employees: d.employees.map((e) => ({ ...e, hireDate: e.hireDate })) }; await rawSet(this.key(), d); }
    // Convenios con el modelo anterior (días base, horas/año, antigüedad): se sustituyen por los de ejemplo.
    if (d.convenios.some((c) => !Array.isArray((c as Partial<Convenio>).vacations))) { d.convenios = seed().convenios; await rawSet(this.key(), d); }
    // Convenios sin fin de periodo (versión anterior): un año menos un día.
    if (d.convenios.some((c) => !c.incidenceEndDay || c.vacations.some((v) => !v.endDay))) {
      for (const c of d.convenios) {
        if (!c.incidenceEndDay) { const e = defaultEnd(c.incidenceDay, c.incidenceMonth); Object.assign(c, { incidenceEndDay: e.endDay, incidenceEndMonth: e.endMonth, incidenceEndNextYear: e.endNextYear }); }
        c.vacations = c.vacations.map((v) => (v.endDay ? v : { ...v, ...defaultEnd(v.day, v.month) }));
      }
      await rawSet(this.key(), d);
    }
    // Límites en días de la versión anterior: las incidencias van siempre en horas (8 h por día).
    if (d.convenios.some((c) => c.limits.some((l) => (l as any).unit === 'D'))) {
      const toMin = (n: number) => Math.round(n * 8 * 60);
      for (const c of d.convenios) c.limits = c.limits.map((l) => ((l as any).unit === 'D'
        ? { ...l, unit: 'H' as const, value: toMin(l.value), pluses: (l.pluses || []).map((p) => ({ ...p, value: toMin(p.value) })) } : l));
      await rawSet(this.key(), d);
    }
    // Históricos: las fichas de demo anteriores solo tenían los campos EM_*; se crean sus tramos desde la fecha de alta.
    if (!d.periods) {
      d.periods = d.employees.map((e) => ({ emp: e.code, value: '', falt: ymdOf(e.hireDate || '2020-01-01'), fbaj: e.endDate || '0', tipo: e.endDate ? 'B' : 'A', fech: '', hora: '', usua: 'DEM' }));
      await rawSet(this.key(), d);
    }
    if (!d.history || !d.catalogs) {
      const old = d.cardHistory;
      d.catalogs ||= JSON.parse(JSON.stringify(DEMO_LOOKUPS));
      d.tarjetas ||= [];
      const h = { card: [], company: [], department: [], section: [], area: [] } as Record<HistoryKind, DemoRow[]>;
      for (const e of d.employees) {
        const falt = ymdOf(e.hireDate || '2020-01-01');
        for (const k of HISTORY_KINDS) {
          const v = (e as any)[HISTORY[k].field] as string | undefined;
          if (!v || (k === 'card' && old)) continue;
          h[k].push({ emp: e.code, value: v, falt, fbaj: '0', tipo: 'A', fech: '', hora: '', usua: 'DEM' });
          if (k === 'card' && !d.tarjetas.some((t) => t.code === v)) d.tarjetas.push({ code: v, description: cardDescription(v) });
        }
      }
      if (old) h.card = old.map((r) => ({ emp: r.emp, value: r.card, falt: r.falt, fbaj: r.fbaj, tipo: r.tipo, fech: r.fech, hora: r.hora, usua: r.usua }));
      d.history = h;
      delete d.cardHistory;
      await rawSet(this.key(), d);
    }
    return d;
  }
  private save(d: DemoData) { return rawSet(this.key(), d); }

  async info() { return { engine: 'demo' as const, server: 'Datos de demostración', database: 'EVALOS_DEMO', version: 'Prime Suite' }; }
  async detect(): Promise<DetectResult> {
    return { mapping: { ...DEFAULT_MAPPING, departments: { table: 'DEPMENTO', code: 'DE_CODI', description: 'DE_DESC' } }, candidates: [], warnings: ['Modo demostración: no hay base de datos real que analizar.'] };
  }
  async departmentLimits() { return { code: 12, description: 40 }; }

  private count(d: DemoData, code: string): Department {
    const dep = d.departments.find((x) => x.code === code)!;
    const emps = d.employees.filter((e) => e.department === code);
    return { ...dep, employees: emps.length, active: emps.filter((e) => isActive(e.endDate)).length };
  }
  async listDepartments() {
    const d = await this.load();
    return d.departments.map((x) => this.count(d, x.code)).sort((a, b) => a.code.localeCompare(b.code));
  }
  async getDepartment(code: string) {
    const d = await this.load();
    return d.departments.some((x) => x.code === code) ? this.count(d, code) : null;
  }
  async createDepartment(code: string, description: string) {
    const d = await this.load();
    if (d.departments.some((x) => x.code === code)) throw new HttpError(409, `Ya existe el departamento ${code}`);
    d.departments.push({ code, description });
    await this.save(d);
  }
  async updateDepartment(code: string, description: string) {
    const d = await this.load();
    const x = d.departments.find((y) => y.code === code);
    if (!x) throw new HttpError(404, `No existe el departamento ${code}`);
    x.description = description;
    await this.save(d);
  }
  async deleteDepartment(code: string) {
    const d = await this.load();
    const n = d.employees.filter((e) => e.department === code).length;
    if (n) throw new HttpError(409, `No se puede eliminar: ${n} empleado(s) tienen asignado el departamento ${code}.`);
    if (!d.departments.some((x) => x.code === code)) throw new HttpError(404, `No existe el departamento ${code}`);
    d.departments = d.departments.filter((x) => x.code !== code);
    await this.save(d);
  }
  async departmentEmployees(code: string): Promise<DepartmentEmployee[]> {
    const d = await this.load();
    return d.employees
      .filter((e) => e.department === code)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((e) => ({ code: e.code, name: e.name, active: isActive(e.endDate), endDate: e.endDate ? `${e.endDate.slice(6)}/${e.endDate.slice(4, 6)}/${e.endDate.slice(0, 4)}` : undefined }));
  }

  async listEmployees(): Promise<EmployeeBrief[]> {
    const d = await this.load();
    return d.employees.filter((e) => isActive(e.endDate)).map((e) => ({ code: e.code, name: e.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  // ---------- Personal ----------
  private toPersonal(e: DemoEmployee): Personal {
    return {
      code: e.code, name: e.name, card: e.card || '', email: e.email || '', hireDate: e.hireDate || '', endDate: ymdToIso(e.endDate),
      company: e.company || '', department: e.department || '', section: e.section || '', area: e.area || '',
      consultas: e.consultas || '', solicitudes: e.solicitudes || '', convenio: e.convenio || '',
      workflowRol: e.workflowRol || '', active: isActive(e.endDate)
    };
  }
  private fromInput(p: PersonalInput): DemoEmployee {
    return {
      code: p.code, name: p.name, card: p.card, email: p.email, hireDate: p.hireDate, endDate: p.endDate.replace(/-/g, ''),
      company: p.company, department: p.department, section: p.section, area: p.area, consultas: p.consultas, solicitudes: p.solicitudes, convenio: p.convenio || undefined,
      workflowRol: p.workflowRol || undefined
    };
  }
  private rows(d: DemoData, k: HistoryKind) {
    d.history ||= { card: [], company: [], department: [], section: [], area: [] };
    return (d.history[k] ||= []);
  }
  private isOpenAt(r: DemoRow, ymd: string) { return !r.fbaj || r.fbaj === '0' || r.fbaj >= ymd; }
  private master(d: DemoData, k: HistoryKind): LookupItem[] {
    if (k === 'card') return (d.tarjetas ||= []);
    if (k === 'department') return d.departments;
    d.catalogs ||= JSON.parse(JSON.stringify(DEMO_LOOKUPS));
    return d.catalogs![k];
  }
  /** Código para un valor: el indicado, uno existente con el mismo nombre o uno nuevo con código automático. */
  private resolve(d: DemoData, k: HistoryKind, v: HistoryValue): string {
    if ('code' in v) {
      if (k === 'card' && !this.master(d, k).some((x) => x.code === v.code)) this.master(d, k).push({ code: v.code, description: cardDescription(v.code) });
      return v.code;
    }
    const list = this.master(d, k);
    const same = list.find((x) => x.description.toUpperCase() === v.name.toUpperCase());
    if (same) return same.code;
    const code = nextCode(list.map((x) => x.code), 15);
    list.push({ code, description: v.name });
    return code;
  }
  private checkCardFree(d: DemoData, card: string, code: string, fromIso: string) {
    const r = this.rows(d, 'card').filter((x) => x.value === card && x.emp !== code && this.isOpenAt(x, ymdOf(fromIso))).sort((a, b) => b.falt.localeCompare(a.falt))[0];
    if (r) {
      const until = r.fbaj && r.fbaj !== '0' ? isoOf(r.fbaj) : '';
      throw new HttpError(409, `La tarjeta ${card} la tiene asignada el empleado ${r.emp}${until ? ` hasta el ${dmy(until)}` : ' sin fecha de baja'}.`);
    }
  }
  private addTramo(d: DemoData, k: HistoryKind, code: string, value: string, fromIso: string, stamp: ChangeStamp) {
    this.rows(d, k).push({ emp: code, value, falt: ymdOf(fromIso), fbaj: '0', tipo: 'A', fech: stamp.date, hora: stamp.time, usua: stamp.user });
  }
  /** Campo EM_* = valor vigente más reciente (antes los tramos sin baja). */
  private syncField(d: DemoData, k: HistoryKind, code: string, today: string) {
    const e = d.employees.find((x) => x.code === code);
    if (!e) return;
    const noEnd = (r: DemoRow) => (!r.fbaj || r.fbaj === '0' ? 0 : 1);
    const open = this.rows(d, k).filter((r) => r.emp === code && this.isOpenAt(r, today)).sort((a, b) => noEnd(a) - noEnd(b) || b.falt.localeCompare(a.falt));
    (e as any)[HISTORY[k].field] = open[0]?.value || '';
  }
  async listPersonal(): Promise<Personal[]> {
    const d = await this.load();
    return d.employees.map((e) => this.toPersonal(e)).sort((a, b) => a.code.localeCompare(b.code));
  }
  async getPersonal(code: string) {
    const e = (await this.load()).employees.find((x) => x.code === code);
    return e ? this.toPersonal(e) : null;
  }
  async createPersonal(p: PersonalInput, stamp: ChangeStamp, newNames: NewNames = {}) {
    const d = await this.load();
    if (d.employees.some((e) => e.code === p.code)) throw new HttpError(409, `Ya existe el empleado ${p.code}`);
    if (p.card) this.checkCardFree(d, p.card, p.code, p.hireDate);
    const emp = { ...p };
    for (const k of ORG_KINDS) if (newNames[k] && !emp[k]) emp[k] = this.resolve(d, k, { name: newNames[k]! });
    d.employees.push(this.fromInput(emp));
    for (const k of HISTORY_KINDS) {
      const v = emp[HISTORY[k].field];
      if (!v) continue;
      if (k === 'card') this.resolve(d, k, { code: v });
      this.addTramo(d, k, emp.code, v, emp.hireDate, stamp);
    }
    this.periodRows(d).push({ emp: emp.code, value: '', falt: ymdOf(emp.hireDate), fbaj: '0', tipo: 'A', fech: stamp.date, hora: stamp.time, usua: stamp.user });
    if (emp.endDate) this.closeAllAt(d, emp.code, emp.endDate, emp.hireDate, stamp);
    await this.save(d);
  }
  async updatePersonal(code: string, p: Omit<PersonalInput, 'code'>, stamp: ChangeStamp) {
    const d = await this.load();
    const i = d.employees.findIndex((e) => e.code === code);
    if (i < 0) throw new HttpError(404, `No existe el empleado ${code}`);
    const cur = d.employees[i];
    const curEnd = ymdToIso(cur.endDate);
    checkEndChange(code, curEnd, p.endDate);
    // Corrección de la fecha de alta: los tramos que empezaban en la antigua pasan a la nueva (409 si hay conflicto).
    const movedTramos = p.hireDate && cur.hireDate && p.hireDate !== cur.hireDate ? this.moveHireTramos(d, code, cur.hireDate, p.hireDate, stamp) : [];
    if (p.endDate && p.endDate !== curEnd) this.closeAllAt(d, code, p.endDate, p.hireDate || cur.hireDate || '', stamp);
    // Tarjeta y organización solo cambian por su histórico.
    d.employees[i] = { ...this.fromInput({ ...p, code }), card: cur.card, company: cur.company, department: cur.department, section: cur.section, area: cur.area };
    await this.save(d);
    return { movedTramos };
  }
  /** Igual que en SQL Server: comprueba todo antes de cambiar nada. */
  private moveHireTramos(d: DemoData, code: string, oldHire: string, newHire: string, stamp: ChangeStamp) {
    const o = ymdOf(oldHire), n = ymdOf(newHire), later = n > o;
    const closedBefore = (f: string) => !!f && f !== '0' && f < n;
    const open = (r: DemoRow) => !r.fbaj || r.fbaj === '0' || r.fbaj >= n;
    const changes: DemoRow[] = [];
    const moved: string[] = [];
    const vig = this.periodRows(d).filter((r) => r.emp === code && r.falt === o);
    if (vig.length) {
      if (vig.some((r) => closedBefore(r.fbaj))) throw new HttpError(409, `El periodo de alta que empieza el ${dmy(oldHire)} termina antes del ${dmy(newHire)}: no se puede mover la fecha de alta.`);
      if (!later && this.periodRows(d).some((r) => r.emp === code && r.falt < o && open(r))) throw new HttpError(409, `Con la nueva fecha de alta (${dmy(newHire)}) se solaparía con su periodo de alta anterior.`);
      changes.push(...vig); moved.push('periodo de alta');
    }
    for (const k of HISTORY_KINDS) {
      const def = HISTORY[k];
      const rows = this.rows(d, k);
      const targets = rows.filter((r) => r.emp === code && r.falt === o);
      if (!targets.length) continue;
      const bad = targets.find((r) => closedBefore(r.fbaj));
      if (bad) throw new HttpError(409, `${def.label.charAt(0).toUpperCase() + def.label.slice(1)} ${bad.value} se le quitó el ${dmy(isoOf(bad.fbaj))}, antes de la nueva fecha de alta (${dmy(newHire)}). Corrígelo antes en su historial.`);
      if (later) {
        const mid = rows.find((r) => r.emp === code && r.falt > o && r.falt < n);
        if (mid) throw new HttpError(409, `Tiene ${def.label} ${mid.value} desde el ${dmy(isoOf(mid.falt))}, antes de la nueva fecha de alta (${dmy(newHire)}). Corrígelo antes en su historial.`);
      } else if (def.exclusive) {
        const ov = rows.find((r) => r.emp === code && r.falt < o && open(r));
        if (ov) throw new HttpError(409, `Con la nueva fecha de alta (${dmy(newHire)}) ${def.label} se solaparía con un tramo anterior (${ov.value}). Corrígelo antes en su historial.`);
      } else {
        for (const t of targets) {
          const other = rows.find((r) => r.value === t.value && r.emp !== code && r.falt < o && open(r));
          if (other) throw new HttpError(409, `La tarjeta ${t.value} la tenía el empleado ${other.emp} entre el ${dmy(newHire)} y el ${dmy(oldHire)}: no se puede adelantar la fecha de alta.`);
        }
      }
      changes.push(...targets); moved.push(def.label.replace(/^(la|el) /, ''));
    }
    for (const r of changes) Object.assign(r, { falt: n, fech: stamp.date, hora: stamp.time, usua: stamp.user });
    return moved;
  }
  private periodRows(d: DemoData) { return (d.periods ||= []); }
  /** Baja del empleado: cierra con esa fecha todos sus tramos y su periodo abiertos ese día; 409 si alguno empieza después. */
  private closeAllAt(d: DemoData, code: string, end: string, hireDate: string, stamp: ChangeStamp) {
    const endYmd = ymdOf(end);
    const later = HISTORY_KINDS.flatMap((k) => this.rows(d, k).filter((r) => r.emp === code && r.falt > endYmd).map((r) => `${HISTORY[k].label} ${r.value} (desde el ${dmy(isoOf(r.falt))})`))
      .concat(this.periodRows(d).filter((r) => r.emp === code && r.falt > endYmd).map((r) => `el periodo de alta que empieza el ${dmy(isoOf(r.falt))}`));
    if (later.length) throw new HttpError(409, `No se puede dar de baja el ${dmy(end)}: estos tramos empiezan después y no se pueden cerrar antes de empezar: ${later.join(', ')}. Elimínalos o ajusta la fecha de baja.`);
    const close = (r: DemoRow) => Object.assign(r, { fbaj: endYmd, tipo: 'B', fech: stamp.date, hora: stamp.time, usua: stamp.user });
    const isOpenAfter = (r: DemoRow) => r.emp === code && (!r.fbaj || r.fbaj === '0' || r.fbaj > endYmd);
    for (const k of HISTORY_KINDS) for (const r of this.rows(d, k)) if (isOpenAfter(r)) close(r);
    const periods = this.periodRows(d);
    const open = periods.filter(isOpenAfter);
    open.forEach(close);
    if (!open.length && !periods.some((r) => r.emp === code) && hireDate) {
      periods.push({ emp: code, value: '', falt: ymdOf(hireDate), fbaj: endYmd, tipo: 'B', fech: stamp.date, hora: stamp.time, usua: stamp.user });
    }
  }
  async personalPeriods(code: string) {
    const d = await this.load();
    const today = madridNow().date;
    return this.periodRows(d).filter((r) => r.emp === code).sort((a, b) => b.falt.localeCompare(a.falt)).map((r) => toEntry(r, today));
  }
  async readmitPersonal(code: string, r: ReadmitInput, stamp: ChangeStamp, newNames: NewNames = {}) {
    const d = await this.load();
    const e = d.employees.find((x) => x.code === code);
    if (!e) throw new HttpError(404, `No existe el empleado ${code}`);
    const curEnd = ymdToIso(e.endDate);
    checkReadmit(code, curEnd, r.hireDate);
    const v: ReadmitInput = { ...r };
    for (const k of ORG_KINDS) if (newNames[k] && !v[k]) v[k] = this.resolve(d, k, { name: newNames[k]! });
    this.closeAllAt(d, code, curEnd, e.hireDate || '', stamp);
    if (v.card) this.checkCardFree(d, v.card, code, v.hireDate);
    Object.assign(e, { hireDate: v.hireDate, endDate: '', card: v.card, company: v.company, department: v.department, section: v.section, area: v.area });
    this.periodRows(d).push({ emp: code, value: '', falt: ymdOf(v.hireDate), fbaj: '0', tipo: 'A', fech: stamp.date, hora: stamp.time, usua: stamp.user });
    for (const k of HISTORY_KINDS) {
      const val = (v as any)[HISTORY[k].field] as string;
      if (!val) continue;
      if (k === 'card') this.resolve(d, k, { code: val });
      this.addTramo(d, k, code, val, v.hireDate, stamp);
    }
    await this.save(d);
  }
  async deletePersonal(code: string) {
    const d = await this.load();
    if (!d.employees.some((e) => e.code === code)) throw new HttpError(404, `No existe el empleado ${code}`);
    const used = [
      d.marcajes.some((m) => m.employee === code) && 'marcajes',
      d.ausencias.some((a) => a.employee === code) && 'ausencias',
      d.solicitudes.some((s) => s.employee === code) && 'solicitudes'
    ].filter(Boolean);
    if (used.length) throw new HttpError(409, `No se puede eliminar el empleado ${code} porque tiene datos en Evalos: ${used.join(', ')}. Dale de baja con la fecha de baja.`);
    d.employees = d.employees.filter((e) => e.code !== code);
    for (const k of HISTORY_KINDS) d.history![k] = this.rows(d, k).filter((r) => r.emp !== code);
    d.periods = this.periodRows(d).filter((r) => r.emp !== code);
    await this.save(d);
  }
  async personalHistory(code: string): Promise<PersonalHistory> {
    const d = await this.load();
    const today = madridNow().date;
    const out = {} as PersonalHistory;
    for (const k of HISTORY_KINDS) {
      out[k] = this.rows(d, k).filter((r) => r.emp === code)
        .sort((a, b) => b.falt.localeCompare(a.falt) || a.value.localeCompare(b.value))
        .map((r) => toEntry(r, today));
    }
    return out;
  }
  async assignHistory(kind: HistoryKind, code: string, value: HistoryValue, from: string, stamp: ChangeStamp) {
    const d = await this.load();
    if (!d.employees.some((e) => e.code === code)) throw new HttpError(404, `No existe el empleado ${code}`);
    const def = HISTORY[kind];
    const fromYmd = ymdOf(from);
    const v = 'code' in value ? value.code : this.resolve(d, kind, value);
    const open = this.rows(d, kind).filter((r) => r.emp === code && this.isOpenAt(r, fromYmd));
    if (kind === 'card') {
      this.checkCardFree(d, v, code, from);
      const mine = open.find((r) => r.value === v);
      if (mine) throw new HttpError(409, `El empleado ${code} ya tiene asignada la tarjeta ${v} desde el ${dmy(isoOf(mine.falt))}.`);
      this.resolve(d, kind, { code: v });
    } else {
      const same = open.find((r) => r.value === v);
      if (same) throw new HttpError(409, `El empleado ${code} ya está en ${def.label} ${v} desde el ${dmy(isoOf(same.falt))}.`);
      const later = open.find((r) => r.falt >= fromYmd);
      if (later) throw new HttpError(409, `El tramo vigente de ${def.label} (${later.value}) empieza el ${dmy(isoOf(later.falt))}: la nueva alta tiene que ser posterior.`);
      for (const r of open) Object.assign(r, { fbaj: ymdOf(prevDay(from)), tipo: 'B', fech: stamp.date, hora: stamp.time, usua: stamp.user });
    }
    if (this.rows(d, kind).some((r) => r.emp === code && r.value === v && r.falt === fromYmd)) throw new HttpError(409, `Ya hay un tramo de ${def.label} ${v} que empieza el ${dmy(from)} para este empleado.`);
    this.addTramo(d, kind, code, v, from, stamp);
    this.syncField(d, kind, code, stamp.date);
    await this.save(d);
  }
  async closeHistory(kind: HistoryKind, code: string, value: string, from: string, to: string, stamp: ChangeStamp) {
    if (to < from) throw new HttpError(400, 'La fecha de baja no puede ser anterior a la de alta del tramo');
    const d = await this.load();
    const r = this.rows(d, kind).find((x) => x.emp === code && x.value === value && x.falt === ymdOf(from) && this.isOpenAt(x, stamp.date));
    if (!r) throw new HttpError(404, `El empleado ${code} no tiene vigente ${HISTORY[kind].label} ${value} desde el ${dmy(from)}.`);
    Object.assign(r, { fbaj: ymdOf(to), tipo: 'B', fech: stamp.date, hora: stamp.time, usua: stamp.user });
    this.syncField(d, kind, code, stamp.date);
    await this.save(d);
  }
  async updatePersonalContact(code: string, name: string, email: string) {
    const d = await this.load();
    const e = d.employees.find((x) => x.code === code);
    if (!e) throw new HttpError(404, `No existe en Evalos el empleado ${code} vinculado a este usuario`);
    e.name = name;
    e.email = email.toUpperCase();
    await this.save(d);
  }
  async userInitials(email: string) {
    return (email.split('@')[0].toUpperCase().replace(/[^A-Z0-9]/g, '') + 'XXX').slice(0, 3);
  }
  async personalLookups(): Promise<PersonalLookups> {
    const d = await this.load();
    const c = d.catalogs || DEMO_LOOKUPS;
    return { company: c.company, section: c.section, area: c.area, consultas: DEMO_LOOKUPS.consultas, department: d.departments.map((x) => ({ code: x.code, description: x.description })), convenio: d.convenios.map((x) => ({ code: x.code, description: x.name })),
      solicitudes: this.wf(d).map((r) => ({ code: String(r.WF_CODI), description: String(r.WF_DESC || '') })) };
  }
  async personalLimits(): Promise<PersonalLimits> {
    return { code: 50, name: 100, card: 50, email: 100, company: 15, department: 15, section: 15, area: 15, consultas: 3, solicitudes: 3, convenio: 10, workflowRol: 15 };
  }

  // ---------- Perfiles Workflow ----------
  private wf(d: DemoData) { return (d.workflow ||= DEMO_WORKFLOW.map((r) => ({ ...r }))); }
  private dyn(d: DemoData) { return (d.wf2Profiles ||= []); }
  async listDynProfiles() { return this.dyn(await this.load()).map((x) => ({ ...x })); }
  async listLegacyProfiles() { return ((await this.load()).wfProfiles || []).map((x) => x.code); }
  async listWfValida() { return ((await this.load()).wfValida || []).map((x) => ({ ...x })); }
  async setWfValida(employee: string, tipo: 'V' | 'D', valores: string[]) {
    const d = await this.load();
    d.wfValida = (d.wfValida || []).filter((x) => !(x.employee === employee && x.tipo === tipo)).concat(valores.map((valor) => ({ employee, tipo, valor })));
    await this.save(d);
  }
  async workflowColumns(): Promise<WorkflowColumns> {
    const workflow: Record<string, number | null> = { WF_CODI: 3, WF_DESC: 60, WF_FILT: 500 };
    for (const c of ['WF_NIV1', 'WF_NIV2', 'WF_NIV3', 'WF_NIV4']) workflow[c] = 1000;
    return { workflow, workflowRol: 15 };
  }
  async listWorkflowRows(): Promise<WorkflowRow[]> {
    return this.wf(await this.load()).map((r) => ({ ...r })).sort((a, b) => String(a.WF_CODI).localeCompare(String(b.WF_CODI)));
  }
  async applyWorkflowPlan(plan: WorkflowPlan) {
    const d = await this.load();
    const rows = this.wf(d);
    for (const ins of plan.insert) {
      if (rows.some((r) => r.WF_CODI === ins.code)) throw new HttpError(409, `Ya existe el perfil ${ins.code} en WORKFLOW. Vuelve a intentarlo.`);
      rows.push({ ...ins.row, WF_CODI: ins.code });
      d.wf2Profiles = this.dyn(d).filter((x) => x.code !== ins.code).concat({ code: ins.code, clave: ins.key.clave });
    }
    for (const up of plan.update) {
      const r = rows.find((x) => x.WF_CODI === up.code);
      if (r) Object.assign(r, up.set);
    }
    for (const a of plan.assign) {
      const e = d.employees.find((x) => x.code === a.employee);
      if (e) e.solicitudes = a.profile;
    }
    const drop = (code: string, legacy: boolean) => {
      const reg = legacy ? d.wfProfiles || [] : this.dyn(d);
      if (!reg.some((x) => x.code === code)) return;
      const n = d.employees.filter((e) => e.solicitudes === code).length;
      if (n) throw new HttpError(409, `No se puede borrar el perfil ${code}: todavía lo tienen ${n} persona(s).`);
      d.workflow = this.wf(d).filter((r) => r.WF_CODI !== code);
      if (legacy) d.wfProfiles = reg.filter((x) => x.code !== code);
      else d.wf2Profiles = this.dyn(d).filter((x) => x.code !== code);
    };
    for (const code of plan.remove) drop(code, false);
    for (const code of plan.removeLegacy || []) drop(code, true);
    await this.save(d);
  }
  async setEmployeesRole(employees: string[], rol: string) {
    const d = await this.load();
    let n = 0;
    for (const e of d.employees) if (employees.includes(e.code)) { e.workflowRol = rol || undefined; n++; }
    await this.save(d);
    return n;
  }

  // ---------- Calendarios ----------
  private calSummary(c: DemoCalendar): Calendar { return { code: c.code, name: c.name, year: c.year, employees: c.employees, holidays: c.days.length }; }
  async listCalendars(): Promise<Calendar[]> {
    const d = await this.load();
    return d.calendars.map((c) => this.calSummary(c)).sort((a, b) => a.name.localeCompare(b.name));
  }
  async getCalendar(code: string): Promise<CalendarDetail | null> {
    const d = await this.load();
    const c = d.calendars.find((x) => x.code === code);
    if (!c) return null;
    return { ...this.calSummary(c), days: [...c.days].sort((a, b) => a.date.localeCompare(b.date)) };
  }
  async createCalendar(c: { code: string; name: string; year: number }) {
    const d = await this.load();
    if (d.calendars.some((x) => x.code === c.code)) throw new HttpError(409, `Ya existe el calendario ${c.code}`);
    d.calendars.push({ code: c.code, name: c.name, year: c.year, employees: 0, days: [] });
    await this.save(d);
  }
  async updateCalendar(code: string, patch: { name?: string }) {
    const d = await this.load();
    const c = d.calendars.find((x) => x.code === code);
    if (!c) throw new HttpError(404, `No existe el calendario ${code}`);
    if (patch.name !== undefined) c.name = patch.name;
    await this.save(d);
  }
  async deleteCalendar(code: string) {
    const d = await this.load();
    if (!d.calendars.some((x) => x.code === code)) throw new HttpError(404, `No existe el calendario ${code}`);
    d.calendars = d.calendars.filter((x) => x.code !== code);
    await this.save(d);
  }
  async addHoliday(code: string, h: Holiday) {
    const d = await this.load();
    const c = d.calendars.find((x) => x.code === code);
    if (!c) throw new HttpError(404, `No existe el calendario ${code}`);
    if (c.days.some((x) => x.date === h.date)) throw new HttpError(409, `El calendario ya tiene un festivo el ${h.date}`);
    c.days.push(h);
    await this.save(d);
  }
  async deleteHoliday(code: string, date: string) {
    const d = await this.load();
    const c = d.calendars.find((x) => x.code === code);
    if (!c) throw new HttpError(404, `No existe el calendario ${code}`);
    c.days = c.days.filter((x) => x.date !== date);
    await this.save(d);
  }

  // ---------- Convenios ----------
  async listIncidences(type?: string) {
    return DEMO_INCIDENCES.filter((x) => !type || x.type === type).map((x) => ({ ...x }));
  }
  async listVacationTypes(): Promise<VacationTypesInfo> {
    const d = await this.load();
    const items = (d.vacationTypes || DEMO_VACATION_TYPES).map((x) => ({ ...x })).sort((a, b) => a.code.localeCompare(b.code));
    return { items, codeMax: 3, nameMax: 40, numericCode: false, hasColor: true };
  }
  async createVacationType(t: { code: string; name: string; color?: string }): Promise<VacationTypeCreated> {
    const d = await this.load();
    d.vacationTypes ||= DEMO_VACATION_TYPES.map((x) => ({ ...x }));
    if (t.code.length > 3) throw new HttpError(400, 'El código admite como máximo 3 caracteres');
    if (d.vacationTypes.some((x) => x.code === t.code)) throw new HttpError(409, `Ya existe el tipo de vacaciones ${t.code}`);
    const type: VacationType = { code: t.code, name: t.name, color: t.color || null };
    d.vacationTypes.push(type);
    await this.save(d);
    return { type, row: { CODIGO: type.code, DESCRIPCION: type.name, COLOR: type.color, ...VACATION_TYPE_DEFAULTS }, filled: [] };
  }
  async conveniosLinkable() { return true; }
  async upsertVacationPeriods(rows: VacationPeriodRow[], _stamp: ChangeStamp) {
    const d = await this.load();
    const list = (d.vacPeriods ||= []);
    let created = 0, updated = 0;
    for (const r of rows) {
      const cur = list.find((x) => x.employee === r.employee && x.type === r.type && x.from === (r.prevFrom || r.from));
      const { prevFrom: _p, ...row } = r;
      if (cur) { Object.assign(cur, { from: r.from, to: r.to, unit: r.unit === 'H' ? 'H' : 'D', days: r.days, hours: r.hours, minutesPerDay: r.unit === 'H' ? r.minutesPerDay : undefined }); updated++; }
      else { list.push({ ...row, unit: r.unit === 'H' ? 'H' : 'D', assignedDays: 0, assignedHours: 0 }); created++; }
    }
    await this.save(d);
    return { created, updated };
  }
  async upsertIncidenceLimits(rows: IncidenceLimitRow[]) {
    const d = await this.load();
    const list = (d.incLimits ||= []);
    let created = 0, updated = 0;
    for (const r of rows) {
      const cur = list.find((x) => x.employee === r.employee && x.incidence === r.incidence && x.from === (r.prevFrom || r.from));
      const { prevFrom: _p, ...row } = r;
      if (cur) { Object.assign(cur, { from: r.from, to: r.to, unit: r.unit, value: r.value }); updated++; }
      else { list.push({ ...row, used: 0 }); created++; }
    }
    await this.save(d);
    return { created, updated };
  }
  async deletePeriods(table: 'vacations' | 'limits', keys: PeriodKey[]) {
    const d = await this.load();
    const match = (k: PeriodKey, emp: string, code: string, from: string) => k.employee === emp && k.code === code && k.from === from;
    let n = 0;
    if (table === 'vacations') { const before = (d.vacPeriods ||= []).length; d.vacPeriods = d.vacPeriods.filter((v) => !keys.some((k) => match(k, v.employee, v.type, v.from))); n = before - d.vacPeriods.length; }
    else { const before = (d.incLimits ||= []).length; d.incLimits = d.incLimits.filter((l) => !keys.some((k) => match(k, l.employee, l.incidence, l.from))); n = before - d.incLimits.length; }
    await this.save(d);
    return n;
  }
  async listEmployeePeriods(employees: string[], fromDate: string) {
    const d = await this.load();
    const set = new Set(employees);
    return {
      vacations: (d.vacPeriods || []).filter((v) => set.has(v.employee) && v.to >= fromDate).map((v) => ({ ...v })),
      limits: (d.incLimits || []).filter((l) => set.has(l.employee) && l.to >= fromDate).map((l) => ({ ...l }))
    };
  }
  async setEmployeesConvenio(employees: string[], convenio: string) {
    const d = await this.load();
    let n = 0;
    for (const e of d.employees) if (employees.includes(e.code)) { e.convenio = convenio || undefined; n++; }
    await this.save(d);
    return n;
  }
  async listConvenios(): Promise<Convenio[]> {
    const d = await this.load();
    const count = (code: string, onlyActive: boolean) => d.employees.filter((e) => e.convenio === code && (!onlyActive || isActive(e.endDate))).length;
    return d.convenios.map((c) => ({ ...c, employees: count(c.code, false), active: count(c.code, true), vacations: c.vacations.map((v) => ({ ...v, pluses: (v.pluses || []).map((p) => ({ ...p })) })), limits: c.limits.map((l) => ({ ...l, pluses: (l.pluses || []).map((p) => ({ ...p })) })) })).sort((a, b) => a.code.localeCompare(b.code));
  }
  async getConvenio(code: string) {
    return (await this.listConvenios()).find((x) => x.code === code) || null;
  }
  async saveConvenio(c: Convenio, isNew: boolean, _stamp: ChangeStamp) {
    const d = await this.load();
    const idx = d.convenios.findIndex((x) => x.code === c.code);
    if (isNew && idx >= 0) throw new HttpError(409, `Ya existe el convenio ${c.code}`);
    if (!isNew && idx < 0) throw new HttpError(404, `No existe el convenio ${c.code}`);
    const { employees: _e, active: _a, ...rest } = c;
    const clean: Convenio = { ...rest, vacations: c.vacations.map((v) => ({ ...v })), limits: c.limits.map((l) => ({ ...l })) };
    if (idx >= 0) d.convenios[idx] = clean; else d.convenios.push(clean);
    await this.save(d);
  }
  async deleteConvenio(code: string) {
    const d = await this.load();
    const people = d.employees.filter((e) => e.convenio === code).length;
    if (people) throw new HttpError(409, `No se puede eliminar: ${people} persona(s) tienen asignado el convenio ${code}. Quítalas antes del convenio.`);
    if (!d.convenios.some((x) => x.code === code)) throw new HttpError(404, `No existe el convenio ${code}`);
    d.convenios = d.convenios.filter((x) => x.code !== code);
    await this.save(d);
  }

  // ---------- Correcciones ----------
  async listMarcajes(): Promise<Marcaje[]> {
    const d = await this.load();
    return [...d.marcajes].sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName));
  }
  private recomputeMarcaje(m: Marcaje) {
    const punches = [...m.punches].sort((a, b) => a.time.localeCompare(b.time));
    m.punches = punches;
    if (punches.length === 0) { m.status = 'INCIDENCIA'; m.issue = 'Sin marcajes'; return; }
    if (punches.length % 2 !== 0) { m.status = 'INCIDENCIA'; m.issue = 'Número impar de marcajes (falta entrada o salida)'; return; }
    m.status = 'OK'; m.issue = undefined;
  }
  async updateMarcaje(id: string, punches: MarcajePunch[]) {
    const d = await this.load();
    const m = d.marcajes.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'No existe el marcaje');
    m.punches = punches;
    this.recomputeMarcaje(m);
    await this.save(d);
  }
  async resolveMarcaje(id: string) {
    const d = await this.load();
    const m = d.marcajes.find((x) => x.id === id);
    if (!m) throw new HttpError(404, 'No existe el marcaje');
    m.status = 'OK'; m.issue = undefined;
    await this.save(d);
  }
  async listSolicitudes(): Promise<Solicitud[]> {
    const d = await this.load();
    const rank = (s: Solicitud) => (s.status === 'PENDIENTE' ? 0 : 1);
    return [...d.solicitudes].sort((a, b) => rank(a) - rank(b) || b.from.localeCompare(a.from));
  }
  async decideSolicitud(id: string, approve: boolean) {
    const d = await this.load();
    const s = d.solicitudes.find((x) => x.id === id);
    if (!s) throw new HttpError(404, 'No existe la solicitud');
    s.status = approve ? 'APROBADA' : 'RECHAZADA';
    // Al aprobar una ausencia/vacaciones, se refleja en Ausencias.
    if (approve && /vacacion|permiso|asunto|enferm/i.test(s.type)) {
      d.ausencias.unshift({ id: newId(), employee: s.employee, employeeName: s.employeeName, type: s.type, from: s.from, to: s.to, days: s.days, reason: s.reason });
    }
    await this.save(d);
  }
  async listAusencias(): Promise<Ausencia[]> {
    const d = await this.load();
    return [...d.ausencias].sort((a, b) => b.from.localeCompare(a.from));
  }
  async createAusencia(a: Omit<Ausencia, 'id' | 'employeeName' | 'days'>) {
    const d = await this.load();
    const emp = d.employees.find((e) => e.code === a.employee);
    if (!emp) throw new HttpError(404, 'No existe el empleado');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.from) || !/^\d{4}-\d{2}-\d{2}$/.test(a.to)) throw new HttpError(400, 'Fechas no válidas');
    if (a.to < a.from) throw new HttpError(400, 'La fecha de fin no puede ser anterior a la de inicio');
    d.ausencias.unshift({ id: newId(), employee: a.employee, employeeName: emp.name, type: a.type, from: a.from, to: a.to, days: daysBetween(a.from, a.to), reason: a.reason });
    await this.save(d);
  }
  async deleteAusencia(id: string) {
    const d = await this.load();
    if (!d.ausencias.some((x) => x.id === id)) throw new HttpError(404, 'No existe la ausencia');
    d.ausencias = d.ausencias.filter((x) => x.id !== id);
    await this.save(d);
  }
}

export async function resetDemo(companyId: string) {
  await rawSet(`evalos-demo/${companyId}`, seed());
}
