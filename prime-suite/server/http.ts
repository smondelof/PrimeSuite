// Utilidades HTTP: respuestas, cookies, errores y un router mínimo.
import { AsyncLocalStorage } from 'node:async_hooks';

/** Datos de la petición en curso (p. ej. empresa y usuario para el log de llamadas a Evalos). Se rellena en las rutas. */
export const requestContext = new AsyncLocalStorage<Record<string, string>>();

export class HttpError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

const baseHeaders = { 'cache-control': 'no-store' };

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...baseHeaders, ...headers } });
}

export function redirect(location: string, headers: Headers | Record<string, string> = {}) {
  const h = new Headers(headers);
  h.set('location', location);
  h.set('cache-control', 'no-store');
  return new Response(null, { status: 302, headers: h });
}

export function html(body: string, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...baseHeaders } });
}

export function parseCookies(req: Request) {
  const out: Record<string, string> = {};
  const raw = req.headers.get('cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, opts: { maxAge?: number; secure: boolean }) {
  // SameSite=None para que la sesión funcione cuando una app embebida abre /oidc/authorize dentro de un iframe.
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly'];
  if (opts.secure) parts.push('Secure', 'SameSite=None');
  else parts.push('SameSite=Lax');
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  return parts.join('; ');
}

export function origin(req: Request) {
  if (process.env.PRIME_ISSUER) return process.env.PRIME_ISSUER.replace(/\/$/, '');
  const url = new URL(req.url);
  const proto = req.headers.get('x-forwarded-proto') || url.protocol.replace(':', '');
  const host = req.headers.get('x-forwarded-host') || req.headers.get('host') || url.host;
  return `${proto}://${host}`;
}

export const isSecure = (req: Request) => origin(req).startsWith('https://');

export function clientIp(req: Request) {
  return req.headers.get('x-nf-client-connection-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || undefined;
}

// Protección CSRF para peticiones que cambian estado en /api: el Origin debe coincidir.
export function assertSameOrigin(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
  const o = req.headers.get('origin');
  if (o && o !== origin(req)) throw new HttpError(403, 'Origen no permitido');
}

export async function body<T = any>(req: Request): Promise<T> {
  const ct = req.headers.get('content-type') || '';
  if (ct.includes('application/json')) {
    try {
      return (await req.json()) as T;
    } catch {
      throw new HttpError(400, 'JSON inválido');
    }
  }
  if (ct.includes('application/x-www-form-urlencoded') || ct.includes('multipart/form-data')) {
    const f = await req.formData();
    const o: Record<string, string> = {};
    f.forEach((v, k) => (o[k] = String(v)));
    return o as T;
  }
  return {} as T;
}

type Handler = (req: Request, params: Record<string, string>) => Promise<Response>;
interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  h: Handler;
}

export class Router {
  private routes: Route[] = [];
  on(method: string, pattern: string, h: Handler) {
    const keys: string[] = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^/]+)';
        }) +
        '/?$'
    );
    this.routes.push({ method, re, keys, h });
    return this;
  }
  get(p: string, h: Handler) { return this.on('GET', p, h); }
  post(p: string, h: Handler) { return this.on('POST', p, h); }
  put(p: string, h: Handler) { return this.on('PUT', p, h); }
  del(p: string, h: Handler) { return this.on('DELETE', p, h); }

  async handle(req: Request): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    let pathMatched = false;
    for (const r of this.routes) {
      const m = path.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== req.method && !(r.method === 'GET' && req.method === 'HEAD')) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return requestContext.run({}, () => r.h(req, params));
    }
    if (pathMatched) return json({ error: 'Método no permitido' }, 405);
    return null;
  }
}
