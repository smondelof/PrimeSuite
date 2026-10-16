// Ventana «Log de llamadas a Evalos» (solo administradores): lo que Prime Suite envía a Evalos 8 y lo que responde.
// Servicios SOAP (ServiciosCliente), EvalosRest y las escrituras de periodos en VACACIONES / INCIDENCIALIMITE.
import { useCallback, useEffect, useState } from 'react';
import { api, type EvalosCallEvent } from '../../api';
import { Drawer, ErrorBox, Icon, confirmAction, useToast } from '../../components/ui';

type Kind = '' | EvalosCallEvent['kind'];
const KINDS: { key: Kind; label: string }[] = [
  { key: '', label: 'Todas' },
  { key: 'soap', label: 'SOAP' },
  { key: 'rest', label: 'EvalosRest' },
  { key: 'sql', label: 'Periodos (SQL)' }
];
const KIND_TAG: Record<EvalosCallEvent['kind'], string> = { soap: 'SOAP', rest: 'REST', sql: 'SQL' };

function fmtWhen(iso: string) {
  const d = new Date(iso);
  return `${d.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit' })} ${d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

/** Sobre SOAP o JSON más legible: un elemento por línea. */
function pretty(text: string) {
  const t = text.trim();
  if (t.startsWith('<')) return t.replace(/>\s*</g, '>\n<');
  if (t.startsWith('{') || t.startsWith('[')) {
    try { return JSON.stringify(JSON.parse(t), null, 2); } catch { /* recortado */ }
  }
  return t;
}

function Block({ label, text }: { label: string; text: string }) {
  const toast = useToast();
  return (
    <div className="col" style={{ gap: 4 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="xs muted grow">{label}</span>
        <button type="button" className="btn sm ghost" onClick={() => navigator.clipboard.writeText(text).then(() => toast('Copiado'))}><Icon.copy /> Copiar</button>
      </div>
      <pre className="code evcall-pre">{pretty(text)}</pre>
    </div>
  );
}

function CallItem({ e, showUser }: { e: EvalosCallEvent; showUser: boolean }) {
  const [open, setOpen] = useState(!e.ok);
  const params = Object.entries(e.params || {});
  return (
    <li className={`sso-step ${e.ok ? 'ok' : 'error'}`}>
      <button type="button" className="evcall-head" onClick={() => setOpen((x) => !x)} aria-expanded={open}>
        <span className="mono xs muted">{fmtWhen(e.at)}</span>
        <span className="tag outline">{KIND_TAG[e.kind]}</span>
        <b className="small grow mono">{e.op}</b>
        {e.status != null && <span className="mono xs muted">HTTP {e.status}</span>}
        {e.ms != null && <span className="mono xs muted">{e.ms} ms</span>}
        <span className={`tag ${e.ok ? 'ok' : 'bad'}`}>{e.ok ? 'Correcto' : 'Error'}</span>
        <span className={`chev${open ? ' open' : ''}`}><Icon.chevron /></span>
      </button>
      {(e.error || e.result) && (
        <span className="small">{e.error ? <b>{e.error}</b> : <>Resultado: <span className="mono">{e.result}</span></>}</span>
      )}
      {open && (
        <>
          {(showUser && e.userEmail) || e.url ? (
            <span className="xs muted" style={{ wordBreak: 'break-all' }}>{[showUser && e.userEmail, e.url].filter(Boolean).join(' · ')}</span>
          ) : null}
          {params.length > 0 && (
            <table className="sso-kv">
              <tbody>
                {params.map(([k, v]) => (
                  <tr key={k}><th className="mono">{k}</th><td className="mono">{v === '' ? <span className="muted">(vacío)</span> : String(v)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
          {e.request && <Block label={e.kind === 'sql' ? 'Sentencia SQL' : 'Enviado'} text={e.request} />}
          {e.response && <Block label="Respuesta de Evalos" text={e.response} />}
        </>
      )}
    </li>
  );
}

export default function EvalosCallLog({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [kind, setKind] = useState<Kind>('');
  const [events, setEvents] = useState<EvalosCallEvent[] | null>(null);
  const [live, setLive] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.get<{ events: EvalosCallEvent[] }>(`/api/evalos/llamadas${kind ? `?kind=${kind}` : ''}`);
      setEvents(r.events);
      setErr(null);
    } catch (e: any) {
      setErr(e.message);
    }
  }, [kind]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!live) return;
    const t = setInterval(load, 3000);
    return () => clearInterval(t);
  }, [live, load]);

  async function clear() {
    if (!confirmAction('¿Vaciar el log de llamadas a Evalos?')) return;
    try {
      await api.del('/api/evalos/llamadas');
      toast('Log vaciado');
      load();
    } catch (e: any) {
      toast(e.message, true);
    }
  }

  const list = events || [];
  const users = new Set(list.map((e) => e.userEmail).filter(Boolean));
  return (
    <Drawer
      width={860}
      onClose={onClose}
      title={
        <div className="col" style={{ gap: 2 }}>
          <span className="xs muted">Atajos de Evalos · depuración</span>
          <h2 style={{ fontSize: 20 }}>Log de llamadas a Evalos</h2>
        </div>
      }
    >
      <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
        <div className="viewseg">
          {KINDS.map((k) => (
            <button key={k.key || 'all'} type="button" className={kind === k.key ? 'on' : ''} onClick={() => setKind(k.key)}>{k.label}</button>
          ))}
        </div>
        <span className="grow" />
        <label className="check xs"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /> En directo</label>
        <button type="button" className="btn sm" onClick={load}><Icon.refresh /> Actualizar</button>
        <button type="button" className="btn sm danger" onClick={clear}><Icon.trash /> Vaciar</button>
      </div>
      <ErrorBox error={err} />
      <ol className="sso-steps">
        {list.map((e) => <CallItem key={e.id} e={e} showUser={users.size > 0} />)}
      </ol>
      {events && !list.length && (
        <span className="small muted">Todavía no hay llamadas. Haz la operación (p. ej. guardar un convenio o asignar vacaciones en Correcciones) y aparecerá aquí.</span>
      )}
      <span className="xs muted">
        Las más recientes primero; se guardan las últimas 250 durante 7 días. Las llamadas con error se muestran abiertas.
        No se guardan tokens ni contraseñas. Las respuestas de las consultas se recortan.
      </span>
    </Drawer>
  );
}
