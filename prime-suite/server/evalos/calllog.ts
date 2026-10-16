// Log de llamadas a Evalos 8 (depuración): cada llamada a los servicios SOAP (ServiciosCliente), a EvalosRest y las
// escrituras de periodos en VACACIONES / INCIDENCIALIMITE, con lo que se envía y lo que responde Evalos.
// Se ve en Atajos de Evalos › «Log de llamadas a Evalos» (solo administradores).
// Nunca se guardan tokens, secretos ni contraseñas. Es best effort: un fallo del log no rompe la llamada.
import { rawGet, rawSet, id } from '../db.ts';
import { requestContext } from '../http.ts';

export type CallKind = 'soap' | 'rest' | 'sql';
export interface EvalosCallEvent {
  id: string;
  at: string;
  kind: CallKind;
  /** Operación SOAP, «GET /Booking/…» o «INSERT VACACIONES». */
  op: string;
  ok: boolean;
  /** Estado HTTP (SOAP / REST). */
  status?: number;
  ms?: number;
  url?: string;
  /** Parámetros con su valor (SOAP: nombre del WSDL → valor; SQL: columna → valor). */
  params?: Record<string, unknown>;
  /** Cuerpo enviado tal cual (sobre SOAP, JSON, sentencia SQL). */
  request?: string;
  /** Respuesta tal cual (recortada). */
  response?: string;
  /** Resultado interpretado o error. */
  result?: string;
  error?: string;
  companyId?: string | null;
  userEmail?: string | null;
}

const MAX_EVENTS = 250;
const MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_TEXT = 4000;
const KEY = 'evalos/call-log';

/** Quién hace la llamada: se apunta en el contexto de la petición al entrar en una ruta de Atajos de Evalos. */
export function setCallContext(companyId: string, userEmail: string) {
  const store = requestContext.getStore();
  if (store) { store.evalosCompanyId = companyId; store.evalosUserEmail = userEmail; }
}

const SECRET = /authorization|secret|password|passwd|pwd|access_token|client_secret/i;
const cut = (s: string | undefined) => (s == null ? undefined : s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}… (${s.length} caracteres)` : s);

function cleanParams(p?: Record<string, unknown>) {
  if (!p) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(p)) {
    if (v === undefined) continue;
    out[k] = SECRET.test(k) ? '(oculto)' : v instanceof Date ? v.toISOString() : typeof v === 'string' ? cut(v) : v;
  }
  return out;
}

let queue: Promise<void> = Promise.resolve();
let pending: EvalosCallEvent[] = [];
let scheduled = false;

/** Graba de una vez las llamadas pendientes (al cargar una pantalla se hacen muchas seguidas). */
function flush() {
  scheduled = false;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  const list = rawGet<EvalosCallEvent[]>(KEY);
  return list.then(async (prev) => {
    const cutoff = Date.now() - MAX_AGE_MS;
    const kept = (prev || []).filter((e) => Date.parse(e.at) >= cutoff);
    kept.push(...batch);
    await rawSet(KEY, kept.slice(-MAX_EVENTS));
  });
}

/** Apunta una llamada. Nunca lanza. */
export function logEvalosCall(ev: Omit<EvalosCallEvent, 'id' | 'at' | 'companyId' | 'userEmail'>) {
  try {
    const ctx = requestContext.getStore();
    // Las respuestas de las consultas (GET) pueden ser enormes: se guarda solo el principio.
    const response = ev.response && ev.kind === 'rest' && ev.op.startsWith('GET ') && ev.response.length > 1500 ? `${ev.response.slice(0, 1500)}… (${ev.response.length} caracteres)` : ev.response;
    pending.push({
      ...ev, id: id(), at: new Date().toISOString(),
      companyId: ctx?.evalosCompanyId ?? null, userEmail: ctx?.evalosUserEmail ?? null,
      params: cleanParams(ev.params), request: cut(ev.request), response: cut(response), result: cut(ev.result), error: cut(ev.error)
    });
  } catch { return queue; }
  if (!scheduled) {
    scheduled = true;
    queue = queue.then(() => new Promise<void>((r) => setTimeout(r, 200))).then(flush).catch(() => { /* best effort */ });
  }
  return queue;
}

/** Espera a que esté grabado todo lo pendiente (encadenado en la misma cola, sin carreras). */
function drain() {
  queue = queue.then(flush).catch(() => { /* best effort */ });
  return queue;
}

/** Llamadas, más recientes primero. companyId = solo las de esa empresa (y las sin empresa). */
export async function readCallLog(opts: { companyId?: string; kind?: CallKind; since?: string } = {}) {
  await drain();
  const list = (await rawGet<EvalosCallEvent[]>(KEY)) || [];
  const since = opts.since ? Date.parse(opts.since) : NaN;
  return list.filter((e) => (!opts.companyId || !e.companyId || e.companyId === opts.companyId)
    && (!opts.kind || e.kind === opts.kind)
    && (Number.isNaN(since) || Date.parse(e.at) >= since)).reverse();
}

/** Vacía el log (companyId = solo las llamadas de esa empresa). */
export async function clearCallLog(companyId?: string) {
  await drain();
  const list = companyId ? ((await rawGet<EvalosCallEvent[]>(KEY)) || []).filter((e) => e.companyId && e.companyId !== companyId) : [];
  await rawSet(KEY, list);
}
