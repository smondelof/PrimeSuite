// Servicios SOAP de Evalos (ServiciosCliente): WSDL, sobre y vacaciones de Correcciones contra un servicio simulado.
// Ejecutar con:  npm test   (node --import tsx --test server/*.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Module } from './db.ts';

process.env.PRIME_STORE = 'file';
process.env.PRIME_DATA_DIR = mkdtempSync(join(tmpdir(), 'ps-evalossoap-'));
process.env.PRIME_ISSUER = 'https://primesuite.test';
process.env.PRIME_ALLOW_PRIVATE_FETCH = '1';
const ISS = 'https://primesuite.test';

const { handle } = await import('./app.ts');
const db = await import('./db.ts');
const { createSession } = await import('./crypto.ts');
const { parseWsdl, valueFor, soapResult, resetSoapCache, companyFromSoapUrl } = await import('./evalossoap.ts');

const WSDL = `<?xml version="1.0"?><wsdl:definitions targetNamespace="http://SuiteControls.Net/" xmlns:s="http://www.w3.org/2001/XMLSchema"><wsdl:types><s:schema>
<s:element name="AsignarDiaVacaciones"><s:complexType><s:sequence>
<s:element minOccurs="0" maxOccurs="1" name="EmpresaConexion" type="s:string"/><s:element minOccurs="0" maxOccurs="1" name="CodigoPersonal" type="s:string"/>
<s:element minOccurs="0" maxOccurs="1" name="CodigoVacaciones" type="s:string"/><s:element minOccurs="0" maxOccurs="1" name="FechaVacaciones" type="s:string"/>
</s:sequence></s:complexType></s:element>
<s:element name="AsignarDiaVacacionesResponse"><s:complexType><s:sequence><s:element name="AsignarDiaVacacionesResult" type="s:string"/></s:sequence></s:complexType></s:element>
<s:element name="BorrarVacaciones"><s:complexType><s:sequence>
<s:element name="EmpresaConexion" type="s:string"/><s:element name="CodigoPersonal" type="s:string"/><s:element name="FechaVacaciones" type="s:string"/>
</s:sequence></s:complexType></s:element>
<s:element name="AsignarHorasVacaciones"><s:complexType><s:sequence>
<s:element name="EmpresaConexion" type="s:string"/><s:element name="CodigoPersonal" type="s:string"/><s:element name="CodigoVacaciones" type="s:string"/>
<s:element name="FechaVacaciones" type="s:string"/><s:element name="Horas" type="s:string"/>
</s:sequence></s:complexType></s:element>
<s:element name="Srv_AppVersion"><s:complexType/></s:element>
</s:schema></wsdl:types></wsdl:definitions>`;

const calls: { action: string; body: string }[] = [];
let reply = 'Ok';
const srv = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    if (req.method === 'GET' && /\?WSDL$/i.test(req.url || '')) { res.setHeader('content-type', 'text/xml'); return res.end(WSDL); }
    const action = String(req.headers.soapaction || '');
    calls.push({ action, body: raw });
    const op = action.replace(/"/g, '').split('/').pop();
    res.setHeader('content-type', 'text/xml');
    res.end(`<?xml version="1.0"?><soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body><${op}Response xmlns="http://SuiteControls.Net/"><${op}Result>${reply}</${op}Result></${op}Response></soap:Body></soap:Envelope>`);
  });
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
const SOAP = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/Digitek/suiteclient133/servicioscliente.asmx`;

const companyId = db.id();
const userId = db.id();
await db.Companies.put({ id: companyId, name: 'Digitek', code: 'pri5', enabledModules: [], moduleUrls: {}, createdAt: db.now() });
await db.Users.put({ id: userId, companyId, email: 'super@digitek.es', firstName: 'Super', lastName: '', passwordHash: 'x', role: 'superadmin', groupIds: [], status: 'active', sessionVersion: 1, createdAt: db.now() });
const COOKIE = `ps_session=${encodeURIComponent((await createSession('', { id: userId, sessionVersion: 1 })).token)}`;
await db.Modules.put({
  id: db.id(), clientId: 'evalos8', name: 'Evalos8', description: '', categoryId: null, initials: 'EV', color: '#243A4D', url: 'https://x/', openMode: 'iframe',
  authMethod: 'oidc', tokenDelivery: 'fragment', tokenParam: 'prime_token', tokenTtlSec: 60, redirectUris: [], postLogoutRedirectUris: [],
  defaultRole: 'user', widgets: [], enabled: true, order: 50, createdAt: db.now(), updatedAt: db.now(),
  apiRest: { apiUrl: '', tokenUrl: '', clientId: '', soapUrl: SOAP }
} as Module);
const call = async (method: string, path: string, body?: unknown) => {
  const res = await handle(new Request(`${ISS}${path}`, { method, headers: { cookie: COOKIE, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  return { status: res.status, body: (await res.json()) as any };
};

test('WSDL: espacio de nombres y parámetros en orden de cada operación', () => {
  const d = parseWsdl(WSDL);
  assert.equal(d.namespace, 'http://SuiteControls.Net/');
  assert.deepEqual(d.operations.get('asignardiavacaciones'), { name: 'AsignarDiaVacaciones', params: ['EmpresaConexion', 'CodigoPersonal', 'CodigoVacaciones', 'FechaVacaciones'] });
  assert.deepEqual(d.operations.get('srv_appversion')?.params, []);
  assert.ok(!d.operations.has('asignardiavacacionesresponse'));
});

test('cada parámetro recibe su valor por el nombre', () => {
  const v = { company: '', employee: '43699738', vacationType: 'V1', date: '08/10/2026' };
  assert.deepEqual(['EmpresaConexion', 'CodigoPersonal', 'CodigoVacaciones', 'FechaInicio', 'FechaVacaciones', 'Dia'].map((p) => valueFor(p, v)), ['', '43699738', 'V1', '08/10/2026', '08/10/2026', '08/10/2026']);
});

test('empresa de conexión: los dígitos tras suiteclient en la URL', () => {
  assert.equal(companyFromSoapUrl('https://evalos-d.digitekcloud.com/Digitek/suiteclient133/servicioscliente.asmx'), '133');
  assert.equal(companyFromSoapUrl('https://x/Digitek/SuiteClient/servicioscliente.asmx'), '');
});

test('resultado y fallo SOAP', () => {
  assert.deepEqual(soapResult('<x><OpResult>Ok</OpResult></x>', 'Op'), { result: 'Ok' });
  assert.deepEqual(soapResult('<soap:Fault><faultstring>Error &amp; más</faultstring></soap:Fault>', 'Op'), { fault: 'Error & más', result: '' });
});

test('Asignar vacaciones del día: SOAP AsignarDiaVacaciones con los parámetros del WSDL', async () => {
  resetSoapCache();
  // Sin configuración de Atajos no se pasa por la BD: la ruta solo usa SOAP.
  const r = await call('POST', '/api/evalos/correcciones/vacaciones', { employee: '43699738', date: '2026-10-08', type: 'V1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(calls.at(-1)!.action, '"http://SuiteControls.Net/AsignarDiaVacaciones"');
  assert.match(calls.at(-1)!.body, /<AsignarDiaVacaciones xmlns="http:\/\/SuiteControls.Net\/"><EmpresaConexion>133<\/EmpresaConexion><CodigoPersonal>43699738<\/CodigoPersonal><CodigoVacaciones>V1<\/CodigoVacaciones><FechaVacaciones>08\/10\/2026<\/FechaVacaciones><\/AsignarDiaVacaciones>/);
});

test('Cambiar: primero BorrarVacaciones y luego AsignarDiaVacaciones; quitar: BorrarVacaciones', async () => {
  calls.length = 0;
  assert.equal((await call('POST', '/api/evalos/correcciones/vacaciones', { employee: '43699738', date: '2026-10-08', type: 'V2', replace: true })).status, 201);
  assert.deepEqual(calls.map((c) => c.action.replace(/"|http:\/\/SuiteControls.Net\//g, '')), ['BorrarVacaciones', 'AsignarDiaVacaciones']);
  calls.length = 0;
  assert.equal((await call('DELETE', '/api/evalos/correcciones/vacaciones', { employee: '43699738', date: '2026-10-08' })).status, 200);
  assert.match(calls[0].body, /<BorrarVacaciones xmlns="http:\/\/SuiteControls.Net\/"><EmpresaConexion>133<\/EmpresaConexion><CodigoPersonal>43699738<\/CodigoPersonal><FechaVacaciones>08\/10\/2026<\/FechaVacaciones><\/BorrarVacaciones>/);
});

test('periodos en horas: AsignarHorasVacaciones con las horas HH:MM', async () => {
  const { assignHolidayHours, cleanHours } = await import('./evalos/marcajesrest.ts');
  assert.equal(cleanHours('4:30'), '04:30');
  assert.throws(() => cleanHours('0:00'));
  assert.throws(() => cleanHours('8'));
  calls.length = 0;
  await assignHolidayHours('43699738', '2026-10-08', 'H25', '04:30', ISS);
  assert.equal(calls[0].action, '"http://SuiteControls.Net/AsignarHorasVacaciones"');
  assert.match(calls[0].body, /<CodigoVacaciones>H25<\/CodigoVacaciones><FechaVacaciones>08\/10\/2026<\/FechaVacaciones><Horas>04:30<\/Horas>/);
});

test('si Evalos devuelve un mensaje en lugar de Ok, se muestra como error', async () => {
  reply = 'El empleado no tiene periodo de vacaciones';
  const r = await call('POST', '/api/evalos/correcciones/vacaciones', { employee: '43699738', date: '2026-10-08', type: 'V1' });
  assert.equal(r.status, 502);
  assert.match(r.body.error, /no tiene periodo de vacaciones/);
  reply = 'Ok';
  srv.close();
});
