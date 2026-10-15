// Atajos de Evalos · Correcciones.
// Corrige marcajes (fichajes), resuelve solicitudes de empleados y registra ausencias.
// El mismo componente sirve de pantalla completa y de widget del Inicio.
// Sin conexión (modo demostración) trabaja sobre el motor de demostración; con conexión real, la vista de Marcajes
// se alimenta de la API REST de Evalos 8: anomalías del listado PS_ANOMA y marcajes de Booking/attendance.
import { useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import {
  api, ApiError, type EvalosCorreccionesResponse, type EvalosMarcaje, type EvalosMarcajePunch,
  type EvalosRestMarcaje, type EvalosRestMarcajesResponse, type EvalosBookingRef, type EvalosDayInfo, type EvalosIncidencia, type EvalosEmployeeBrief, type EvalosOrgKey
} from '../../api';
import { ErrorBox, Icon, Loading, Modal, confirmAction, useData, useToast } from '../../components/ui';
import { NotConfigured } from './common';

const NC = { notConfigured: true } as unknown as EvalosCorreccionesResponse;
const fmtDate = (iso: string) => (iso ? iso.split('-').reverse().join('/') : '');
const AUSENCIA_TYPES = ['Enfermedad común', 'Accidente', 'Permiso retribuido', 'Asuntos propios', 'Vacaciones', 'Maternidad/Paternidad', 'Otros'];

function useCorrecciones() {
  const { data, error, reload } = useData(() =>
    api.get<EvalosCorreccionesResponse>('/api/evalos/correcciones').catch((e) => {
      if (e instanceof ApiError && e.code === 'not_configured') return NC;
      throw e;
    })
  );
  let node: JSX.Element | null = null;
  if (data === NC) node = <NotConfigured />;
  else if (error) node = <div className="col" style={{ gap: 8 }}><ErrorBox error={error} /><button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={reload}><Icon.refresh /> Reintentar</button></div>;
  return { data: data === NC ? null : data, error: node, reload };
}

type Tab = 'marcajes' | 'solicitudes' | 'ausencias';

export default function Correcciones() {
  const { data, error, reload } = useCorrecciones();
  const [tab, setTab] = useState<Tab>('marcajes');
  const [editM, setEditM] = useState<EvalosMarcaje | null>(null);
  const toast = useToast();

  if (error) return error;
  if (!data) return <Loading />;
  if (data.mode === 'rest') return <MarcajesRest employees={data.employees} lookups={data.lookups || {}} canEdit={data.canEdit} canDelete={data.canDelete} />;

  const incidencias = data.marcajes.filter((m) => m.status === 'INCIDENCIA').length;
  const pendientes = data.solicitudes.filter((s) => s.status === 'PENDIENTE').length;

  async function resolve(id: string) {
    try { await api.post(`/api/evalos/marcajes/${encodeURIComponent(id)}/resolver`); reload(); }
    catch (err: any) { toast(err.message, true); }
  }
  async function decide(id: string, approve: boolean) {
    try { await api.post(`/api/evalos/solicitudes/${encodeURIComponent(id)}/decidir`, { approve }); reload(); }
    catch (err: any) { toast(err.message, true); }
  }
  async function delAusencia(id: string) {
    if (!confirmAction('¿Eliminar esta ausencia?')) return;
    try { await api.del(`/api/evalos/ausencias/${encodeURIComponent(id)}`); reload(); }
    catch (err: any) { toast(err.message, true); }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="tabs" role="tablist">
        {([['marcajes', `Marcajes${incidencias ? ` · ${incidencias}` : ''}`], ['solicitudes', `Solicitudes${pendientes ? ` · ${pendientes}` : ''}`], ['ausencias', 'Ausencias']] as [Tab, string][]).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>
        ))}
        <span className="grow" />
        <button className="btn sm" onClick={reload}><Icon.refresh /> Actualizar</button>
      </div>

      {tab === 'marcajes' && (
        <div className="card flat">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 110 }}>Fecha</th><th>Empleado</th><th>Marcajes</th><th style={{ width: 230 }}>Estado</th>{data.canEdit && <th style={{ width: 150 }} />}</tr></thead>
              <tbody>
                {data.marcajes.map((m) => (
                  <tr key={m.id}>
                    <td className="mono small">{fmtDate(m.date)}</td>
                    <td className="small">{m.employeeName}</td>
                    <td className="mono small">{m.punches.length ? m.punches.map((p) => `${p.time}${p.type === 'E' ? '↓' : '↑'}`).join('  ') : <span className="muted">—</span>}</td>
                    <td>{m.status === 'OK' ? <span className="tag ok">Correcto</span> : <span className="tag bad" title={m.issue}>{m.issue || 'Incidencia'}</span>}</td>
                    {data.canEdit && (
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn sm" onClick={() => setEditM(m)}><Icon.edit /> Corregir</button>
                          {m.status === 'INCIDENCIA' && <button className="btn sm" onClick={() => resolve(m.id)} title="Marcar como resuelta">OK</button>}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
                {!data.marcajes.length && <tr><td colSpan={5} className="muted small" style={{ padding: 28, textAlign: 'center' }}>No hay marcajes.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="ev-foot xs muted">↓ entrada · ↑ salida · {incidencias} incidencia(s)</div>
        </div>
      )}

      {tab === 'solicitudes' && (
        <div className="card flat">
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Empleado</th><th style={{ width: 160 }}>Tipo</th><th style={{ width: 180 }}>Fechas</th><th style={{ width: 70, textAlign: 'right' }}>Días</th><th style={{ width: 120 }}>Estado</th>{data.canEdit && <th style={{ width: 170 }} />}</tr></thead>
              <tbody>
                {data.solicitudes.map((s) => (
                  <tr key={s.id}>
                    <td className="small">{s.employeeName}{s.reason && <div className="xs muted">{s.reason}</div>}</td>
                    <td className="small">{s.type}</td>
                    <td className="small">{fmtDate(s.from)}{s.to !== s.from ? ` – ${fmtDate(s.to)}` : ''}</td>
                    <td className="small" style={{ textAlign: 'right' }}>{s.days}</td>
                    <td>{s.status === 'PENDIENTE' ? <span className="tag warn">Pendiente</span> : s.status === 'APROBADA' ? <span className="tag ok">Aprobada</span> : <span className="tag bad">Rechazada</span>}</td>
                    {data.canEdit && (
                      <td>{s.status === 'PENDIENTE' && (
                        <div className="row" style={{ gap: 6 }}>
                          <button className="btn sm success" onClick={() => decide(s.id, true)}>Aprobar</button>
                          <button className="btn sm danger" onClick={() => decide(s.id, false)}>Rechazar</button>
                        </div>
                      )}</td>
                    )}
                  </tr>
                ))}
                {!data.solicitudes.length && <tr><td colSpan={6} className="muted small" style={{ padding: 28, textAlign: 'center' }}>No hay solicitudes.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="ev-foot xs muted">Al aprobar una solicitud de vacaciones/permiso se registra automáticamente en Ausencias.</div>
        </div>
      )}

      {tab === 'ausencias' && <AusenciasTab data={data} onChanged={reload} onDelete={delAusencia} />}

      {editM && <MarcajeModal marcaje={editM} onClose={() => setEditM(null)} onSaved={() => { setEditM(null); reload(); }} />}
    </div>
  );
}

function AusenciasTab({ data, onChanged, onDelete }: { data: EvalosCorreccionesResponse; onChanged: () => void; onDelete: (id: string) => void }) {
  const [employee, setEmployee] = useState('');
  const [type, setType] = useState(AUSENCIA_TYPES[0]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!employee) return toast('Elige un empleado', true);
    setBusy(true);
    try { await api.post('/api/evalos/ausencias', { employee, type, from, to: to || from, reason }); setEmployee(''); setFrom(''); setTo(''); setReason(''); onChanged(); }
    catch (err: any) { toast(err.message, true); }
    finally { setBusy(false); }
  }

  return (
    <div className="grid-2" style={{ alignItems: 'start', gridTemplateColumns: '1.3fr 1fr' }}>
      <div className="card flat">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Empleado</th><th style={{ width: 160 }}>Tipo</th><th style={{ width: 180 }}>Fechas</th><th style={{ width: 60, textAlign: 'right' }}>Días</th>{data.canDelete && <th style={{ width: 40 }} />}</tr></thead>
            <tbody>
              {data.ausencias.map((a) => (
                <tr key={a.id}>
                  <td className="small">{a.employeeName}{a.reason && <div className="xs muted">{a.reason}</div>}</td>
                  <td className="small">{a.type}</td>
                  <td className="small">{fmtDate(a.from)}{a.to !== a.from ? ` – ${fmtDate(a.to)}` : ''}</td>
                  <td className="small" style={{ textAlign: 'right' }}>{a.days}</td>
                  {data.canDelete && <td><button className="icon-btn" aria-label="Quitar" onClick={() => onDelete(a.id)}><Icon.trash /></button></td>}
                </tr>
              ))}
              {!data.ausencias.length && <tr><td colSpan={5} className="muted small" style={{ padding: 28, textAlign: 'center' }}>No hay ausencias registradas.</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {data.canEdit && (
        <form className="card" onSubmit={submit}>
          <h3>Añadir ausencia</h3>
          <label className="field">Empleado
            <select className="select" value={employee} onChange={(e) => setEmployee(e.target.value)} required>
              <option value="">— Selecciona —</option>
              {data.employees.map((e) => <option key={e.code} value={e.code}>{e.name}</option>)}
            </select>
          </label>
          <label className="field">Tipo
            <select className="select" value={type} onChange={(e) => setType(e.target.value)}>
              {AUSENCIA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </label>
          <div className="grid-2">
            <label className="field">Desde<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} required /></label>
            <label className="field">Hasta<input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
          </div>
          <label className="field">Motivo (opcional)<input className="input" value={reason} onChange={(e) => setReason(e.target.value)} /></label>
          <button className="btn primary" disabled={busy}>{busy ? 'Guardando…' : 'Registrar ausencia'}</button>
        </form>
      )}
    </div>
  );
}

function MarcajeModal({ marcaje, onClose, onSaved }: { marcaje: EvalosMarcaje; onClose: () => void; onSaved: () => void }) {
  const [punches, setPunches] = useState<EvalosMarcajePunch[]>(marcaje.punches.length ? marcaje.punches : [{ time: '08:00', type: 'E' }]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const set = (i: number, k: 'time' | 'type', v: string) => setPunches((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));

  async function save() {
    setBusy(true);
    try { await api.put(`/api/evalos/marcajes/${encodeURIComponent(marcaje.id)}`, { punches }); onSaved(); }
    catch (err: any) { toast(err.message, true); setBusy(false); }
  }

  return (
    <Modal title={`Corregir marcajes · ${marcaje.employeeName}`} onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        <span className="xs muted">{fmtDate(marcaje.date)} · marca las entradas (E) y salidas (S). Deben quedar en pares.</span>
        {punches.map((p, i) => (
          <div key={i} className="row" style={{ gap: 8 }}>
            <input className="input" style={{ width: 120 }} type="time" value={p.time} onChange={(e) => set(i, 'time', e.target.value)} />
            <select className="select" style={{ width: 130 }} value={p.type} onChange={(e) => set(i, 'type', e.target.value)}>
              <option value="E">Entrada</option><option value="S">Salida</option>
            </select>
            <button type="button" className="icon-btn" aria-label="Quitar" onClick={() => setPunches((x) => x.filter((_, j) => j !== i))}><Icon.trash /></button>
          </div>
        ))}
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setPunches((x) => [...x, { time: '17:00', type: x.length % 2 === 0 ? 'E' : 'S' }])}><Icon.plus /> Añadir marcaje</button>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Marcajes con conexión real (EvalosRest) ----------
const isoLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** Lunes de la semana en curso. */
const mondayOfWeek = () => { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return isoLocal(d); };
type OrgSel = Partial<Record<EvalosOrgKey, string>>;
const ORG_FIELDS: [EvalosOrgKey, string, string][] = [['company', 'Empresa', 'Todas'], ['department', 'Departamento', 'Todos'], ['section', 'Sección', 'Todas'], ['area', 'Área', 'Todas']];
const qs = (from: string, to: string, employee: string, org: OrgSel = {}) =>
  `/api/evalos/correcciones/marcajes?from=${from}&to=${to}${employee ? `&employee=${encodeURIComponent(employee)}` : ''}${employee ? '' : Object.entries(org).filter(([, v]) => v).map(([k, v]) => `&${k}=${encodeURIComponent(v!)}`).join('')}`;
/** Incidencia normal: 0, 00, 000… según la instalación. */
const isNormalInc = (c: string) => /^0*$/.test(c);
const punchTitle = (p: EvalosRestMarcaje['punches'][number]) =>
  [`${p.seconds} · ${p.type === 'E' ? 'entrada' : 'salida'}`, !isNormalInc(p.incidence) ? `incidencia ${p.incidence}${p.incidenceName ? ` · ${p.incidenceName}` : ''}` : '', p.manual ? 'manual' : p.terminal ? `terminal ${p.terminal}` : '', p.anomaly || ''].filter(Boolean).join('\n');

/** Marcajes y anomalías de Evalos 8 por empleado y día, con alta de marcajes manuales. Mismo diseño que la vista sin conexión. */
/** Texto negro o blanco según la luminosidad del fondo. */
const inkOn = (hex: string) => {
  const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6 ? '#1d1d1f' : '#ffffff';
};
const DAY_KIND = { absence: 'Ausencia', holiday: 'Vacaciones', shift: 'Turno' } as const;
/** Lo que tiene el día (ausencia, vacaciones o turno) con la descripción y el color de Evalos. */
function DayTag({ day }: { day: EvalosDayInfo }) {
  const style = day.color ? { background: day.color, color: inkOn(day.color) } : undefined;
  const cls = day.color ? 'tag' : day.kind === 'absence' ? 'tag warn' : day.kind === 'holiday' ? 'tag info' : 'tag outline';
  return <span className={cls} style={{ ...style, maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }} title={`${DAY_KIND[day.kind]} ${day.code} · ${day.name}`}>{day.name}</span>;
}

type SortKey = 'date' | 'employee' | 'day' | 'punches' | 'status';
/** Comparación ascendente por columna de la tabla de marcajes. */
function compareBy(key: SortKey, a: EvalosRestMarcaje, b: EvalosRestMarcaje): number {
  switch (key) {
    case 'date': return a.date.localeCompare(b.date);
    case 'employee': return a.employeeName.localeCompare(b.employeeName, 'es') || a.employee.localeCompare(b.employee);
    // Por tipo (ausencia, vacaciones, turno) y descripción; los días sin nada, al final.
    case 'day': {
      const rank = (m: EvalosRestMarcaje) => (m.day ? { absence: 0, holiday: 1, shift: 2 }[m.day.kind] : 3);
      return rank(a) - rank(b) || (a.day?.name || '').localeCompare(b.day?.name || '', 'es');
    }
    // Por hora del primer marcaje; los días sin marcajes, al final.
    case 'punches': return (a.punches[0]?.seconds || '99').localeCompare(b.punches[0]?.seconds || '99') || a.punches.length - b.punches.length;
    // Con anomalías primero, luego correctos, luego sin marcajes.
    case 'status': {
      const rank = (m: EvalosRestMarcaje) => (m.status === 'INCIDENCIA' ? 0 : m.punches.length ? 1 : 2);
      return rank(a) - rank(b) || (a.issues[0] || '').localeCompare(b.issues[0] || '', 'es');
    }
  }
}

function MarcajesRest({ employees, lookups, canEdit, canDelete }: { employees: EvalosEmployeeBrief[]; lookups: Partial<Record<EvalosOrgKey, { code: string; description: string }[] | null>>; canEdit: boolean; canDelete: boolean }) {
  // Por defecto: semana en curso (de lunes a hoy) y el primer empleado de la lista, para no cargar a todo el personal.
  const [from, setFrom] = useState(mondayOfWeek);
  const [to, setTo] = useState(() => isoLocal(new Date()));
  const [org, setOrg] = useState<OrgSel>({});
  const inOrg = (e: EvalosEmployeeBrief) => ORG_FIELDS.every(([k]) => !org[k] || (e[k] || '') === org[k]);
  const visible = useMemo(() => employees.filter(inOrg), [employees, org]); // eslint-disable-line react-hooks/exhaustive-deps
  const [employee, setEmployee] = useState(() => employees[0]?.code || '');
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState({ from, to, employee, org });
  const [editM, setEditM] = useState<EvalosRestMarcaje | null>(null);
  const [showReport, setShowReport] = useState(false);
  const orgKey = JSON.stringify(query.org);
  const { data, error, reload } = useData(() => api.get<EvalosRestMarcajesResponse>(qs(query.from, query.to, query.employee, query.org)), [query.from, query.to, query.employee, orgKey]);

  // Al cambiar un filtro de organización, si el empleado elegido ya no está en la lista se pasa al primero que quede.
  const setOrgField = (k: EvalosOrgKey, v: string) => {
    const next = { ...org, [k]: v || undefined };
    setOrg(next);
    const rest = employees.filter((e) => ORG_FIELDS.every(([f]) => !next[f] || (e[f] || '') === next[f]));
    if (employee && !rest.some((e) => e.code === employee)) setEmployee(rest[0]?.code || '');
  };
  const apply = (e?: FormEvent) => {
    e?.preventDefault();
    if (query.from === from && query.to === to && query.employee === employee && orgKey === JSON.stringify(org)) reload();
    else setQuery({ from, to, employee, org });
  };
  const t = q.trim().toLowerCase();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'date', dir: -1 });
  const list = useMemo(() => {
    const rows = (data?.marcajes || []).filter((m) =>
      (!onlyIssues || m.status === 'INCIDENCIA') && (!t || m.employeeName.toLowerCase().includes(t) || m.employee.toLowerCase().includes(t))
    );
    // Orden por la columna elegida; a igualdad, fecha (desc.) y empleado.
    return rows.sort((a, b) => sort.dir * compareBy(sort.key, a, b) || b.date.localeCompare(a.date) || a.employeeName.localeCompare(b.employeeName, 'es'));
  }, [data, onlyIssues, t, sort]);
  const th = (key: SortKey, label: string, extra: { width?: number; title?: string } = {}) => (
    <th style={{ width: extra.width, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} title={extra.title || `Ordenar por ${label.toLowerCase()}`}
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
      onClick={() => setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: key === 'date' ? -1 : 1 }))}>
      {label}<span className="muted" style={{ marginLeft: 4 }}>{sort.key === key ? (sort.dir === 1 ? '▲' : '▼') : '↕'}</span>
    </th>
  );
  const incidencias = (data?.marcajes || []).filter((m) => m.status === 'INCIDENCIA').length;

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected className="on">Marcajes{incidencias ? ` · ${incidencias}` : ''}</button>
        <span className="grow" />
        <button className="btn sm" onClick={() => apply()}><Icon.refresh /> Actualizar</button>
      </div>

      <div className="card flat">
        <form className="ev-toolbar" onSubmit={apply}>
          <label className="field" style={{ margin: 0 }}><span className="xs muted">Desde</span><input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} required /></label>
          <label className="field" style={{ margin: 0 }}><span className="xs muted">Hasta</span><input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} required /></label>
          {ORG_FIELDS.map(([k, label, all]) => {
            const opts = lookups[k];
            // Solo los valores que tienen algún empleado activo; si la tabla no existe, los códigos de los empleados.
            const used = new Set(employees.map((e) => e[k] || '').filter(Boolean));
            const items = opts ? opts.filter((o) => used.has(o.code)) : [...used].sort().map((c) => ({ code: c, description: '' }));
            if (!items.length) return null;
            return (
              <label key={k} className="field" style={{ margin: 0, minWidth: 140, maxWidth: 200 }}><span className="xs muted">{label}</span>
                <select className="select" value={org[k] || ''} onChange={(e) => setOrgField(k, e.target.value)}>
                  <option value="">{all}</option>
                  {items.map((o) => <option key={o.code} value={o.code}>{o.description || o.code}</option>)}
                </select>
              </label>
            );
          })}
          <label className="field" style={{ margin: 0, minWidth: 200 }}><span className="xs muted">Empleado{visible.length !== employees.length ? ` (${visible.length})` : ''}</span>
            <select className="select" value={employee} onChange={(e) => setEmployee(e.target.value)}>
              <option value="">Todos{visible.length !== employees.length ? ' los del filtro' : ''}</option>
              {visible.map((e) => <option key={e.code} value={e.code}>{e.name} · {e.code}</option>)}
            </select>
          </label>
          <button className="btn primary sm" style={{ alignSelf: 'flex-end' }}>Consultar</button>
          <span className="grow" />
          <label className="search" style={{ minWidth: 160, maxWidth: 240, alignSelf: 'flex-end' }}>
            <Icon.search /><input placeholder="Filtrar empleado…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filtrar por empleado" />
          </label>
          <label className="check xs" style={{ alignSelf: 'flex-end', paddingBottom: 8 }}><input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Solo con anomalías</label>
        </form>

        {error && <div style={{ padding: 14 }} className="col"><ErrorBox error={error} />{/API REST/.test(error) && <span className="xs muted">Un superadministrador puede completarla en Administración › Integraciones › Evalos8 › API REST.</span>}</div>}
        {data?.warnings.map((w) => <div key={w} style={{ padding: '10px 14px 0' }}><div className="alert warn small">{w}</div></div>)}
        {!data && !error && <Loading />}
        {data && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr>{th('date', 'Fecha', { width: 110 })}{th('employee', 'Empleado')}{th('day', 'Turno / Ausencia', { width: 190 })}{th('punches', 'Marcajes')}{th('status', 'Estado', { width: 260 })}{canEdit && <th style={{ width: 120 }} />}</tr></thead>
              <tbody>
                {list.map((m) => (
                  <tr key={m.id}>
                    <td className="mono small">{fmtDate(m.date)}</td>
                    <td className="small">{m.employeeName}{m.employeeName !== m.employee && <div className="xs muted mono">{m.employee}</div>}</td>
                    <td>{m.day ? <DayTag day={m.day} /> : <span className="muted small">—</span>}</td>
                    <td className="mono small">
                      {m.punches.length ? m.punches.map((p, i) => (
                        <span key={i} title={punchTitle(p)} style={{ marginRight: 10, whiteSpace: 'nowrap', color: p.anomaly ? 'var(--bad, #c0392b)' : undefined }}>
                          {p.time}{p.type === 'E' ? '↓' : '↑'}{p.manual ? '*' : ''}{!isNormalInc(p.incidence) ? <sup className="xs muted">{p.incidence}</sup> : null}
                        </span>
                      )) : <span className="muted">—</span>}
                    </td>
                    <td>{m.status === 'OK' ? (m.punches.length ? <span className="tag ok">Correcto</span> : <span className="tag outline">Sin marcajes</span>) : (
                      <div className="row wrap" style={{ gap: 4 }}>{(m.issues.length ? m.issues : ['Anomalía']).map((x) => <span key={x} className="tag bad">{x}</span>)}</div>
                    )}</td>
                    {canEdit && <td><button className="btn sm" onClick={() => setEditM(m)}><Icon.edit /> Corregir</button></td>}
                  </tr>
                ))}
                {!list.length && <tr><td colSpan={6} className="muted small" style={{ padding: 28, textAlign: 'center' }}>{data.marcajes.length ? 'Ningún día coincide con el filtro.' : 'No hay marcajes ni anomalías en el periodo.'}</td></tr>}
              </tbody>
            </table>
          </div>
        )}
        {data && (
          <div className="ev-foot xs muted">
            ↓ entrada · ↑ salida · * manual · {data.hiddenUnknown ? `${data.hiddenUnknown} registro(s) de personal que no existe ocultos · ` : ''}{incidencias} día(s) con anomalías · {fmtDate(data.from)} – {fmtDate(data.to)} · Evalos 8 (API REST) · {data.ms} ms
            {data.reportPreview && <> · listado {data.report}: {data.reportPreview.rows} fila(s), {data.reportPreview.anomalies} con anomalías · <button type="button" className="xs" style={{ background: 'none', border: 0, padding: 0, color: 'inherit', textDecoration: 'underline', cursor: 'pointer' }} onClick={() => setShowReport((v) => !v)}>{showReport ? 'Ocultar respuesta' : 'Ver respuesta'}</button></>}
          </div>
        )}
        {data?.reportPreview && showReport && (
          <div style={{ padding: 14 }} className="col">
            <span className="xs muted">Columnas leídas: {data.reportPreview.columns.length ? data.reportPreview.columns.join(' · ') : '(ninguna)'}</span>
            <pre className="code" style={{ maxHeight: 360, overflow: 'auto', margin: 0 }}>{data.reportPreview.sample || '(respuesta vacía)'}</pre>
            {data.calendarPreview && (
              <>
                <span className="xs muted">Calendario: {data.calendarPreview.rows} fila(s), {data.calendarPreview.days} día(s) leídos (fechas {data.calendarPreview.dateFormat}) · columnas: {data.calendarPreview.columns.length ? data.calendarPreview.columns.join(' · ') : '(ninguna)'}</span>
                <pre className="code" style={{ maxHeight: 300, overflow: 'auto', margin: 0 }}>{data.calendarPreview.sample || '(respuesta vacía)'}</pre>
              </>
            )}
          </div>
        )}
      </div>

      {editM && <MarcajeRestModal marcaje={editM} canDelete={canDelete} onClose={() => setEditM(null)} onSaved={() => { setEditM(null); reload(); }} />}
    </div>
  );
}

/** Incidencia de los marcajes normales: no está en la tabla INCIDENC y va siempre la primera. */
const NORMAL_INC: EvalosIncidencia = { code: '000', name: 'Entrada / Salida' };
let incidenciasCache: Promise<EvalosIncidencia[]> | null = null;
let vacacionesCache: Promise<EvalosIncidencia[]> | null = null;
/** Tipos de vacaciones (TIPOSVACACIONES). */
const loadTiposVacaciones = () => (vacacionesCache ||= api.get<{ items: EvalosIncidencia[] }>('/api/evalos/correcciones/tiposvacaciones').then((r) => r.items).catch((e) => { vacacionesCache = null; throw e; }));
let ausenciasCache: Promise<EvalosIncidencia[]> | null = null;
/** Incidencias de tipo A (absentismos) de INCIDENC, para asignar ausencias. */
const loadIncidenciasAusencia = () => (ausenciasCache ||= api.get<{ items: EvalosIncidencia[] }>('/api/evalos/correcciones/incidencias?tipo=A').then((r) => r.items).catch((e) => { ausenciasCache = null; throw e; }));
const loadIncidencias = () => (incidenciasCache ||= api.get<{ items: EvalosIncidencia[] }>('/api/evalos/correcciones/incidencias').then((r) => r.items).catch((e) => { incidenciasCache = null; throw e; }));

interface EditRow { time: string; incidence: string; original?: string; origTime?: string; origInc?: string; ref?: EvalosBookingRef; manual?: boolean; type?: 'E' | 'S'; terminal?: string; anomaly?: string; incidenceName?: string; remove?: boolean }

/**
 * Corregir un día. Los marcajes que ya están en Evalos se pueden:
 *  - cambiar de incidencia (todos) → POST /Booking/attendance con el mismo marcaje;
 *  - cambiar de hora (solo los manuales, como en Evalos) → se borra el original y se graba el nuevo;
 *  - eliminar (administradores del módulo) → DELETE /Booking/attendance.
 * Y se pueden añadir marcajes manuales (POST).
 */
function MarcajeRestModal({ marcaje, canDelete, onClose, onSaved }: { marcaje: EvalosRestMarcaje; canDelete: boolean; onClose: () => void; onSaved: () => void }) {
  const [rows, setRows] = useState<EditRow[]>(() => [
    ...marcaje.punches.map((p) => ({ time: p.time, incidence: p.incidence, original: p.seconds, origTime: p.time, origInc: p.incidence, ref: p.ref, manual: p.manual, type: p.type, terminal: p.terminal, anomaly: p.anomaly, incidenceName: p.incidenceName })),
    ...(marcaje.punches.length ? [] : [{ time: '08:00', incidence: NORMAL_INC.code }])
  ]);
  const [incs, setIncs] = useState<EvalosIncidencia[]>([NORMAL_INC]);
  const [incErr, setIncErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { loadIncidencias().then(setIncs, (e) => setIncErr(e.message)); }, []);
  const set = (i: number, k: 'time' | 'incidence', v: string) => setRows((r) => r.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const isMod = (r: EditRow) => !!r.original && !r.remove && (r.time !== r.origTime || r.incidence !== r.origInc);

  // Qué se envía a Evalos: borrados (eliminados y cambios de hora) y grabaciones (nuevos, cambios de hora e incidencia).
  const removed = rows.filter((r) => r.original && r.remove);
  const moved = rows.filter((r) => isMod(r) && r.time !== r.origTime);
  const retyped = rows.filter((r) => isMod(r) && r.time === r.origTime);
  const added = rows.filter((r) => !r.original);
  const toDelete = [...removed, ...moved].map((r) => r.original!);
  const toPost = [
    ...retyped.map((r) => ({ time: r.time, incidence: r.incidence, original: r.original, ref: r.ref })),
    ...[...moved, ...added].map((r) => ({ time: r.time, incidence: r.incidence }))
  ];
  const nChanges = removed.length + moved.length + retyped.length + added.length;

  async function save() {
    if (!nChanges) return toast('No hay cambios que guardar', true);
    if (removed.length && !window.confirm(`¿Eliminar ${removed.length === 1 ? `el marcaje de las ${removed[0].origTime}` : `${removed.length} marcajes`} de ${marcaje.employeeName} del ${fmtDate(marcaje.date)} en Evalos? No se puede deshacer.`)) return;
    setBusy(true);
    try {
      if (toDelete.length) await api.del('/api/evalos/correcciones/marcajes', { employee: marcaje.employee, date: marcaje.date, times: toDelete });
      if (toPost.length) await api.post('/api/evalos/correcciones/marcajes', { employee: marcaje.employee, date: marcaje.date, punches: toPost });
      toast([
        removed.length ? `${removed.length} eliminado(s)` : '',
        moved.length + retyped.length ? `${moved.length + retyped.length} modificado(s)` : '',
        added.length ? `${added.length} añadido(s)` : ''
      ].filter(Boolean).join(' · ') + ' en Evalos');
      onSaved();
    } catch (err: any) { toast(err.message, true); setBusy(false); }
  }

  // Combo de incidencias (tabla INCIDENC): se ve la descripción y se guarda el código.
  const incSelect = (r: EditRow, i: number) => (
    <select className="select grow" value={r.incidence} onChange={(e) => set(i, 'incidence', e.target.value)} aria-label="Incidencia" title={`Incidencia ${r.incidence}`} disabled={r.remove}>
      {/* 0, 00… también son «Entrada / Salida»: se muestra igual y se conserva el código que trae el marcaje. */}
      {!incs.some((x) => x.code === r.incidence) && <option value={r.incidence}>{isNormalInc(r.incidence) ? NORMAL_INC.name : r.incidenceName || r.incidence}</option>}
      {incs.map((x) => <option key={x.code} value={x.code}>{x.name || x.code}</option>)}
    </select>
  );
  const undo = (i: number) => setRows((x) => x.map((y, j) => (j === i ? { ...y, time: y.origTime!, incidence: y.origInc!, remove: false } : y)));

  return (
    <Modal title={`Corregir marcajes · ${marcaje.employeeName}`} onClose={onClose}>
      <div className="col" style={{ gap: 12 }}>
        <span className="xs muted">{fmtDate(marcaje.date)} · cambia la incidencia de cualquier marcaje y la hora de los manuales (la de los marcajes de terminal no se puede cambiar){canDelete ? ', elimina marcajes' : ''} o añade marcajes manuales.</span>
        {marcaje.issues.length > 0 && <div className="row wrap" style={{ gap: 4 }}>{marcaje.issues.map((x) => <span key={x} className="tag bad">{x}</span>)}</div>}
        {incErr && <div className="alert warn xs">No se pudo leer la lista de incidencias (INCIDENC): {incErr}</div>}
        {rows.map((r, i) => {
          const mod = isMod(r);
          // Cambiar la hora de un manual supone borrarlo y grabarlo de nuevo: requiere poder eliminar.
          const timeLocked = !!r.original && (!r.manual || !canDelete || !!r.remove);
          return (
            <div key={i} className="row" style={{ gap: 8, alignItems: 'center', opacity: r.remove ? 0.55 : 1 }}>
              <input className="input" style={{ width: 120, textDecoration: r.remove ? 'line-through' : undefined }} type="time" value={r.time} onChange={(e) => set(i, 'time', e.target.value)} required
                disabled={timeLocked} title={r.original && !r.manual ? 'La hora de un marcaje de terminal no se puede cambiar' : undefined} aria-label="Hora" />
              {incSelect(r, i)}
              <span className="xs muted" style={{ width: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.anomaly || r.terminal || ''}>
                {!r.original ? <span className="tag info">Nuevo</span> : r.remove ? <span className="tag bad">Se eliminará</span> : mod ? <span className="tag warn">Modificado</span> : r.manual ? 'Manual' : r.terminal || 'Terminal'}
              </span>
              {!r.original
                ? <button type="button" className="icon-btn" aria-label="Quitar" title="Quitar" onClick={() => setRows((x) => x.filter((_, j) => j !== i))}><Icon.trash /></button>
                : (
                  <div className="row" style={{ gap: 2 }}>
                    <button type="button" className="icon-btn" aria-label="Deshacer cambios" title="Deshacer cambios" disabled={!mod && !r.remove} onClick={() => undo(i)}><Icon.refresh /></button>
                    {canDelete && <button type="button" className="icon-btn" aria-label="Eliminar marcaje" title="Eliminar marcaje en Evalos" disabled={r.remove} onClick={() => setRows((x) => x.map((y, j) => (j === i ? { ...y, time: y.origTime!, incidence: y.origInc!, remove: true } : y)))}><Icon.trash /></button>}
                  </div>
                )}
            </div>
          );
        })}
        {!rows.length && <span className="muted small">Sin marcajes este día.</span>}
        <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={() => setRows((x) => [...x, { time: '17:00', incidence: NORMAL_INC.code }])}><Icon.plus /> Añadir marcaje</button>
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <button type="button" className="btn" onClick={onClose}>Cancelar</button>
          <button className="btn primary" disabled={busy || !nChanges} onClick={save}>{busy ? 'Guardando…' : nChanges ? `Guardar en Evalos (${nChanges})` : 'Guardar en Evalos'}</button>
        </div>
        <AusenciaDia marcaje={marcaje} onSaved={onSaved} />
        <VacacionesDia marcaje={marcaje} onSaved={onSaved} />
      </div>
    </Modal>
  );
}

/**
 * Ausencia del día seleccionado. El combo muestra la ausencia que ya tiene (calendario de Evalos);
 * se puede cambiar (PUT /Absence con desde = hasta = ese día) o quitar eligiendo «Sin ausencia» (DELETE /Absence).
 */
function AusenciaDia({ marcaje, onSaved }: { marcaje: EvalosRestMarcaje; onSaved: () => void }) {
  const current = marcaje.absence || '';
  const [list, setList] = useState<EvalosIncidencia[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [inc, setInc] = useState(current);
  const [desc, setDesc] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { loadIncidenciasAusencia().then(setList, (e) => setErr(e.message)); }, []);
  const nameOf = (code: string) => list?.find((x) => x.code === code)?.name || code;
  const changed = inc !== current;

  async function apply() {
    if (!changed) return;
    setBusy(true);
    try {
      if (!inc) {
        await api.del('/api/evalos/correcciones/ausencias', { employee: marcaje.employee, date: marcaje.date });
        toast(`Ausencia «${nameOf(current)}» quitada del ${fmtDate(marcaje.date)}`);
      } else {
        await api.post('/api/evalos/correcciones/ausencias', { employee: marcaje.employee, date: marcaje.date, incidence: inc, description: desc.trim() || nameOf(inc) });
        toast(`Ausencia «${nameOf(inc)}» asignada el ${fmtDate(marcaje.date)}`);
      }
      onSaved();
    } catch (e: any) { toast(e.message, true); setBusy(false); }
  }

  return (
    <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
      <b className="small">Ausencia · {fmtDate(marcaje.date)}</b>
      {err && <div className="alert warn xs">No se pudo leer las incidencias de ausencia (INCIDENC, tipo A): {err}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="select grow" style={{ minWidth: 180 }} value={inc} onChange={(e) => setInc(e.target.value)} disabled={!list && !current} aria-label="Ausencia del día">
          <option value="">{list || current ? '— Sin ausencia —' : 'Cargando…'}</option>
          {current && !list?.some((x) => x.code === current) && <option value={current}>{current}</option>}
          {list?.map((x) => <option key={x.code} value={x.code}>{x.name || x.code}</option>)}
        </select>
        {inc && changed && <input className="input grow" style={{ minWidth: 160 }} value={desc} maxLength={40} onChange={(e) => setDesc(e.target.value)} placeholder="Descripción (opcional)" aria-label="Descripción de la ausencia" />}
        <button type="button" className={`btn${changed && !inc ? ' danger' : ''}`} disabled={busy || !changed} onClick={apply}>
          {busy ? 'Guardando…' : !changed ? (current ? 'Ausencia asignada' : 'Asignar ausencia') : inc ? (current ? 'Cambiar ausencia' : 'Asignar ausencia') : 'Quitar ausencia'}
        </button>
      </div>
    </div>
  );
}

/**
 * Vacaciones del día seleccionado, como la ausencia: el combo muestra el tipo que ya tiene; se asigna o cambia
 * (SOAP AsignarDiaVacaciones) o se quita eligiendo «Sin vacaciones» (SOAP BorrarVacaciones).
 */
function VacacionesDia({ marcaje, onSaved }: { marcaje: EvalosRestMarcaje; onSaved: () => void }) {
  const current = marcaje.holiday || '';
  const [list, setList] = useState<EvalosIncidencia[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [type, setType] = useState(current);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  useEffect(() => { loadTiposVacaciones().then(setList, (e) => setErr(e.message)); }, []);
  const nameOf = (code: string) => list?.find((x) => x.code === code)?.name || code;
  const changed = type !== current;

  async function apply() {
    if (!changed) return;
    setBusy(true);
    try {
      if (!type) {
        await api.del('/api/evalos/correcciones/vacaciones', { employee: marcaje.employee, date: marcaje.date });
        toast(`Vacaciones quitadas del ${fmtDate(marcaje.date)}`);
      } else {
        await api.post('/api/evalos/correcciones/vacaciones', { employee: marcaje.employee, date: marcaje.date, type, replace: !!current });
        toast(`Vacaciones «${nameOf(type)}» asignadas el ${fmtDate(marcaje.date)}`);
      }
      onSaved();
    } catch (e: any) { toast(e.message, true); setBusy(false); }
  }

  return (
    <div className="col" style={{ gap: 8, borderTop: '1px solid var(--line-2)', paddingTop: 12 }}>
      <b className="small">Vacaciones · {fmtDate(marcaje.date)}</b>
      {err && <div className="alert warn xs">No se pudo leer los tipos de vacaciones (TIPOSVACACIONES): {err}</div>}
      <div className="row wrap" style={{ gap: 8 }}>
        <select className="select grow" style={{ minWidth: 180 }} value={type} onChange={(e) => setType(e.target.value)} disabled={!list && !current} aria-label="Vacaciones del día">
          <option value="">{list || current ? '— Sin vacaciones —' : 'Cargando…'}</option>
          {current && !list?.some((x) => x.code === current) && <option value={current}>{current}</option>}
          {list?.map((x) => <option key={x.code} value={x.code}>{x.name || x.code}</option>)}
        </select>
        <button type="button" className={`btn${changed && !type ? ' danger' : ''}`} disabled={busy || !changed} onClick={apply}>
          {busy ? 'Guardando…' : !changed ? (current ? 'Vacaciones asignadas' : 'Asignar vacaciones') : type ? (current ? 'Cambiar vacaciones' : 'Asignar vacaciones') : 'Quitar vacaciones'}
        </button>
      </div>
    </div>
  );
}

function CorreccionesRestWidget() {
  const { data, error } = useData(() => api.get<EvalosRestMarcajesResponse>(qs(mondayOfWeek(), isoLocal(new Date()), '')));
  if (error) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const incidencias = data.marcajes.filter((m) => m.status === 'INCIDENCIA').length;
  return (
    <div className="row" style={{ gap: 10 }}>
      <div className="card grow" style={{ gap: 2, padding: '12px 14px' }}><span className="xs muted" style={{ fontWeight: 600 }}>Días con anomalías (esta semana)</span><span className="stat">{incidencias}</span></div>
      <div className="card grow" style={{ gap: 2, padding: '12px 14px' }}><span className="xs muted" style={{ fontWeight: 600 }}>Días con marcajes</span><span className="stat">{data.marcajes.filter((m) => m.punches.length).length}</span></div>
    </div>
  );
}

// ---------- Widget ----------
export function CorreccionesWidget() {
  const { data, error } = useCorrecciones();
  if (error) return error;
  if (!data) return <Loading />;
  if (data.mode === 'rest') return <CorreccionesRestWidget />;
  const incidencias = data.marcajes.filter((m) => m.status === 'INCIDENCIA').length;
  const pendientes = data.solicitudes.filter((s) => s.status === 'PENDIENTE').length;
  return (
    <div className="row" style={{ gap: 10 }}>
      <div className="card grow" style={{ gap: 2, padding: '12px 14px' }}><span className="xs muted" style={{ fontWeight: 600 }}>Marcajes con incidencia</span><span className="stat">{incidencias}</span></div>
      <div className="card grow" style={{ gap: 2, padding: '12px 14px' }}><span className="xs muted" style={{ fontWeight: 600 }}>Solicitudes pendientes</span><span className="stat">{pendientes}</span></div>
    </div>
  );
}
