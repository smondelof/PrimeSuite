// Cliente de EvalosRest (API REST de Evalos 8) para Prime Suite.
// Usa la sección API REST de la integración Evalos8 (Integraciones › Evalos8 › API REST): pide un token OAuth2
// (client credentials) a la URL token, lo reutiliza hasta poco antes de caducar y lo renueva ante un 401.
// El token y el secreto nunca salen del servidor.
import { HttpError } from './http.ts';
import { Modules, type Module } from './db.ts';
import { decryptSecret } from './crypto.ts';
import { safeFetch } from './netguard.ts';
import { logEvalosCall } from './evalos/calllog.ts';

/** clientId de la integración cuya API REST se usa para Evalos 8. */
export const EVALOS_REST_CLIENT_ID = 'evalos8';
const API_VERSION = 'v1';

interface CachedToken { token: string; exp: number; key: string }
const tokens = new Map<string, CachedToken>();
// Peticiones de token en curso: llamadas simultáneas comparten la misma (evita pedir varios tokens a la vez).
const pending = new Map<string, Promise<string>>();

async function evalosRestModule(): Promise<Module> {
  const m = (await Modules.all()).find((x) => x.clientId === EVALOS_REST_CLIENT_ID);
  const a = m?.apiRest;
  if (!m || !a?.apiUrl || !a.tokenUrl || !a.clientId || !a.clientSecretEnc) {
    throw new HttpError(409, 'Falta configurar la API REST de Evalos 8: complétala en Integraciones › Evalos8 › API REST (URL API, URL token, Client ID y Client Secret).', 'apirest_not_configured');
  }
  return m;
}

/** Token vigente. `rejected` = token que EvalosRest acaba de rechazar (401): se pide otro salvo que ya se haya renovado. */
async function getToken(m: Module, portalOrigin: string, rejected?: string): Promise<string> {
  const a = m.apiRest!;
  // Si cambia la configuración, el token guardado deja de valer.
  const key = `${a.tokenUrl}|${a.clientId}|${a.clientSecretEnc}`;
  const hit = tokens.get(m.id);
  if (hit && hit.key === key && hit.exp > Date.now() + 60_000 && hit.token !== rejected) return hit.token;
  const flight = pending.get(m.id);
  if (flight) return flight;
  const p = requestToken(m, portalOrigin, key).finally(() => pending.delete(m.id));
  pending.set(m.id, p);
  return p;
}

async function requestToken(m: Module, portalOrigin: string, key: string): Promise<string> {
  const a = m.apiRest!;
  const secret = await decryptSecret(a.clientSecretEnc!).catch(() => {
    throw new HttpError(500, 'No se pudo descifrar el Client Secret de la API REST. Vuelve a introducirlo en Integraciones › Evalos8 › API REST.');
  });
  let res: Response;
  try {
    ({ res } = await safeFetch(a.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'client_credentials', client_id: a.clientId, client_secret: secret }).toString(),
      portalOrigin,
      timeoutMs: 10000
    }));
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `No se pudo conectar con la URL token de Evalos (${e?.name === 'AbortError' ? 'sin respuesta en 10 s' : e?.cause?.code || e?.message}).`);
  }
  const text = await res.text();
  let j: any = null;
  try { j = JSON.parse(text); } catch { /* no JSON */ }
  if (!res.ok || !j?.access_token) {
    const why = j?.error_description || j?.error || text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160);
    throw new HttpError(502, `Evalos no ha dado el token (${res.status}${why ? ` · ${why}` : ''}). Revisa Client ID y Client Secret en Integraciones › Evalos8 › API REST.`);
  }
  const ttl = Math.max(60, Number(j.expires_in) || 3600);
  tokens.set(m.id, { token: j.access_token, exp: Date.now() + ttl * 1000, key });
  return j.access_token;
}

export interface RestResult<T = unknown> { data: T; status: number; ms: number; url: string }

/** GET a EvalosRest: `path` relativo a /api/v1 (p. ej. "/Booking/attendance?..."). */
export function evalosRestGet<T = unknown>(path: string, portalOrigin: string): Promise<RestResult<T>> {
  return evalosRestCall<T>('GET', path, portalOrigin);
}

/** PUT a EvalosRest con cuerpo JSON: `path` relativo a /api/v1 (p. ej. "/Absence"). */
export function evalosRestPut<T = unknown>(path: string, payload: unknown, portalOrigin: string): Promise<RestResult<T>> {
  return evalosRestCall<T>('PUT', path, portalOrigin, payload);
}

/** POST a EvalosRest con cuerpo JSON: `path` relativo a /api/v1 (p. ej. "/Booking/attendance"). */
export function evalosRestPost<T = unknown>(path: string, payload: unknown, portalOrigin: string): Promise<RestResult<T>> {
  return evalosRestCall<T>('POST', path, portalOrigin, payload);
}

/**
 * DELETE a EvalosRest. No lanza error si Evalos responde 4xx/5xx: devuelve el estado y el mensaje
 * (quien llama decide, p. ej. probar otro formato de fecha). Sí lanza si no hay conexión o falla el token.
 */
/** GET a EvalosRest que no lanza error si Evalos responde 4xx/5xx (p. ej. 404 = no existe). */
export async function evalosRestTryGet(path: string, portalOrigin: string): Promise<RestResult<unknown> & { ok: boolean; message: string }> {
  return evalosRestCall('GET', path, portalOrigin, undefined, false) as any;
}

export async function evalosRestDelete(path: string, portalOrigin: string): Promise<RestResult<unknown> & { ok: boolean; message: string }> {
  return evalosRestCall('DELETE', path, portalOrigin, undefined, false) as any;
}

async function evalosRestCall<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, portalOrigin: string, payload?: unknown, throwOnError = true): Promise<RestResult<T> & { ok?: boolean; message?: string }> {
  const m = await evalosRestModule();
  const url = `${m.apiRest!.apiUrl.replace(/\/+$/, '')}/api/${API_VERSION}${path.startsWith('/') ? path : `/${path}`}`;
  const started = Date.now();
  const call = async (token: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    try {
      return (await safeFetch(url, { method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), portalOrigin, timeoutMs: 30000 })).res;
    } catch (e: any) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `No se pudo conectar con EvalosRest (${e?.name === 'AbortError' ? 'sin respuesta en 30 s' : e?.cause?.code || e?.message}).`);
    }
  };
  const entry = { kind: 'rest' as const, op: `${method} ${path.split('?')[0]}`, url, request: payload === undefined ? undefined : JSON.stringify(payload, null, 2) };
  let res: Response;
  try {
    const token = await getToken(m, portalOrigin);
    res = await call(token);
    // Token caducado o revocado: se pide uno nuevo y se reintenta una vez.
    if (res.status === 401) res = await call(await getToken(m, portalOrigin, token));
  } catch (e: any) {
    void logEvalosCall({ ...entry, ok: false, ms: Date.now() - started, error: e?.message || String(e) });
    throw e;
  }
  const text = await res.text();
  let data: any = text;
  try { data = text ? JSON.parse(text) : null; } catch { /* respuesta no JSON */ }
  void logEvalosCall({ ...entry, ok: res.ok, status: res.status, ms: Date.now() - started, response: text || '(vacía)' });
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? data.Message || data.message || data.error || '' : String(data ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!throwOnError) return { data, status: res.status, ms: Date.now() - started, url, ok: false, message: String(msg).slice(0, 200) };
    const hint = res.status === 401 ? ' El token no es válido para esta API: revisa las credenciales.'
      : res.status === 403 ? ' Datos no válidos para este servicio.'
      : res.status === 404 ? ' Revisa la URL API (sin /api/v1).'
      : /ConnectionString/.test(String(msg)) ? ' El Client ID no tiene base de datos asociada en esta instalación.' : '';
    throw new HttpError(502, `EvalosRest respondió ${res.status}${msg ? ` · ${String(msg).slice(0, 200)}` : ''}.${hint}`);
  }
  const okMsg = typeof data === 'object' && data ? String(data.Message || data.message || '') : String(data ?? '');
  return { data, status: res.status, ms: Date.now() - started, url, ok: true, message: okMsg.slice(0, 200) };
}

/** Solo para tests: olvida los tokens guardados. */
export function resetEvalosRestTokens() { tokens.clear(); pending.clear(); }
