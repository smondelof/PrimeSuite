// Correcciones › Marcajes con conexión real: datos de EvalosRest (API REST de Evalos 8).
//  - Anomalías: listado PS_ANOMA calculado con GET /Report/filter.
//  - Marcajes de presencia: GET /Booking/attendance[/{empleado}].
//  - Grabar: POST /Booking/attendance. Los marcajes de terminal solo cambian la incidencia; los manuales (Debug "MAN")
//    también la hora (se borran y se crean de nuevo).
//  - Borrar: DELETE /Booking/attendance?id&date&time (solo admin del módulo, con comprobación posterior).
//  - Ausencia del día: PUT /Absence (desde = hasta = el día) y DELETE /Absence/{empleado}?dateAdd=aaaammdd.
//  - Vacaciones del día: servicios SOAP AsignarDiaVacaciones / BorrarVacaciones (server/evalossoap.ts).
//  - Turno / ausencia / vacaciones del día: GET /Calendar.
// Las respuestas de Evalos se interpretan de forma tolerante (los nombres de campo varían según versión).
import { HttpError } from '../http.ts';
import { evalosRestGet, evalosRestPost, evalosRestPut, evalosRestDelete, evalosRestTryGet } from '../evalosrest.ts';
import { callEvalosSoap, soapOk } from '../evalossoap.ts';

export const ANOMALY_REPORT = 'PS_ANOMA';
export const MAX_DAYS = 31;
export const MAX_NEW_PUNCHES = 20;

export interface RestPunch {
  time: string;            // HH:mm
  seconds: string;         // HH:mm:ss (orden y deduplicado)
  type: 'E' | 'S';
  incidence: string;       // código de incidencia ('00' = normal)
  incidenceName?: string;
  terminal?: string;
  manual: boolean;         // insertado a mano (Debug MAN / sin terminal)
  anomaly?: string;
  /** Datos originales del marcaje en Evalos (para volver a enviarlo al modificarlo). */
  ref?: BookingRef;
}
export interface BookingRef { id?: string; installation?: string; clock?: string; lector?: string; card?: string; ip?: string; debug?: string }
export interface RestMarcaje {
  id: string;              // <empleado>|<AAAA-MM-DD>
  employee: string;
  employeeName: string;
  date: string;            // AAAA-MM-DD
  punches: RestPunch[];
  status: 'OK' | 'INCIDENCIA';
  issues: string[];        // anomalías del día (PS_ANOMA y marcajes con anomalía)
  /** Calendario del día (servicio Calendar): turno, ausencia y vacaciones. */
  schedule?: string;
  absence?: string;
  holiday?: string;
  /** Lo que se muestra del día (una sola cosa): ausencia, si no vacaciones, si no turno; con descripción y color de la BD. */
  day?: DayInfo;
}
export interface Anomaly { employee: string; employeeName?: string; date: string; items: string[] }

// ---------- Fechas y horas ----------
export const pad = (n: number | string, l = 2) => String(n).padStart(l, '0');
/** AAAA-MM-DD → dd/mm/aaaa (formato de las consultas de EvalosRest). */
export const toEvalosQueryDate = (iso: string) => iso.split('-').reverse().join('/');
/** AAAA-MM-DD → aaaammdd (formato del cuerpo de los marcajes). */
export const toEvalosBodyDate = (iso: string) => iso.replace(/-/g, '');

/** Normaliza una fecha de Evalos (aaaammdd, dd/mm/aaaa, ISO, /Date(ms)/) a AAAA-MM-DD; '' si no se reconoce. */
export function normDate(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(\d{4})-(\d{2})-(\d{2})/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/))) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  // aaaammdd (con año/mes/día plausibles: un código de empleado de 8 cifras no es una fecha)
  if ((m = s.match(/^(19\d{2}|20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])$/))) return `${m[1]}-${m[2]}-${m[3]}`;
  if ((m = s.match(/\/Date\((-?\d+)/))) { const d = new Date(Number(m[1])); return isNaN(+d) ? '' : d.toISOString().slice(0, 10); }
  return '';
}
/** Normaliza una hora (HHmmss, HHmm, HH:mm[:ss], ISO con T) a HH:mm:ss; '' si no se reconoce. */
export function normTime(v: unknown): string {
  if (v == null) return '';
  const s = String(v).trim();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/T(\d{2}):(\d{2})(?::(\d{2}))?/))) return `${m[1]}:${m[2]}:${m[3] || '00'}`;
  if ((m = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?/))) return `${pad(m[1])}:${m[2]}:${m[3] || '00'}`;
  if ((m = s.match(/^(\d{2})(\d{2})(\d{2})?$/))) return `${m[1]}:${m[2]}:${m[3] || '00'}`;
  return '';
}

// ---------- Lectura tolerante de objetos de Evalos ----------
const txt = (v: unknown) => (v == null ? '' : typeof v === 'object' ? '' : String(v).trim());
/** Primer valor no vacío entre las claves indicadas (sin distinguir mayúsculas). */
function pick(o: Record<string, unknown>, ...keys: string[]): string {
  const lower = new Map(Object.keys(o).map((k) => [k.toLowerCase(), k]));
  for (const k of keys) {
    const real = lower.get(k.toLowerCase());
    if (real !== undefined) { const v = txt(o[real]); if (v) return v; }
  }
  return '';
}
const truthy = (v: unknown) => v === true || /^(true|s|si|sí|1|y|yes)$/i.test(String(v ?? '').trim());

const HEADER_KEYS = ['Header', 'header', 'Caption', 'caption', 'Cabecera', 'cabecera', 'Title', 'title', 'Text', 'text', 'ColumnName', 'columnName', 'Name', 'name', 'Id', 'id', 'Key', 'key'];
const colName = (c: any, i: number) => {
  if (c && typeof c === 'object') { for (const k of HEADER_KEYS) { const v = txt(c[k]); if (v) return v; } return `C${i + 1}`; }
  return txt(c) || `C${i + 1}`;
};
const cellValue = (v: any) => (v && typeof v === 'object' && !Array.isArray(v) ? v.Value ?? v.value ?? v.Text ?? v.text ?? v.Valor ?? v.valor : v);
const isPlainRow = (x: unknown) => !!x && typeof x === 'object' && !Array.isArray(x);

/** Convierte cualquier forma de lista de Evalos (array, {Rows/Columns}, DataSet {Table}, {Data}…) en filas objeto. */
export function rowsOf(data: unknown, depth = 0): Record<string, unknown>[] {
  if (depth > 4) return [];
  if (typeof data === 'string') { try { return rowsOf(JSON.parse(data), depth + 1); } catch { return []; } }
  if (Array.isArray(data)) {
    if (!data.length) return [];
    // Matriz: la primera fila son las cabeceras.
    if (data.every((x) => Array.isArray(x))) {
      const [head, ...rest] = data as unknown[][];
      const cols = head.map((c, i) => colName(c, i));
      return rest.map((r) => Object.fromEntries(r.map((v, i) => [cols[i] || `C${i + 1}`, cellValue(v)])));
    }
    if (data.every(isPlainRow)) {
      // Lista de filas con celdas ({Cells:[…]} / {Values:[…]}) o filas planas.
      return (data as Record<string, any>[]).map((r) => {
        const cells = r.Cells ?? r.cells ?? r.Values ?? r.values ?? r.Columns ?? r.columns;
        if (Array.isArray(cells)) return Object.fromEntries(cells.map((c: any, i: number) => [colName(c?.Column ?? c?.column ?? c, i), cellValue(c)]));
        return r;
      });
    }
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const o = data as Record<string, any>;
  const key = (re: RegExp) => Object.keys(o).find((k) => re.test(k));
  // Formato de Report/filter (EvalosRest): { header: [{Number, Value}], body: [{RowNumber, columns: [{Number, Value}]}] }.
  const hKey = key(/^header$/i), bKey = key(/^body$/i);
  if (hKey && bKey && Array.isArray(o[hKey]) && Array.isArray(o[bKey])) {
    const titles = new Map<string, string>();
    (o[hKey] as any[]).forEach((h, i) => titles.set(txt(h?.Number ?? h?.number ?? i + 1), txt(h?.Value ?? h?.value ?? h?.Text ?? h?.text) || `C${i + 1}`));
    return (o[bKey] as any[]).map((r) => {
      const cells = r?.columns ?? r?.Columns ?? r?.cells ?? r?.Cells ?? [];
      if (!Array.isArray(cells)) return {};
      return Object.fromEntries(cells.map((c: any, i: number) => {
        const n = txt(c?.Number ?? c?.number ?? i + 1);
        return [titles.get(n) || `C${n}`, typeof c === 'object' && c ? c.Value ?? c.value ?? c.Text ?? c.text : c];
      }));
    });
  }
  const rowsKey = key(/^(rows|filas|lines|lineas|líneas|data|datos|items|values|valores)$/i), colsKey = key(/^(columns|cols|columnas|headers|header|cabeceras|fields|campos)$/i);
  if (rowsKey && colsKey && Array.isArray(o[rowsKey]) && Array.isArray(o[colsKey])) {
    const cols: string[] = o[colsKey].map((c: any, i: number) => colName(c, i));
    return (o[rowsKey] as any[]).map((r) => {
      if (Array.isArray(r)) return Object.fromEntries(r.map((v, i) => [cols[i] || `C${i + 1}`, cellValue(v)]));
      const cells = r && typeof r === 'object' ? r.Values ?? r.values ?? r.Cells ?? r.cells ?? r.Valores : null;
      if (Array.isArray(cells)) return Object.fromEntries(cells.map((v: any, i: number) => [cols[i] || `C${i + 1}`, cellValue(v)]));
      if (r && typeof r === 'object') {
        // Fila con claves CAnnn / nombres de columna: se renombran a la cabecera cuando se conoce.
        const byName = new Map<string, string>(o[colsKey].map((c: any, i: number) => [txt(c?.Name ?? c?.name ?? c?.Id ?? c?.id ?? ''), cols[i]] as [string, string]));
        return Object.fromEntries(Object.entries(r).map(([k, v]) => [byName.get(k) || k, cellValue(v)]));
      }
      return {};
    });
  }
  if (rowsKey) { const r = rowsOf(o[rowsKey], depth + 1); if (r.length) return r; }
  for (const k of ['Table', 'Table1', 'Result', 'result', 'Report', 'report', 'Listado', 'listado']) {
    if (k in o) { const r = rowsOf(o[k], depth + 1); if (r.length) return r; }
  }
  // Cualquier propiedad que contenga una lista de filas.
  for (const v of Object.values(o)) {
    if (v && typeof v === 'object') { const r = rowsOf(v, depth + 1); if (r.length) return r; }
  }
  // Un único objeto con forma de fila.
  return Object.values(o).some((v) => v == null || typeof v !== 'object') ? [o] : [];
}

// ---------- Anomalías (PS_ANOMA) ----------
const EMP_KEYS = ['EM_CODI', 'CodeEmployee', 'EmployeeCode', 'Codigo', 'Código', 'CODIGO', 'Code', 'Empleado', 'Employee'];
const NAME_KEYS = ['EM_NOMB', 'Nombre', 'Name', 'EmployeeName', 'Description', 'ApellidosNombre'];
const DATE_KEYS = ['FECHA', 'Fecha', 'Date', 'Dia', 'Día', 'Day', 'DateFormatted'];


/** Valor de una columna de anomalía: true si está marcada (1, horas distintas de cero, sí…); '-', 0, 0:00 o vacío = no. */
export function anomalyOn(v: unknown): boolean {
  if (v == null || typeof v === 'object') return false;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim();
  if (!s || /^[-–—]+$/.test(s) || /^(false|no|n)$/i.test(s)) return false;
  if (/^[-+]?[0.,:\s]*$/.test(s)) return false; // 0, 0,00, 00:00, 0:00:00
  return true;
}

/**
 * Anomalías por empleado y día a partir de las filas del listado PS_ANOMA.
 * El listado devuelve una fila por empleado y día con una columna por anomalía (RETRASO, SALIDA ANTES, M. IMPARES…):
 * la anomalía es el título de la columna y se muestra cuando la columna está marcada (1 o un valor distinto de cero).
 */
export function parseAnomalies(data: unknown): Anomaly[] {
  const out: Anomaly[] = [];
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const EMP = lower(EMP_KEYS), NAME = lower(NAME_KEYS), DATE = lower(DATE_KEYS);
  for (const row of rowsOf(data)) {
    const keys = Object.keys(row);
    // Código: columna conocida o, si no, la primera; nombre: conocida o la segunda.
    const empKey = keys.find((k) => EMP.has(k.toLowerCase())) ?? keys[0];
    const nameKey = keys.find((k) => NAME.has(k.toLowerCase())) ?? (keys[1] !== empKey ? keys[1] : undefined);
    let dateKey = keys.find((k) => DATE.has(k.toLowerCase()) && normDate(row[k]));
    if (!dateKey) dateKey = keys.find((k) => k !== empKey && normDate(row[k]));
    const employee = empKey ? txt(row[empKey]) : '';
    const date = dateKey ? normDate(row[dateKey]) : '';
    if (!employee || !date) continue;
    const items: string[] = [];
    for (const k of keys) {
      if (k === empKey || k === nameKey || k === dateKey || /^(id|rowid|row|rownumber|index|fila|orden|tipo|type|n[ºo°]?)$/i.test(k.trim())) continue;
      if (anomalyOn(row[k])) items.push(k.trim());
    }
    if (items.length) out.push({ employee, employeeName: (nameKey && txt(row[nameKey])) || undefined, date, items });
  }
  return out;
}

// ---------- Marcajes (Booking/attendance) ----------
export interface ParsedBooking { employee: string; date: string; seconds: string; inOut: '' | 'E' | 'S'; incidence: string; incidenceName?: string; terminal?: string; manual: boolean; anomaly?: string; ref: BookingRef }

export function parseBookings(data: unknown): ParsedBooking[] {
  const out: ParsedBooking[] = [];
  for (const b of rowsOf(data)) {
    const employee = pick(b, 'CodeEmployee', 'EmployeeCode', 'EM_CODI', 'Code');
    const dt = pick(b, 'DateTime', 'RealTime');
    const date = normDate(pick(b, 'Date', 'DateFormatted')) || normDate(dt);
    const seconds = normTime(pick(b, 'Time', 'TimeFormatted')) || normTime(dt);
    if (!employee || !date || !seconds) continue;
    const io = pick(b, 'InOut', 'Type').toUpperCase();
    const debug = pick(b, 'Debug');
    const terminal = [pick(b, 'Installation'), pick(b, 'Clock'), pick(b, 'Lector')].filter(Boolean).join('-');
    const anomalyText = pick(b, 'DescriptionAnomaly', 'Anomaly', 'MsgError');
    out.push({
      employee, date, seconds,
      inOut: io === 'E' || io === 'I' || io === 'ENTRADA' ? 'E' : io === 'S' || io === 'O' || io === 'SALIDA' ? 'S' : '',
      incidence: pick(b, 'Incidence') || '00',
      incidenceName: pick(b, 'DescriptionIncidence') || undefined,
      terminal: pick(b, 'DescriptionTerminal') || terminal || undefined,
      manual: /^MAN/i.test(debug) || !terminal,
      anomaly: anomalyText && anomalyText !== '0' ? anomalyText : truthy(b.HasAnomalies) ? 'Marcaje con anomalía' : undefined,
      ref: Object.fromEntries(Object.entries({
        id: pick(b, 'Id'), installation: pick(b, 'Installation'), clock: pick(b, 'Clock'), lector: pick(b, 'Lector'),
        card: pick(b, 'Card'), ip: pick(b, 'Ip'), debug: debug
      }).filter(([, v]) => v)) as BookingRef
    });
  }
  return out;
}

/** Agrupa marcajes y anomalías por empleado y día, como la vista de Marcajes. Orden: fecha desc., empleado. */
/** Días AAAA-MM-DD de un periodo (incluidos los extremos). */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`); t <= end; t += 86400000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/**
 * Agrupa marcajes y anomalías por empleado y día, como la vista de Marcajes. Orden: fecha desc., empleado.
 * Con `fill`, aparecen todos los días del periodo para esos empleados, aunque no tengan marcajes ni anomalías.
 */
export function buildMarcajes(bookings: ParsedBooking[], anomalies: Anomaly[], names: Map<string, string>, fill?: { from: string; to: string; employees: string[] }): RestMarcaje[] {
  const days = new Map<string, RestMarcaje>();
  const day = (employee: string, date: string, name?: string) => {
    const id = `${employee}|${date}`;
    let d = days.get(id);
    if (!d) { d = { id, employee, employeeName: names.get(employee) || name || employee, date, punches: [], status: 'OK', issues: [] }; days.set(id, d); }
    else if (d.employeeName === employee && name) d.employeeName = name;
    return d;
  };
  const seen = new Set<string>();
  for (const b of bookings) {
    const key = `${b.employee}|${b.date}|${b.seconds}|${b.incidence}`;
    if (seen.has(key)) continue;
    seen.add(key);
    day(b.employee, b.date).punches.push({
      time: b.seconds.slice(0, 5), seconds: b.seconds, type: b.inOut || 'E', incidence: b.incidence, incidenceName: b.incidenceName,
      terminal: b.terminal, manual: b.manual, anomaly: b.anomaly, ref: b.ref, ...(b.inOut ? {} : { _auto: true })
    } as RestPunch);
  }
  for (const a of anomalies) {
    const d = day(a.employee, a.date, a.employeeName);
    for (const it of a.items) if (!d.issues.includes(it)) d.issues.push(it);
  }
  for (const d of days.values()) {
    d.punches.sort((x, y) => x.seconds.localeCompare(y.seconds));
    // Sin sentido E/S de Evalos: se alternan entrada/salida por orden.
    d.punches.forEach((p: any, i) => { if (p._auto) { p.type = i % 2 === 0 ? 'E' : 'S'; delete p._auto; } });
    for (const p of d.punches) if (p.anomaly && !d.issues.includes(p.anomaly)) d.issues.push(p.anomaly);
    if (d.issues.length) d.status = 'INCIDENCIA';
  }
  if (fill) {
    const dates = daysBetween(fill.from, fill.to);
    for (const e of fill.employees) for (const d of dates) day(e, d);
  }
  return [...days.values()].sort((a, b) => b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName, 'es') || a.employee.localeCompare(b.employee));
}

// ---------- Llamadas a EvalosRest ----------
const CODE_RE = /^[A-Za-z0-9_.\-]{1,20}$/;
export function cleanEmployeeCode(v: unknown, required = false): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) { if (required) throw new HttpError(400, 'Falta el empleado'); return ''; }
  if (!CODE_RE.test(s)) throw new HttpError(400, 'Código de empleado no válido');
  return s;
}
export function cleanRange(from: unknown, to: unknown): { from: string; to: string } {
  const ok = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`));
  if (!ok(from) || !ok(to)) throw new HttpError(400, 'Periodo no válido (AAAA-MM-DD)');
  const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
  if (b < a) throw new HttpError(400, 'La fecha «hasta» es anterior a «desde»');
  if ((b - a) / 86400000 + 1 > MAX_DAYS) throw new HttpError(400, `El periodo no puede superar ${MAX_DAYS} días`);
  return { from: from as string, to: to as string };
}

/** Resumen de la respuesta del listado para comprobar cómo la interpreta Prime Suite. */
export interface ReportPreview { rows: number; anomalies: number; columns: string[]; sample: string }
/** Resumen de la respuesta de Calendar, para comprobar qué campos devuelve Evalos. */
export interface CalendarPreview { rows: number; days: number; columns: string[]; sample: string; dateFormat: string }
export interface MarcajesResult { marcajes: RestMarcaje[]; warnings: string[]; ms: number; report: string; reportPreview: ReportPreview | null; calendarPreview: CalendarPreview | null; hiddenUnknown: number }

/** Marcajes y anomalías del periodo (todos los empleados o uno). Si PS_ANOMA falla, se devuelven los marcajes con un aviso. */
/**
 * Empleados que existen en PERSONAL: código de Evalos (tal cual o sin ceros a la izquierda) → código de PERSONAL.
 * Lo que no esté aquí no se muestra (marcajes o anomalías de personal que ya no existe).
 */
export function knownEmployees(codes: string[]): (code: string) => string | undefined {
  const exact = new Set(codes);
  const loose = new Map<string, string>();
  for (const c of codes) { const k = c.replace(/^0+(?=.)/, '').toUpperCase(); if (!loose.has(k)) loose.set(k, c); }
  return (code) => (exact.has(code) ? code : loose.get(code.replace(/^0+(?=.)/, '').toUpperCase()));
}

/** Filtro de organización (empresa, departamento, sección, área) sobre los campos de PERSONAL. */
export type OrgFilter = Partial<Record<'company' | 'department' | 'section' | 'area', string>>;
const ORG_COLUMNS = { company: 'EM_CEMP', department: 'EM_DEPA', section: 'EM_SECC', area: 'EM_AREA' } as const;
/** Condición SQL del listado: empleado concreto, o filtro de organización (los valores ya vienen validados). */
export function reportFilter(employee?: string, org?: OrgFilter): string {
  if (employee) return `EM_CODI='${employee}'`;
  const parts = Object.entries(ORG_COLUMNS).filter(([k]) => org?.[k as keyof OrgFilter]).map(([k, col]) => `${col}='${org![k as keyof OrgFilter]}'`);
  return parts.length ? parts.join(' AND ') : `EM_CODI<>''`;
}

export async function loadMarcajes(opts: { from: string; to: string; employee?: string; names: Map<string, string>; employees?: string[]; known?: string[]; only?: string[]; org?: OrgFilter; labels?: DayLabels | null; portalOrigin: string }): Promise<MarcajesResult> {
  const started = Date.now();
  const q = `dateAdd=${encodeURIComponent(toEvalosQueryDate(opts.from))}&dateEnd=${encodeURIComponent(toEvalosQueryDate(opts.to))}`;
  const bookingPath = `/Booking/attendance${opts.employee ? `/${encodeURIComponent(opts.employee)}` : ''}?${q}`;
  // `filter` es obligatorio en Report/filter (sin él EvalosRest responde 404): sin empleado, un filtro que incluye a todos.
  const filter = reportFilter(opts.employee, opts.org);
  const reportPath = `/Report/filter?id=${ANOMALY_REPORT}&${q}&filter=${encodeURIComponent(filter)}`;
  const warnings: string[] = [];
  const [bk, rp, cal] = await Promise.all([
    evalosRestGet(bookingPath, opts.portalOrigin),
    evalosRestGet(reportPath, opts.portalOrigin).catch((e: any) => { warnings.push(`No se pudo calcular el listado ${ANOMALY_REPORT}: ${e?.message || e}`); return null; }),
    loadCalendar(opts).catch((e: any) => { warnings.push(`No se pudo leer el calendario (turno, ausencia, vacaciones): ${e?.message || e}`); return null; })
  ]);
  const reportRows = rp ? rowsOf(rp.data) : [];
  let sample = '';
  if (rp) {
    const d: any = rp.data;
    const reportError = d && typeof d === 'object' && !Array.isArray(d) ? txt(d.ReportError ?? d.reportError) : '';
    if (reportError) warnings.push(`El listado ${ANOMALY_REPORT} devolvió un error: ${reportError}`);
    // Muestra: las primeras filas ya interpretadas (columna → valor), más fácil de leer que el JSON completo.
    try { sample = JSON.stringify(reportRows.length ? reportRows.slice(0, 8) : d, null, 2) ?? ''; } catch { sample = String(d); }
  }
  const reportPreview: ReportPreview | null = rp ? {
    rows: reportRows.length,
    anomalies: 0,
    columns: Array.from(new Set(reportRows.slice(0, 20).flatMap((r) => Object.keys(r)))),
    sample: sample.length > 6000 ? `${sample.slice(0, 6000)}\n…` : sample
  } : null;
  // Solo personal que existe en PERSONAL (si se ha podido leer); los códigos se llevan al de PERSONAL.
  const canon = opts.known?.length ? knownEmployees(opts.known) : (c: string) => c;
  let dropped = 0;
  const keep = <T extends { employee: string }>(x: T): T | null => { const e = canon(x.employee); if (!e) { dropped++; return null; } return { ...x, employee: e }; };
  // Con filtro de organización, solo los empleados que lo cumplen (no cuentan como «personal que no existe»).
  const only = opts.only ? new Set(opts.only) : null;
  const inRange = (x: { employee: string; date: string }) => x.date >= opts.from && x.date <= opts.to && (!opts.employee || x.employee === opts.employee) && (!only || only.has(x.employee));
  const anomalies = (rp ? parseAnomalies(rp.data) : []).map(keep).filter((a): a is Anomaly => !!a && inRange(a));
  const bookings = parseBookings(bk.data).map(keep).filter((b): b is ParsedBooking => !!b && inRange(b));
  if (reportPreview) reportPreview.anomalies = anomalies.length;
  // Todos los días del periodo: del empleado elegido o de todos los activos (y de cualquiera con marcajes o anomalías).
  const fillEmployees = opts.employee ? [opts.employee] : opts.employees || [];
  const marcajes = buildMarcajes(bookings, anomalies, opts.names, { from: opts.from, to: opts.to, employees: fillEmployees });
  // Turno, ausencia y vacaciones: del calendario y, si no viene, de los propios marcajes del día.
  const calDays = new Map((cal?.days || []).map((d) => [`${canon(d.employee) || d.employee}|${d.date}`, d]));
  const fromBookings = new Map<string, CalendarDay>();
  for (const b of bookingDayInfo(bk.data)) { const k = `${canon(b.employee) || b.employee}|${b.date}`; if (!fromBookings.has(k)) fromBookings.set(k, b); }
  for (const m of marcajes) {
    const c = calDays.get(m.id), b = fromBookings.get(m.id);
    m.schedule = c?.schedule || b?.schedule || undefined;
    m.absence = c?.absence || b?.absence || undefined;
    m.holiday = c?.holiday || b?.holiday || undefined;
    m.day = dayInfo(m, opts.labels);
  }
  return { marcajes, warnings, ms: Date.now() - started, report: ANOMALY_REPORT, reportPreview, calendarPreview: cal?.preview ?? null, hiddenUnknown: dropped };
}

/**
 * Marcaje a grabar con POST /Booking/attendance.
 *  - Nuevo: hora HH:mm, incidencia → marcaje manual (Debug MAN).
 *  - Modificación de uno existente: `original` = hora exacta (HH:mm:ss) que tiene en Evalos y `ref` = sus datos de terminal;
 *    se reenvía con la nueva incidencia (y la nueva hora solo si es manual: en los de terminal la hora no se cambia).
 */
export interface PunchWrite { time: string; incidence: string; original?: string; ref?: BookingRef }

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;
const REF_RE = /^[A-Za-z0-9 _.:\-]{0,40}$/;
export function cleanPunchWrites(v: unknown): PunchWrite[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'No hay cambios que guardar');
  if (v.length > MAX_NEW_PUNCHES) throw new HttpError(400, `Como máximo ${MAX_NEW_PUNCHES} marcajes a la vez`);
  return v.map((x: any) => {
    const time = String(x?.time ?? '');
    if (!TIME_RE.test(time)) throw new HttpError(400, `Hora no válida: ${time || '(vacía)'}`);
    const incidence = String(x?.incidence ?? '').trim() || NORMAL_INCIDENCE.code;
    if (!/^[A-Za-z0-9]{1,5}$/.test(incidence)) throw new HttpError(400, `Incidencia no válida: ${incidence}`);
    const out: PunchWrite = { time, incidence };
    if (x?.original != null && x.original !== '') {
      const original = String(x.original);
      if (!TIME_RE.test(original)) throw new HttpError(400, `Hora original no válida: ${original}`);
      out.original = original;
      const ref: BookingRef = {};
      for (const k of ['id', 'installation', 'clock', 'lector', 'card', 'ip', 'debug'] as const) {
        const val = x?.ref?.[k];
        if (val == null || val === '') continue;
        if (!REF_RE.test(String(val))) throw new HttpError(400, `Dato de marcaje no válido (${k})`);
        ref[k] = String(val);
      }
      out.ref = ref;
    }
    return out;
  });
}

const hhmmss = (t: string) => (t.length === 5 ? `${t}:00` : t).replace(/:/g, '');

/** Cuerpo de POST /Booking/attendance para cada marcaje (nuevo o modificado). */
export function bookingPayload(employee: string, date: string, punches: PunchWrite[]) {
  return punches.map((p) => {
    const body: Record<string, string> = { CodeEmployee: employee, Date: toEvalosBodyDate(date), Time: hhmmss(p.time), Incidence: p.incidence };
    if (!p.original) { body.Debug = 'MAN'; return body; }
    const r = p.ref || {};
    const fromTerminal = !!(r.installation || r.clock || r.lector) && !/^MAN/i.test(r.debug || '');
    // En los marcajes de terminal la hora no se modifica: se reenvía la original con su terminal.
    if (fromTerminal) body.Time = hhmmss(p.original);
    if (r.id) body.Id = r.id;
    if (r.installation) body.Installation = r.installation;
    if (r.clock) body.Clock = r.clock;
    if (r.lector) body.Lector = r.lector;
    if (r.card) body.Card = r.card;
    if (r.ip) body.Ip = r.ip;
    body.Debug = r.debug || (fromTerminal ? '' : 'MAN');
    if (!body.Debug) delete body.Debug;
    return body;
  });
}

/** Graba marcajes nuevos o modificados (POST /Booking/attendance). Lanza 502 si Evalos rechaza alguno. */
export async function savePunches(employee: string, date: string, punches: PunchWrite[], portalOrigin: string) {
  const payload = bookingPayload(employee, date, punches);
  const r = await evalosRestPost<unknown>('/Booking/attendance', payload, portalOrigin);
  const results = Array.isArray(r.data) ? r.data : [];
  const bad = results
    .map((x: any, i: number) => ({ i, msg: x && typeof x === 'object' ? txt(x.message ?? x.Message ?? x.Result ?? '') : txt(x) }))
    .filter((x) => x.msg && !/^ok$/i.test(x.msg));
  if (bad.length) {
    throw new HttpError(502, `Evalos no ha grabado ${bad.length === punches.length ? 'los marcajes' : `${bad.length} de ${punches.length} marcajes`}: ${bad.map((b) => `${punches[b.i]?.time ?? '?'} → ${b.msg}`).join('; ').slice(0, 300)}`);
  }
  return { saved: punches.length, ms: r.ms };
}

/** Incidencia de los marcajes normales: no está en la tabla INCIDENC y se ofrece siempre la primera. */
export const NORMAL_INCIDENCE = { code: '000', name: 'Entrada / Salida' };

// ---------- Borrar marcajes (DELETE /Booking/attendance) ----------
/**
 * La API documenta el borrado del marcaje del empleado {id}, fecha {date} y hora {time}, pero no el formato:
 * se envían como parámetros de la URL probando los formatos de fecha/hora de Evalos hasta que uno funciona.
 */
export function deleteVariants(employee: string, date: string, seconds: string): string[] {
  const id = encodeURIComponent(employee);
  const ymd = toEvalosBodyDate(date), dmy = encodeURIComponent(toEvalosQueryDate(date));
  const hms = seconds.replace(/:/g, ''), hmsc = encodeURIComponent(seconds);
  return [
    `/Booking/attendance?id=${id}&date=${ymd}&time=${hms}`,
    `/Booking/attendance?id=${id}&date=${dmy}&time=${hms}`,
    `/Booking/attendance?id=${id}&date=${dmy}&time=${hmsc}`
  ];
}

export function cleanDeleteTimes(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length) throw new HttpError(400, 'No hay marcajes que eliminar');
  if (v.length > MAX_NEW_PUNCHES) throw new HttpError(400, `Como máximo ${MAX_NEW_PUNCHES} marcajes a la vez`);
  return v.map((x) => {
    const t = String(x ?? '');
    if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(t)) throw new HttpError(400, `Hora no válida: ${t || '(vacía)'}`);
    return t;
  });
}

/** Borra marcajes del día y comprueba, volviendo a leer el día, que ya no están. */
export async function deletePunches(employee: string, date: string, times: string[], portalOrigin: string) {
  const failures: string[] = [];
  for (const t of times) {
    let last = '';
    let done = false;
    for (const path of deleteVariants(employee, date, t)) {
      const r = await evalosRestDelete(path, portalOrigin);
      if (r.ok) { done = true; break; }
      last = `${r.status}${r.message ? ` · ${r.message}` : ''}`;
      // Solo se prueba otro formato si Evalos no lo encuentra o no entiende los datos.
      if (![400, 403, 404].includes(r.status)) break;
    }
    if (!done) failures.push(`${t.slice(0, 5)} → ${last || 'sin respuesta'}`);
  }
  // Comprobación: el día ya no debe tener esos marcajes.
  const q = `dateAdd=${encodeURIComponent(toEvalosQueryDate(date))}&dateEnd=${encodeURIComponent(toEvalosQueryDate(date))}`;
  const after = parseBookings((await evalosRestGet(`/Booking/attendance/${encodeURIComponent(employee)}?${q}`, portalOrigin)).data)
    .filter((b) => b.employee === employee && b.date === date);
  const still = times.filter((t) => after.some((b) => b.seconds === t));
  if (still.length) {
    const why = failures.length ? ` (${failures.join('; ')})` : '';
    throw new HttpError(502, `Evalos no ha eliminado ${still.length === times.length ? 'los marcajes' : `${still.length} de ${times.length} marcajes`}: ${still.map((x) => x.slice(0, 5)).join(', ')}${why}.`);
  }
  return { deleted: times.length };
}

// ---------- Ausencias (PUT /Absence) ----------
/** Ausencia de un día: absentismo de fichero con fecha desde y hasta = el día seleccionado. */
export function absencePayload(employee: string, date: string, incidence: string, description: string) {
  const d = toEvalosBodyDate(date);
  return {
    CodeEmployee: employee, StartDate: d, EndDate: d, Description: description.slice(0, 40), Incidence: incidence,
    Holidays: 'N', NonWorkingDays: 'N', MaxDays: '1', NewIncidence: '', Observations: ''
  };
}

export async function saveAbsence(employee: string, date: string, incidence: string, description: string, portalOrigin: string) {
  if (!/^[A-Za-z0-9]{1,5}$/.test(incidence)) throw new HttpError(400, 'Elige la incidencia de la ausencia');
  const r = await evalosRestPut<unknown>('/Absence', absencePayload(employee, date, incidence, description), portalOrigin);
  return { ms: r.ms };
}

// ---------- Calendario (GET /Calendar[/{empleado}]) ----------
export interface DayInfo { kind: 'absence' | 'holiday' | 'shift'; code: string; name: string; color: string | null }
export type DayLabels = Record<'shifts' | 'holidays' | 'absences', { code: string; name: string; color: string | null }[]>;

/** Qué se muestra del día: 1) ausencia, 2) vacaciones, 3) turno, con su descripción y color. */
export function dayInfo(m: { schedule?: string; absence?: string; holiday?: string }, labels?: DayLabels | null): DayInfo | undefined {
  const find = (list: DayLabels[keyof DayLabels] | undefined, code: string) => list?.find((x) => x.code.toUpperCase() === code.toUpperCase());
  const make = (kind: DayInfo['kind'], code: string, list?: DayLabels[keyof DayLabels]): DayInfo => {
    const l = find(list, code);
    return { kind, code, name: l?.name || code, color: l?.color ?? null };
  };
  if (m.absence) return make('absence', m.absence, labels?.absences);
  if (m.holiday) return make('holiday', m.holiday, labels?.holidays);
  if (m.schedule) return make('shift', m.schedule, labels?.shifts);
  return undefined;
}

export interface CalendarDay { employee: string; date: string; schedule: string; absence: string; holiday: string }

/** Código de un campo del calendario: '' si está vacío. Los códigos 000 se conservan (pueden ser turnos válidos). */
/** Código de un campo del calendario: '' si no tiene letras ni cifras (Evalos devuelve «...» o «-» cuando no hay). */
const codeOf = (o: Record<string, unknown>, ...keys: string[]) => { const v = pick(o, ...keys).trim(); return /[A-Za-z0-9]/.test(v) ? v : ''; };
/** Ausencia o vacaciones: 0, 000, «...», '-' o vacío = no hay. */
const optCode = (v: string) => (/^[0\s.\-]*$/.test(v) ? '' : v);

/** Turno, ausencia y vacaciones por empleado y día, de cualquier forma de respuesta de Calendar. */
export function parseCalendar(data: unknown): CalendarDay[] {
  const out: CalendarDay[] = [];
  for (const r of rowsOf(data)) {
    const employee = pick(r, 'CodeEmployee', 'EmployeeCode', 'Employee', 'EM_CODI', 'Code');
    const date = normDate(pick(r, 'Day', 'Date', 'DateDay', 'Fecha', 'Dia', 'DateFormatted', 'StartDate'));
    if (!employee || !date) continue;
    out.push({
      employee, date,
      schedule: codeOf(r, 'ScheduleCode', 'CodeSchedule', 'Schedule', 'ShiftCode', 'Shift', 'Turno', 'TN_CODI'),
      absence: optCode(codeOf(r, 'IncidenceCode', 'AbsenceCode', 'Absence', 'CodeIncidence', 'Absentismo')),
      holiday: optCode(codeOf(r, 'HolidaysTypeCode', 'HolidaysCode', 'HolidayCode', 'HolidayTypeCode', 'VacationCode', 'VacationsCode', 'Holidays', 'Vacaciones'))
    });
  }
  return out;
}

/** Turno, ausencia y vacaciones que traen los marcajes (BookingPresence: Schedule, AbsenceCode, HolidaysTypeCode). */
export function bookingDayInfo(data: unknown): CalendarDay[] {
  const out: CalendarDay[] = [];
  for (const b of rowsOf(data)) {
    const employee = pick(b, 'CodeEmployee', 'EmployeeCode', 'EM_CODI');
    const date = normDate(pick(b, 'Date', 'DateFormatted')) || normDate(pick(b, 'DateTime'));
    if (!employee || !date) continue;
    out.push({ employee, date, schedule: codeOf(b, 'Schedule', 'ScheduleCode'), absence: optCode(codeOf(b, 'AbsenceCode')), holiday: optCode(codeOf(b, 'HolidaysTypeCode')) });
  }
  return out;
}

/**
 * Calendario del periodo. La API no documenta el formato de fecha: se prueba dd/mm/aaaa y, si no devuelve
 * ningún día, aaaammdd.
 */
async function loadCalendar(opts: { from: string; to: string; employee?: string; portalOrigin: string }) {
  const base = `/Calendar${opts.employee ? `/${encodeURIComponent(opts.employee)}` : ''}`;
  const formats: [string, (d: string) => string][] = [['dd/mm/aaaa', toEvalosQueryDate], ['aaaammdd', toEvalosBodyDate]];
  let last: { data: unknown; format: string } | null = null;
  let lastErr: unknown = null;
  for (const [name, fmt] of formats) {
    try {
      const r = await evalosRestGet(`${base}?dateAdd=${encodeURIComponent(fmt(opts.from))}&dateEnd=${encodeURIComponent(fmt(opts.to))}`, opts.portalOrigin);
      last = { data: r.data, format: name };
      if (parseCalendar(r.data).length) break;
    } catch (e) { lastErr = e; }
  }
  if (!last) throw lastErr;
  const rows = rowsOf(last.data);
  const days = parseCalendar(last.data).filter((d) => d.date >= opts.from && d.date <= opts.to && (!opts.employee || d.employee === opts.employee));
  let sample = '';
  try { sample = JSON.stringify(rows.length ? rows.slice(0, 5) : last.data, null, 2) ?? ''; } catch { sample = String(last.data); }
  const preview: CalendarPreview = {
    rows: rows.length, days: days.length, dateFormat: last.format,
    columns: Array.from(new Set(rows.slice(0, 20).flatMap((r) => Object.keys(r)))),
    sample: sample.length > 5000 ? `${sample.slice(0, 5000)}\n…` : sample
  };
  return { days, preview };
}

/** Absentismos de fichero que empiezan ese día (GET /Absence/{empleado}?dateAdd=aaaammdd). */
async function absencesStarting(employee: string, date: string, portalOrigin: string) {
  // EvalosRest responde 404 cuando no hay ninguna ausencia que empiece ese día.
  const r = await evalosRestTryGet(`/Absence/${encodeURIComponent(employee)}?dateAdd=${toEvalosBodyDate(date)}`, portalOrigin);
  if (!r.ok) {
    if (r.status === 404) return [];
    throw new HttpError(502, `EvalosRest respondió ${r.status}${r.message ? ` · ${r.message}` : ''} al leer las ausencias.`);
  }
  return rowsOf(r.data)
    .map((a) => ({ start: normDate(pick(a, 'StartDate', 'DateAdd', 'AB_FINI')), end: normDate(pick(a, 'EndDate', 'DateEnd', 'AB_FCIE')), incidence: pick(a, 'Incidence', 'IncidenceCode', 'AB_INCI') }))
    .filter((a) => a.start === date || (!a.start && a.incidence));
}

/**
 * Quita la ausencia del día: borra el absentismo de fichero que empieza ese día (DELETE /Absence/{empleado}?dateAdd=)
 * y comprueba después que ya no está. Si la ausencia abarca más días, o no es un absentismo de fichero
 * (p. ej. asignada en el calendario), no se toca y se explica.
 */
export async function deleteAbsence(employee: string, date: string, portalOrigin: string) {
  const found = await absencesStarting(employee, date, portalOrigin);
  if (!found.length) {
    throw new HttpError(409, `No hay ningún absentismo de fichero que empiece el ${toEvalosQueryDate(date)}. La ausencia puede venir de un periodo que empezó antes o estar asignada en el calendario: quítala en Evalos.`);
  }
  const long = found.find((a) => a.end && a.end !== date);
  if (long) {
    throw new HttpError(409, `La ausencia va del ${toEvalosQueryDate(long.start || date)} al ${toEvalosQueryDate(long.end)}: desde Correcciones solo se quitan ausencias de un día. Quítala en Evalos.`);
  }
  const r = await evalosRestDelete(`/Absence/${encodeURIComponent(employee)}?dateAdd=${toEvalosBodyDate(date)}`, portalOrigin);
  if (!r.ok) throw new HttpError(502, `EvalosRest respondió ${r.status}${r.message ? ` · ${r.message}` : ''} al quitar la ausencia.`);
  if ((await absencesStarting(employee, date, portalOrigin)).length) throw new HttpError(502, 'Evalos no ha quitado la ausencia.');
  return { deleted: found.length };
}

// ---------- Vacaciones (servicios SOAP de Evalos: AsignarDiaVacaciones / BorrarVacaciones) ----------
const VAC_CODE = /^[A-Za-z0-9_.\-]{1,10}$/;

/** Asigna el día como vacaciones del tipo indicado (SOAP AsignarDiaVacaciones, fecha dd/mm/aaaa). */
export async function assignHoliday(employee: string, date: string, type: string, portalOrigin: string) {
  if (!VAC_CODE.test(type)) throw new HttpError(400, 'Elige el tipo de vacaciones');
  const r = await callEvalosSoap('AsignarDiaVacaciones', { employee, vacationType: type, date: toEvalosQueryDate(date) }, portalOrigin);
  if (!soapOk(r.result)) throw new HttpError(502, `Evalos no ha asignado las vacaciones: ${r.result.slice(0, 300)}`);
  return { ms: r.ms };
}

/** Horas de vacaciones HH:MM (mayores que cero). */
export function cleanHours(v: unknown): string {
  const m = String(v ?? '').trim().match(/^(\d{1,2}):([0-5]\d)$/);
  if (!m || (+m[1] === 0 && +m[2] === 0) || +m[1] > 24 || (+m[1] === 24 && +m[2] > 0)) throw new HttpError(400, 'Indica las horas de vacaciones en formato HH:MM');
  return `${m[1].padStart(2, '0')}:${m[2]}`;
}

/** Asigna horas de vacaciones en el día (SOAP AsignarHorasVacaciones), para periodos en horas. */
export async function assignHolidayHours(employee: string, date: string, type: string, hours: string, portalOrigin: string) {
  if (!VAC_CODE.test(type)) throw new HttpError(400, 'Elige el tipo de vacaciones');
  const r = await callEvalosSoap('AsignarHorasVacaciones', { employee, vacationType: type, date: toEvalosQueryDate(date), hours }, portalOrigin);
  if (!soapOk(r.result)) throw new HttpError(502, `Evalos no ha asignado las horas de vacaciones: ${r.result.slice(0, 300)}`);
  return { ms: r.ms };
}

/** Quita las vacaciones del día (SOAP BorrarVacaciones). */
export async function removeHoliday(employee: string, date: string, portalOrigin: string) {
  const r = await callEvalosSoap('BorrarVacaciones', { employee, date: toEvalosQueryDate(date) }, portalOrigin);
  if (!soapOk(r.result)) throw new HttpError(502, `Evalos no ha quitado las vacaciones: ${r.result.slice(0, 300)}`);
  return { ms: r.ms };
}
