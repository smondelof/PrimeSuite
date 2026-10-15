// Cliente de los servicios SOAP de Evalos 8 (ServiciosCliente.asmx) para Prime Suite.
// La URL se configura en Integraciones › Evalos8 › API REST (campo «URL servicios SOAP»). No pide autenticación.
// Los nombres de los parámetros de cada operación se leen del WSDL del propio servicio (se guardan en caché) y se
// rellenan por su significado (empresa de conexión, empleado, tipo de vacaciones, fecha), así no dependen de la versión.
import { HttpError } from './http.ts';
import { Modules } from './db.ts';
import { safeFetch } from './netguard.ts';
import { EVALOS_REST_CLIENT_ID } from './evalosrest.ts';

const DEFAULT_NS = 'http://SuiteControls.Net/';

export async function evalosSoapUrl(): Promise<string> {
  const m = (await Modules.all()).find((x) => x.clientId === EVALOS_REST_CLIENT_ID);
  const url = m?.apiRest?.soapUrl;
  if (!url) throw new HttpError(409, 'Falta la URL de los servicios SOAP de Evalos 8: complétala en Integraciones › Evalos8 › API REST (URL servicios SOAP).', 'soap_not_configured');
  return url;
}

/** Empresa de conexión: los dígitos que siguen a «suiteclient» en la URL (…/suiteclient133/… → 133); '' si no hay. */
export function companyFromSoapUrl(url: string): string {
  return url.match(/suiteclient(\d+)/i)?.[1] || '';
}

export interface SoapOperation { name: string; params: string[] }
export interface SoapDescription { namespace: string; operations: Map<string, SoapOperation> }

const wsdlCache = new Map<string, { at: number; desc: SoapDescription }>();

/** Lee del WSDL el espacio de nombres y los parámetros (en orden) de cada operación. */
export function parseWsdl(xml: string): SoapDescription {
  const namespace = xml.match(/targetNamespace="([^"]+)"/)?.[1] || DEFAULT_NS;
  const operations = new Map<string, SoapOperation>();
  // <s:element name="Op"><s:complexType><s:sequence><s:element … name="P1" …/>…</s:sequence>
  const re = /<(?:\w+:)?element\s+name="([^"]+)"\s*>\s*<(?:\w+:)?complexType\s*(?:\/>|>\s*(?:<(?:\w+:)?sequence\s*>([\s\S]*?)<\/(?:\w+:)?sequence>|<(?:\w+:)?sequence\s*\/>)?)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const [, name, seq = ''] = m;
    if (name.endsWith('Response')) continue;
    const params = Array.from(seq.matchAll(/<(?:\w+:)?element\b[^>]*\bname="([^"]+)"/g)).map((x) => x[1]);
    operations.set(name.toLowerCase(), { name, params });
  }
  return { namespace, operations };
}

async function describe(url: string, portalOrigin: string, force = false): Promise<SoapDescription> {
  const hit = wsdlCache.get(url);
  if (!force && hit && Date.now() - hit.at < 60 * 60_000) return hit.desc;
  let text = '';
  try {
    const { res } = await safeFetch(`${url}?WSDL`, { headers: { accept: 'text/xml' }, portalOrigin, timeoutMs: 15000 });
    text = await res.text();
    if (!res.ok) throw new HttpError(502, `El servicio SOAP de Evalos respondió ${res.status} al pedir el WSDL. Revisa la URL servicios SOAP.`);
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `No se pudo conectar con los servicios SOAP de Evalos (${e?.name === 'AbortError' ? 'sin respuesta en 15 s' : e?.cause?.code || e?.message}).`);
  }
  const desc = parseWsdl(text);
  if (!desc.operations.size) throw new HttpError(502, 'La URL servicios SOAP no devuelve un WSDL válido (¿falta servicioscliente.asmx?).');
  wsdlCache.set(url, { at: Date.now(), desc });
  return desc;
}

/** Qué valor lleva cada parámetro según su nombre. */
export type SoapValues = { company?: string; employee?: string; vacationType?: string; date?: string; hours?: string };
export function valueFor(param: string, v: SoapValues): string {
  const p = param.toLowerCase();
  if (/empresa|conexion|connection|company/.test(p)) return v.company ?? '';
  if (/^horas?$|hora|hours/.test(p)) return v.hours ?? '';
  if (/fecha|^dia|date|^day/.test(p)) return v.date ?? '';
  if (/vacacion|tipo/.test(p)) return v.vacationType ?? '';
  if (/personal|empleado|employee|codigo|code/.test(p)) return v.employee ?? '';
  throw new HttpError(500, `Parámetro SOAP desconocido: ${param}`);
}

const xmlEsc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const xmlUnesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function soapEnvelope(ns: string, op: string, params: [string, string][]) {
  return `<?xml version="1.0" encoding="utf-8"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op} xmlns="${ns}">${params.map(([k, v]) => `<${k}>${xmlEsc(v)}</${k}>`).join('')}</${op}></soap:Body></soap:Envelope>`;
}

/** Texto de <OpResult> o, si es un fallo SOAP, el mensaje del faultstring. */
export function soapResult(xml: string, op: string): { fault?: string; result: string } {
  const fault = xml.match(/<faultstring>([\s\S]*?)<\/faultstring>/i)?.[1];
  if (fault) return { fault: xmlUnesc(fault).trim(), result: '' };
  const r = xml.match(new RegExp(`<${op}Result(?:\\s[^>]*)?>([\\s\\S]*?)</${op}Result>`, 'i'))?.[1];
  return { result: r == null ? '' : xmlUnesc(r.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim() };
}

/** Llama a una operación de ServiciosCliente con los valores indicados. Devuelve el texto del resultado. */
export async function callEvalosSoap(op: string, values: SoapValues, portalOrigin: string): Promise<{ result: string; ms: number; params: string[] }> {
  const url = await evalosSoapUrl();
  const desc = await describe(url, portalOrigin);
  const def = desc.operations.get(op.toLowerCase());
  if (!def) throw new HttpError(502, `El servicio SOAP de Evalos no tiene la operación ${op}.`);
  // Empresa de conexión: si no se indica, la de la URL (…/suiteclient133/… → 133).
  const v: SoapValues = { ...values, company: values.company || companyFromSoapUrl(url) };
  const params = def.params.map((p) => [p, valueFor(p, v)] as [string, string]);
  const started = Date.now();
  let res: Response;
  try {
    ({ res } = await safeFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'text/xml; charset=utf-8', SOAPAction: `"${desc.namespace}${def.name}"` },
      body: soapEnvelope(desc.namespace, def.name, params),
      portalOrigin,
      timeoutMs: 30000
    }));
  } catch (e: any) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(502, `No se pudo conectar con los servicios SOAP de Evalos (${e?.name === 'AbortError' ? 'sin respuesta en 30 s' : e?.cause?.code || e?.message}).`);
  }
  const text = await res.text();
  const r = soapResult(text, def.name);
  if (r.fault) throw new HttpError(502, `Evalos (SOAP ${def.name}): ${r.fault.slice(0, 300)}`);
  if (!res.ok) throw new HttpError(502, `El servicio SOAP de Evalos respondió ${res.status} en ${def.name}.`);
  return { result: r.result, ms: Date.now() - started, params: def.params };
}

/** Resultado correcto de una escritura: «Ok», «true», «1» o vacío. Otro texto es el mensaje de error de Evalos. */
export const soapOk = (result: string) => /^(ok|true|1|)$/i.test(result.trim());

/** Prueba de la URL SOAP para Integraciones: lee el WSDL y comprueba que tiene las operaciones de vacaciones. */
export async function testEvalosSoap(url: string, portalOrigin: string) {
  const started = Date.now();
  const desc = await describe(url, portalOrigin, true);
  const need = ['AsignarDiaVacaciones', 'BorrarVacaciones'];
  const missing = need.filter((n) => !desc.operations.has(n.toLowerCase()));
  return { ok: !missing.length, ms: Date.now() - started, operations: desc.operations.size, missing };
}

/** Solo para tests. */
export function resetSoapCache() { wsdlCache.clear(); }
