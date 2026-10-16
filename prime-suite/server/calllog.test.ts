// Tests del log de llamadas a Evalos (depuración de SOAP, EvalosRest y escrituras de periodos).
// Ejecutar con:  npm test   (node --import tsx --test server/*.test.ts)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.PRIME_STORE = 'file';
process.env.PRIME_DATA_DIR = mkdtempSync(join(tmpdir(), 'ps-calllog-'));

const { requestContext } = await import('./http.ts');
const { logEvalosCall, readCallLog, clearCallLog, setCallContext } = await import('./evalos/calllog.ts');

test('apunta la llamada con la empresa y el usuario de la petición', async () => {
  await clearCallLog();
  await requestContext.run({}, async () => {
    setCallContext('emp-a', 'ana@ejemplo.com');
    await Promise.resolve();
    logEvalosCall({ kind: 'soap', op: 'AsignarHorasVacaciones', ok: true, status: 200, ms: 12,
      params: { EmpresaConexion: '133', CodigoPersonal: '0000000001', Horas: '04:30' }, request: '<soap:Envelope/>', response: '<r>Ok</r>', result: 'Ok' });
  });
  const list = await readCallLog();
  assert.equal(list.length, 1);
  assert.equal(list[0].op, 'AsignarHorasVacaciones');
  assert.equal(list[0].companyId, 'emp-a');
  assert.equal(list[0].userEmail, 'ana@ejemplo.com');
  assert.equal(list[0].params?.Horas, '04:30');
});

test('filtra por empresa y tipo, más recientes primero', async () => {
  await clearCallLog();
  await requestContext.run({}, async () => {
    setCallContext('emp-a', 'ana@ejemplo.com');
    logEvalosCall({ kind: 'rest', op: 'GET /Calendar', ok: true });
    logEvalosCall({ kind: 'sql', op: 'INSERT VACACIONES', ok: true });
  });
  await requestContext.run({}, async () => {
    setCallContext('emp-b', 'bea@ejemplo.com');
    logEvalosCall({ kind: 'soap', op: 'BorrarVacaciones', ok: false, error: 'fallo' });
  });
  assert.deepEqual((await readCallLog()).map((e) => e.op), ['BorrarVacaciones', 'INSERT VACACIONES', 'GET /Calendar']);
  assert.deepEqual((await readCallLog({ companyId: 'emp-a' })).map((e) => e.op), ['INSERT VACACIONES', 'GET /Calendar']);
  assert.deepEqual((await readCallLog({ kind: 'sql' })).map((e) => e.op), ['INSERT VACACIONES']);
  // Vaciar desde una empresa solo quita las suyas.
  await clearCallLog('emp-a');
  assert.deepEqual((await readCallLog()).map((e) => e.op), ['BorrarVacaciones']);
});

test('no guarda secretos y recorta las respuestas grandes de las consultas', async () => {
  await clearCallLog();
  logEvalosCall({ kind: 'rest', op: 'GET /Booking/attendance', ok: true, params: { client_secret: 'x', Authorization: 'Bearer y', empleado: '1' }, response: 'a'.repeat(5000) });
  logEvalosCall({ kind: 'soap', op: 'AsignarDiaVacaciones', ok: true, response: 'b'.repeat(3000) });
  const [soap, rest] = await readCallLog();
  assert.equal(rest.params?.client_secret, '(oculto)');
  assert.equal(rest.params?.Authorization, '(oculto)');
  assert.equal(rest.params?.empleado, '1');
  assert.ok(rest.response!.length < 1600 && rest.response!.includes('5000 caracteres'));
  assert.equal(soap.response, 'b'.repeat(3000));
});

test('agrupa muchas llamadas seguidas sin perder ninguna', async () => {
  await clearCallLog();
  for (let i = 0; i < 40; i++) logEvalosCall({ kind: 'rest', op: `GET /x${i}`, ok: true });
  const list = await readCallLog();
  assert.equal(list.length, 40);
  assert.equal(list[0].op, 'GET /x39');
});
