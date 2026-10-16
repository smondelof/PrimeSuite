// Atajos de Evalos · Convenios.
// Cada convenio predefine tantos periodos de vacaciones como se quiera (tipo de TIPOSVACACIONES, inicio y días), y los límites de
// incidencia (por incidencia de INCIDENC, en días u horas) de su periodo de incidencias. Los periodos duran un año
// desde su día/mes de inicio. Desde la ventana también se pueden crear tipos de vacaciones nuevos en TIPOSVACACIONES.
// Se guarda en PS_CONVENIOS, PS_CONVENIOS_VACACIONES y PS_CONVENIOS_LIMITES (BD de Evalos 8).
// El mismo archivo exporta el widget del Inicio.
import { Fragment, useEffect, useMemo, useState, type FormEvent, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  api, ApiError, type EvalosConvenio, type EvalosConvenioPeopleResponse, type EvalosConvenioPerson, type EvalosConveniosResponse, type EvalosOrgKind, type EvalosIncidence,
  type EvalosPeriodSync, type EvalosVacationType, type EvalosVacationTypeCreated, type EvalosVacationTypesInfo
} from '../../api';
import { ErrorBox, Icon, Loading, Modal, confirmAction, useData, useToast } from '../../components/ui';
import { NotConfigured } from './common';

const NC = { notConfigured: true } as unknown as EvalosConveniosResponse;
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
/** Febrero con 28 días: un periodo no puede empezar el 29/02, que no existe todos los años. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const TYPE_LABEL: Record<string, string> = { A: 'Absentismo', S: 'Salida en el día' };
/** Horas por día con las que se pasaron a horas los límites guardados en días. */
const HOURS_PER_DAY = 8;

const pad = (n: number) => String(n).padStart(2, '0');
const dm = (d: number, m: number) => `${pad(d)}/${pad(m)}`;
const fmt = (iso: string) => iso.split('-').reverse().join('/');
const fmtDays = (n: number) => n.toLocaleString('es-ES', { maximumFractionDigits: 1 });
const fmtHours = (min: number) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const fmtLimit = (unit: 'D' | 'H', value: number) => (unit === 'D' ? `${fmtDays(value)} ${value === 1 ? 'día' : 'días'}` : `${fmtHours(value)} h`);

function todayIso() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** Fin de un periodo: día/mes, del mismo año del inicio o del siguiente. */
interface End { endDay: number; endMonth: number; endNextYear: boolean }
/** Fin por defecto: el día anterior al inicio, del año siguiente (31/12 del mismo año si empieza el 01/01). Igual que en el servidor. */
function defaultEnd(day: number, month: number): End {
  const prev = new Date(Date.UTC(2001, month - 1, day - 1));
  return { endDay: prev.getUTCDate(), endMonth: prev.getUTCMonth() + 1, endNextYear: !(day === 1 && month === 1) };
}
const sameEnd = (a: End, b: End) => a.endDay === b.endDay && a.endMonth === b.endMonth && a.endNextYear === b.endNextYear;
const endOf = (x: Partial<End>, day: number, month: number): End => (x.endDay && x.endMonth ? { endDay: x.endDay, endMonth: x.endMonth, endNextYear: !!x.endNextYear } : defaultEnd(day, month));
/** Error del fin (mismo año y no posterior al inicio), o ''. */
const endError = (day: number, month: number, e: End) => (!e.endNextYear && e.endMonth * 100 + e.endDay <= month * 100 + day ? 'El fin es anterior al inicio: márcalo «del año siguiente»' : '');
/** Periodo en curso hoy (como server/evalos/convperiods.ts): el último que ha empezado; si ya acabó, el siguiente. */
function currentPeriod(day: number, month: number, e: End) {
  const [y, m, d] = todayIso().split('-').map(Number);
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  const of = (sy: number) => ({ from: iso(new Date(Date.UTC(sy, month - 1, day))), to: iso(new Date(Date.UTC(sy + (e.endNextYear ? 1 : 0), e.endMonth - 1, e.endDay))) });
  const start = m > month || (m === month && d >= day) ? y : y - 1;
  const p = of(start);
  return p.to < todayIso() ? of(start + 1) : p;
}
const periodText = (day: number, month: number, e: End) => { const p = currentPeriod(day, month, e); return `del ${fmt(p.from)} al ${fmt(p.to)}`; };
/** «01/01 – 31/01 del año siguiente» */
const rangeText = (day: number, month: number, e: End) => `${dm(day, month)} – ${dm(e.endDay, e.endMonth)}${e.endNextYear ? ' del año siguiente' : ''}`;

/** «12», «12,5» → número; '' o texto no válido → NaN. */
const parseDays = (s: string) => (/^\d{1,3}([.,]\d)?$/.test(s.trim()) ? Number(s.trim().replace(',', '.')) : NaN);
/** «8», «8:30», «120:00» → minutos; texto no válido → NaN. */
function parseHours(s: string) {
  const m = /^(\d{1,4})(?::([0-5]\d))?$/.exec(s.trim());
  return m ? Number(m[1]) * 60 + Number(m[2] || 0) : NaN;
}

function useConvenios() {
  const { data, error, reload } = useData(() =>
    api.get<EvalosConveniosResponse>('/api/evalos/convenios').catch((e) => {
      if (e instanceof ApiError && e.code === 'not_configured') return NC;
      throw e;
    })
  );
  let node: JSX.Element | null = null;
  if (data === NC) node = <NotConfigured />;
  else if (error) node = <div className="col" style={{ gap: 8 }}><ErrorBox error={error} /><button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={reload}><Icon.refresh /> Reintentar</button></div>;
  return { data: data === NC ? null : data, error: node, reload };
}

export default function Convenios() {
  const { data, error, reload } = useConvenios();
  const [q, setQ] = useState('');
  const [edit, setEdit] = useState<EvalosConvenio | 'new' | null>(null);
  const [params, setParams] = useSearchParams();
  // Deep-link desde el widget del Inicio: ?new=1 crea uno, ?code=XX abre ese convenio.
  useEffect(() => {
    if (!data || data.missing) return;
    if (params.get('new') === '1') { setEdit('new'); setParams({}, { replace: true }); }
    else {
      const code = params.get('code');
      if (code) { const c = data.convenios.find((x) => x.code === code); if (c) setEdit(c); setParams({}, { replace: true }); }
    }
  }, [data, params, setParams]);
  const incName = useMemo(() => new Map((data?.incidences || []).map((i) => [i.code, i.name])), [data]);
  const vacType = useMemo(() => new Map((data?.vacationTypes.items || []).map((t) => [t.code, t])), [data]);
  if (error) return error;
  if (!data) return <Loading />;
  if (data.missing) return <MissingTables missing={data.missing} onRetry={reload} />;

  const needle = q.trim().toLowerCase();
  const list = needle ? data.convenios.filter((c) => c.code.toLowerCase().includes(needle) || c.name.toLowerCase().includes(needle)) : data.convenios;

  return (
    <div className="col" style={{ gap: 16 }}>
      {data.incidencesError && <div className="alert warn">No se pudieron leer las incidencias de INCIDENC: {data.incidencesError}</div>}
      {data.vacationTypesError && <div className="alert warn">No se pudieron leer los tipos de vacaciones de TIPOSVACACIONES: {data.vacationTypesError}</div>}
      <div className="card flat">
        <div className="ev-toolbar">
          <b className="small">{data.convenios.length} convenio(s)</b>
          {data.engine === 'demo' && <span className="tag outline">Datos de demostración</span>}
          <span className="grow" />
          <input className="input" style={{ width: 220 }} placeholder="Buscar por código o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="btn sm" onClick={reload}><Icon.refresh /> Actualizar</button>
          {data.canEdit && <button className="btn primary sm" onClick={() => setEdit('new')}><Icon.plus /> Nuevo convenio</button>}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 110 }}>Código</th>
                <th>Nombre</th>
                <th>Vacaciones</th>
                <th style={{ width: 170 }}>Periodo de incidencias</th>
                <th>Límites de incidencia</th>
                <th style={{ textAlign: 'right' }}>Personas</th>
                <th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {list.map((c) => (
                <tr key={c.code} className="clickable" onClick={() => setEdit(c)}>
                  <td className="mono"><b>{c.code}</b></td>
                  <td>{c.name}</td>
                  <td>
                    {c.vacations.length ? (
                      <div className="col" style={{ gap: 3 }}>
                        {c.vacations.map((v, i) => (
                          <span key={i} className="small row" style={{ gap: 6 }} title={vacType.get(v.type)?.name || v.type}>
                            <TypeDot color={vacType.get(v.type)?.color} />
                            <b className="mono">{v.type}</b> {v.unit === 'H' ? `${fmtLimit('H', v.minutes || 0)} (1 día = ${fmtHours(v.minutesPerDay || HOURS_PER_DAY * 60)} h)` : fmtLimit('D', v.days)} <span className="xs muted">{rangeText(v.day, v.month, endOf(v, v.day, v.month))}</span>
                          </span>
                        ))}
                      </div>
                    ) : <span className="muted small">Sin vacaciones</span>}
                  </td>
                  <td className="small">{rangeText(c.incidenceDay, c.incidenceMonth, endOf({ endDay: c.incidenceEndDay, endMonth: c.incidenceEndMonth, endNextYear: c.incidenceEndNextYear }, c.incidenceDay, c.incidenceMonth))}</td>
                  <td>
                    {c.limits.length ? (
                      <div className="row wrap" style={{ gap: 4 }}>
                        {c.limits.slice(0, 4).map((l) => (
                          <span key={l.incidence} className="tag" title={incName.get(l.incidence) || l.incidence}>{l.incidence} · {fmtLimit('H', l.value)}</span>
                        ))}
                        {c.limits.length > 4 && <span className="tag outline">+{c.limits.length - 4}</span>}
                      </div>
                    ) : <span className="muted small">Sin límites</span>}
                  </td>
                  <td style={{ textAlign: 'right' }} title={`${c.active ?? 0} en alta · ${(c.employees ?? 0) - (c.active ?? 0)} de baja`}>
                    <b className="small">{c.employees ?? 0}</b>
                    {(c.employees ?? 0) > (c.active ?? 0) && <div className="xs muted">{(c.employees ?? 0) - (c.active ?? 0)} de baja</div>}
                  </td>
                  <td className="muted">{data.canEdit ? <Icon.edit /> : <Icon.eye />}</td>
                </tr>
              ))}
              {!list.length && (
                <tr><td colSpan={7} className="muted small" style={{ padding: 28, textAlign: 'center' }}>
                  {needle ? 'Ningún convenio coincide con la búsqueda.' : 'No hay convenios. Crea el primero con «Nuevo convenio».'}
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="ev-foot xs muted">
          Cada periodo, de vacaciones o de incidencias, dura un año desde su día y mes de inicio. Los límites se aplican a cada periodo de incidencias.
        </div>
      </div>

      {edit && (
        <ConvenioModal
          convenio={edit === 'new' ? null : edit}
          incidences={data.incidences}
          vacationTypes={data.vacationTypes}
          linkable={data.linkable}
          convenioNames={new Map(data.convenios.map((c) => [c.code, c.name]))}
          onTypeCreated={reload}
          canEdit={data.canEdit}
          canDelete={data.canDelete}
          onClose={() => setEdit(null)}
          onChanged={() => { setEdit(null); reload(); }}
        />
      )}
    </div>
  );
}

// ---------- Faltan las tablas en la BD de Evalos ----------
function MissingTables({ missing, onRetry }: { missing: { message: string; script: string }; onRetry: () => void }) {
  const toast = useToast();
  async function copy() {
    try { await navigator.clipboard.writeText(missing.script); toast('Script copiado'); }
    catch { toast('No se pudo copiar: selecciona el texto y cópialo a mano', true); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([missing.script], { type: 'text/plain;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: 'PS_CONVENIOS.sql' });
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="card col" style={{ gap: 12 }}>
      <h3 style={{ margin: 0 }}>No se ha podido preparar la base de datos</h3>
      <div className="alert warn">{missing.message}</div>
      <span className="small muted">
        Prime Suite crea solo en la base de datos de Evalos 8 las tablas y columnas que necesita, pero esta vez no ha podido
        (normalmente, porque el usuario de la conexión no tiene permiso para crear tablas). Dale ese permiso y pulsa «Comprobar de nuevo».
      </span>
      <details>
        <summary className="small muted" style={{ cursor: 'pointer' }}>Si prefieres crearlo a mano: ver el script de SQL Server</summary>
        <pre className="code" style={{ maxHeight: 340, marginTop: 8 }}>{missing.script}</pre>
        <div className="row wrap" style={{ gap: 8 }}>
          <button className="btn sm" onClick={copy}><Icon.copy /> Copiar script</button>
          <button className="btn sm" onClick={download}><Icon.down /> Descargar .sql</button>
        </div>
      </details>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="grow" />
        <button className="btn primary sm" onClick={onRetry}><Icon.refresh /> Comprobar de nuevo</button>
      </div>
    </div>
  );
}

// ---------- Fin del periodo: día, mes y año (mismo / siguiente) ----------
function EndPicker({ end, onChange, disabled, label }: { end: End; onChange: (e: End) => void; disabled?: boolean; label: string }) {
  return (
    <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
      <DayMonth label={label} day={end.endDay} month={end.endMonth} disabled={disabled} onChange={(endDay, endMonth) => onChange({ ...end, endDay, endMonth })} />
      <select className="select" style={{ width: 148, flex: 'none' }} title="Año del fin respecto al inicio" aria-label={`${label}: año`} value={end.endNextYear ? '1' : '0'} disabled={disabled}
        onChange={(e) => onChange({ ...end, endNextYear: e.target.value === '1' })}>
        <option value="0">mismo año</option>
        <option value="1">año siguiente</option>
      </select>
    </div>
  );
}

// ---------- Selector de día y mes ----------
function DayMonth({ day, month, onChange, disabled, label }: { day: number; month: number; onChange: (d: number, m: number) => void; disabled?: boolean; label: string }) {
  const max = MONTH_DAYS[month - 1];
  return (
    <div className="row" style={{ gap: 6 }} role="group" aria-label={label}>
      <select className="select" style={{ width: 72, flex: 'none' }} aria-label="Día" value={day} disabled={disabled} onChange={(e) => onChange(Number(e.target.value), month)}>
        {Array.from({ length: max }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{pad(d)}</option>)}
      </select>
      <select className="select" style={{ width: 132, flex: 'none' }} aria-label="Mes" value={month} disabled={disabled} onChange={(e) => { const m = Number(e.target.value); onChange(Math.min(day, MONTH_DAYS[m - 1]), m); }}>
        {MONTHS.map((n, i) => <option key={n} value={i + 1}>{n}</option>)}
      </select>
    </div>
  );
}

/** Punto con el color del tipo de vacaciones (si la tabla lo tiene). */
function TypeDot({ color }: { color?: string | null }) {
  return <span aria-hidden style={{ width: 10, height: 10, borderRadius: 999, flex: 'none', background: color || 'var(--line)', border: '1px solid rgba(0,0,0,.12)' }} />;
}

// ---------- Alta de un tipo de vacaciones (TIPOSVACACIONES) ----------
function NewVacationType({ info, onCreated, onCancel }: { info: EvalosVacationTypesInfo; onCreated: (t: EvalosVacationType) => void; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2e7d32');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<EvalosVacationTypeCreated | null>(null);
  const toast = useToast();
  async function create() {
    if (!code.trim() || !name.trim()) { toast('Indica el código y la descripción', true); return; }
    setBusy(true);
    try {
      const r = await api.post<EvalosVacationTypeCreated>('/api/evalos/tiposvacaciones', { code: code.trim(), name: name.trim(), color: info.hasColor ? color : undefined });
      setRes(r);
      toast(`Tipo de vacaciones ${r.type.code} creado en TIPOSVACACIONES`);
      onCreated(r.type);
      setCode(''); setName('');
    } catch (err: any) { toast(err.message, true); }
    finally { setBusy(false); }
  }
  return (
    <div className="card col" style={{ gap: 10 }}>
      <b className="small">Nuevo tipo de vacaciones</b>
      <span className="xs muted">Se crea en la tabla TIPOSVACACIONES de Evalos 8 y queda disponible para todos los convenios y para Evalos.</span>
      <div className="row wrap" style={{ gap: 10, alignItems: 'flex-end' }}>
        <label className="field" style={{ width: 120 }}>Código
          <input className="input mono" value={code} maxLength={info.codeMax} inputMode={info.numericCode ? 'numeric' : 'text'}
            onChange={(e) => setCode(info.numericCode ? e.target.value.replace(/\D/g, '') : e.target.value.toUpperCase())} placeholder={info.numericCode ? '27' : 'V27'} />
        </label>
        <label className="field grow" style={{ minWidth: 200 }}>Descripción
          <input className="input" value={name} maxLength={info.nameMax || 60} onChange={(e) => setName(e.target.value)} placeholder="Vacaciones 2027" />
        </label>
        {info.hasColor && (
          <label className="field" style={{ width: 70 }}>Color
            <input className="input" type="color" value={color} onChange={(e) => setColor(e.target.value)} style={{ padding: 2, height: 38 }} />
          </label>
        )}
        <button type="button" className="btn primary sm" onClick={create} disabled={busy}>{busy ? 'Creando…' : 'Crear tipo'}</button>
        <button type="button" className="btn sm" onClick={onCancel}>Cerrar</button>
      </div>
      {res && (
        <details className="xs">
          <summary className="muted" style={{ cursor: 'pointer' }}>Ver respuesta (fila creada en TIPOSVACACIONES)</summary>
          {res.filled.length > 0 && <div className="muted" style={{ margin: '6px 0' }}>Columnas obligatorias rellenadas con un valor vacío: {res.filled.join(', ')}</div>}
          <pre className="code" style={{ marginTop: 6, maxHeight: 220 }}>{JSON.stringify(res.row, null, 2)}</pre>
        </details>
      )}
    </div>
  );
}

// ---------- Ventana del convenio ----------
/** Plus por antigüedad en edición: años y valor como texto (días con decimales o HH:MM). */
interface PlusRow { key: number; years: string; text: string }
/** Límite de incidencia en edición: siempre en horas (HH:MM). fromDays = venía guardado en días. */
interface LimitRow { key: number; incidence: string; text: string; pluses: PlusRow[]; fromDays?: number }
/** Periodo de vacaciones en edición: en días (texto con decimales) o en horas (HH:MM). */
/** dayText: en horas, lo que vale un día de vacaciones (HH:MM, MINUTOSDIA en VACACIONES). */
interface VacRow extends End { key: number; type: string; day: number; month: number; unit: 'D' | 'H'; text: string; dayText: string; pluses: PlusRow[] }
/** Pasa el valor de un periodo o plus a la otra unidad (con las horas de un día indicadas); vacío si no se puede leer. */
function convertText(text: string, from: 'D' | 'H', to: 'D' | 'H', dayMin = HOURS_PER_DAY * 60) {
  if (from === to || !text.trim()) return text;
  if (to === 'H') { const d = parseDays(text); return d > 0 ? fmtHours(Math.round(d * dayMin)) : ''; }
  const m = parseHours(text);
  return m > 0 ? fmtDays(Math.max(0.5, Math.round((m / dayMin) * 2) / 2)) : '';
}
const DEFAULT_DAY_TEXT = fmtHours(HOURS_PER_DAY * 60);
/** Minutos de un día de vacaciones de un periodo en horas (8 h si no se puede leer). */
const dayMinutes = (r: VacRow) => parseHours(r.dayText) || HOURS_PER_DAY * 60;
const toPlusRows = (unit: 'D' | 'H', list?: { years: number; value: number }[]): PlusRow[] =>
  (list || []).map((p) => ({ key: ++rowSeq, years: String(p.years), text: unit === 'D' ? fmtDays(p.value) : fmtHours(p.value) }));
const plusValue = (unit: 'D' | 'H', p: PlusRow) => ({ years: Number(p.years), value: unit === 'D' ? parseDays(p.text) : parseHours(p.text) });
/** Error de un plus (años enteros 1-60 sin repetir; valor en días o HH:MM), o ''. */
function plusError(unit: 'D' | 'H', p: PlusRow, all: PlusRow[]) {
  const y = Number(p.years);
  if (!/^\d{1,2}$/.test(p.years.trim()) || y < 1 || y > 60) return 'Años de 1 a 60';
  if (all.some((o) => o !== p && Number(o.years) === y)) return `Ya hay un plus a los ${y} años`;
  if (unit === 'D') { const n = parseDays(p.text); return n > 0 && Number.isInteger(n * 2) ? '' : 'Días (admite medios días)'; }
  return parseHours(p.text) > 0 ? '' : 'Horas en formato HH:MM';
}
const plusSummary = (unit: 'D' | 'H', list: PlusRow[]) =>
  list.filter((p) => !plusError(unit, p, list)).sort((a, b) => Number(a.years) - Number(b.years))
    .map((p) => `${p.years} a: +${unit === 'D' ? `${p.text} d` : `${p.text} h`}`).join(' · ');
let rowSeq = 0;
const toRow = (l: { incidence: string; value: number; pluses?: { years: number; value: number }[]; fromDays?: number }): LimitRow =>
  ({ key: ++rowSeq, incidence: l.incidence, text: fmtHours(l.value), pluses: toPlusRows('H', l.pluses), fromDays: l.fromDays });

function ConvenioModal({ convenio, incidences, vacationTypes, linkable, convenioNames, canEdit, canDelete, onClose, onChanged, onTypeCreated }: {
  convenio: EvalosConvenio | null; incidences: EvalosIncidence[]; vacationTypes: EvalosVacationTypesInfo; linkable: boolean; convenioNames: Map<string, string>;
  canEdit: boolean; canDelete: boolean; onClose: () => void; onChanged: () => void; onTypeCreated: () => void;
}) {
  const isNew = !convenio;
  const ro = !canEdit;
  const [code, setCode] = useState(convenio?.code || '');
  const [name, setName] = useState(convenio?.name || '');
  const [types, setTypes] = useState<EvalosVacationType[]>(vacationTypes.items);
  const [vacRows, setVacRows] = useState<VacRow[]>(() => (convenio?.vacations || []).map((v) => ({ key: ++rowSeq, type: v.type, day: v.day, month: v.month, ...endOf(v, v.day, v.month),
    dayText: fmtHours(v.minutesPerDay || HOURS_PER_DAY * 60),
    ...(v.unit === 'H' ? { unit: 'H' as const, text: fmtHours(v.minutes || 0), pluses: toPlusRows('H', v.pluses) } : { unit: 'D' as const, text: fmtDays(v.days), pluses: toPlusRows('D', v.pluses) }) })));
  // Filas con los pluses desplegados.
  const [openPlus, setOpenPlus] = useState<Set<number>>(new Set());
  const togglePlus = (key: number) => setOpenPlus((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  const [newType, setNewType] = useState(false);
  // Personal del convenio (EM_CONV): se carga al abrir y los cambios se aplican al guardar.
  const people = useData(() => (linkable
    ? api.get<EvalosConvenioPeopleResponse>('/api/evalos/convenios/personal')
    : Promise.resolve<EvalosConvenioPeopleResponse>({ items: [], org: { company: [], department: [], section: [], area: [] } })), [linkable]);
  const [members, setMembers] = useState<string[] | null>(null);
  const original = useMemo(() => (people.data && convenio ? people.data.items.filter((p) => p.convenio === convenio.code).map((p) => p.code) : []), [people.data, convenio]);
  const memberList = members ?? original;
  const [inc, setInc] = useState(() => {
    const day = convenio?.incidenceDay ?? 1, month = convenio?.incidenceMonth ?? 1;
    return { day, month, ...endOf({ endDay: convenio?.incidenceEndDay, endMonth: convenio?.incidenceEndMonth, endNextYear: convenio?.incidenceEndNextYear }, day, month) };
  });
  /** Nuevo inicio: si el fin era el de por defecto, pasa al por defecto del nuevo inicio. */
  const withStart = <T extends End & { day: number; month: number }>(x: T, day: number, month: number): T =>
    ({ ...x, day, month, ...(sameEnd(x, defaultEnd(x.day, x.month)) ? defaultEnd(day, month) : {}) });
  const [rows, setRows] = useState<LimitRow[]>(() => (convenio?.limits || []).map(toRow));
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const byCode = useMemo(() => new Map(incidences.map((i) => [i.code, i])), [incidences]);
  const used = new Set(rows.map((r) => r.incidence));
  const free = incidences.filter((i) => !used.has(i.code));

  const typeByCode = useMemo(() => new Map(types.map((t) => [t.code, t])), [types]);
  const setVacRow = (key: number, patch: Partial<VacRow>) => setVacRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  function addVacRow(type?: string) {
    // Por defecto, el mismo tipo e inicio que el último periodo (se pueden repetir tipos con inicios distintos).
    const last = vacRows[vacRows.length - 1];
    const t = type || last?.type || types[0]?.code;
    if (!t) return;
    const day = last?.day ?? 1, month = last?.month ?? 1;
    setVacRows((rs) => [...rs, { key: ++rowSeq, type: t, day, month, ...(last ? endOf(last, day, month) : defaultEnd(day, month)), unit: last?.unit || 'D', text: '', dayText: last?.dayText || DEFAULT_DAY_TEXT, pluses: [] }]);
  }
  /** Cambia un periodo de días a horas o al revés, convirtiendo su valor y sus pluses con las horas de un día del periodo. */
  const setVacUnit = (r: VacRow, unit: 'D' | 'H') => setVacRow(r.key, {
    unit, text: convertText(r.text, r.unit, unit, dayMinutes(r)), pluses: r.pluses.map((p) => ({ ...p, text: convertText(p.text, r.unit, unit, dayMinutes(r)) }))
  });
  function vacError(r: VacRow) {
    if (endError(r.day, r.month, r)) return endError(r.day, r.month, r);
    if (r.pluses.some((p) => plusError(r.unit, p, r.pluses))) return 'Revisa sus pluses';
    if (!r.text.trim()) return r.unit === 'H' ? 'Indica las horas' : 'Indica los días';
    if (r.unit === 'H') {
      if (!(parseHours(r.text) > 0)) return 'Horas en formato HH:MM (p. ej. 16:00)';
      const d = parseHours(r.dayText);
      return d > 0 && d <= 24 * 60 ? '' : 'Horas de un día en formato HH:MM (de 00:01 a 24:00)';
    }
    const n = parseDays(r.text);
    return !(n > 0 && n <= 365) ? 'De 0,5 a 365 días' : Number.isInteger(n * 2) ? '' : 'Solo medios días (p. ej. 22,5)';
  }
  function typeCreated(t: EvalosVacationType) {
    setTypes((ts) => [...ts.filter((x) => x.code !== t.code), t].sort((a, b) => a.code.localeCompare(b.code)));
    addVacRow(t.code);
    onTypeCreated();
  }
  const setRow = (key: number, patch: Partial<LimitRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  function addRow() {
    const first = free[0];
    if (!first) return;
    // Absentismos (tipo A) se suelen limitar en días; el resto, en horas.
    setRows((rs) => [...rs, { key: ++rowSeq, incidence: first.code, text: '', pluses: [] }]);
  }
  function rowError(r: LimitRow) {
    if (r.pluses.some((p) => plusError('H', p, r.pluses))) return 'Revisa sus pluses';
    if (!r.text.trim()) return 'Indica el límite';
    return parseHours(r.text) > 0 ? '' : 'Horas en formato HH:MM (p. ej. 20:00)';
  }
  const [touched, setTouched] = useState(false);
  const [tab, setTab] = useState<'vac' | 'inc' | 'per'>('vac');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setTouched(true);
    const vacBad = vacRows.some((r) => vacError(r)), incBad = rows.some((r) => rowError(r)) || !!endError(inc.day, inc.month, inc);
    if (vacBad || incBad) { setTab(vacBad ? 'vac' : 'inc'); toast('Revisa los campos marcados', true); return; }
    setBusy(true);
    const payload = {
      code, name,
      vacations: vacRows.map((r) => ({ type: r.type, day: r.day, month: r.month, endDay: r.endDay, endMonth: r.endMonth, endNextYear: r.endNextYear,
        ...(r.unit === 'H' ? { unit: 'H', days: 0, minutes: parseHours(r.text), minutesPerDay: dayMinutes(r) } : { unit: 'D', days: parseDays(r.text) }), pluses: r.pluses.map((p) => plusValue(r.unit, p)) })),
      incidenceDay: inc.day, incidenceMonth: inc.month, incidenceEndDay: inc.endDay, incidenceEndMonth: inc.endMonth, incidenceEndNextYear: inc.endNextYear,
      limits: rows.map((r) => ({ incidence: r.incidence, unit: 'H', value: parseHours(r.text), pluses: r.pluses.map((p) => plusValue('H', p)) })),
      // Solo si se ha tocado la lista de personas (si no, el servidor no cambia EM_CONV).
      ...(members ? { employees: members } : {})
    };
    try {
      const res = isNew
        ? await api.post<{ periodSync?: EvalosPeriodSync }>('/api/evalos/convenios', payload)
        : await api.put<{ periodSync?: EvalosPeriodSync }>(`/api/evalos/convenios/${encodeURIComponent(convenio!.code)}`, payload);
      toast(isNew ? `Convenio ${code.trim().toUpperCase()} creado` : `Convenio ${convenio!.code} guardado`);
      syncToast(toast, res.periodSync);
      onChanged();
    } catch (err: any) { toast(err.message, true); setBusy(false); }
  }
  async function remove() {
    if (!convenio || !confirmAction(`¿Eliminar el convenio ${convenio.code} con sus periodos de vacaciones y límites de incidencia?`)) return;
    try { await api.del(`/api/evalos/convenios/${encodeURIComponent(convenio.code)}`); toast(`Convenio ${convenio.code} eliminado`); onChanged(); }
    catch (err: any) { toast(err.message, true); }
  }

  const title = isNew ? 'Nuevo convenio' : `Convenio ${convenio!.code}${ro ? ' (consulta)' : ''}`;
  return (
    <Modal title={title} onClose={onClose} width={1320}>
      <form className="col" style={{ gap: 16 }} onSubmit={submit} noValidate>
        <div className="row wrap" style={{ gap: 12 }}>
          <label className="field" style={{ width: 160 }}>Código
            <input className="input mono" value={code} maxLength={10} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={!isNew || ro} placeholder="OFI" required autoFocus={isNew} />
          </label>
          <label className="field grow" style={{ minWidth: 220 }}>Nombre
            <input className="input" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} disabled={ro} placeholder="Convenio de oficinas" required />
          </label>
        </div>

        <div className="col" style={{ gap: 0 }}>
        <div className="tabs" role="tablist" aria-label="Secciones del convenio">
          {([
            ['vac', <Icon.calendar key="i" />, 'Vacaciones', vacRows.length],
            ['inc', <Icon.list key="i" />, 'Incidencias', rows.length],
            ['per', <Icon.users key="i" />, 'Personal', linkable ? memberList.length : null]
          ] as const).map(([k, icon, label, n]) => (
            <button key={k} type="button" role="tab" aria-selected={tab === k} className={`row ${tab === k ? 'on' : ''}`} style={{ gap: 8 }} onClick={() => setTab(k)}>
              {icon} {label}{n !== null && <span className="tag outline" style={{ padding: '1px 7px' }}>{n}</span>}
              {touched && ((k === 'vac' && vacRows.some((r) => vacError(r))) || (k === 'inc' && (rows.some((r) => rowError(r)) || !!endError(inc.day, inc.month, inc)))) && <span aria-label="Con errores" style={{ width: 7, height: 7, borderRadius: 9, background: 'var(--bad)' }} />}
            </button>
          ))}
        </div>

        <div role="tabpanel" className="col" style={{ gap: 12, minHeight: 340, paddingTop: 16 }}>
        {tab === 'vac' && (
        <div className="col" style={{ gap: 8 }}>
          <div className="row wrap" style={{ gap: 8 }}>
            <span className="xs muted">Un periodo por fila, en días o en horas. El fin puede ser del año siguiente (p. ej. del 01/01 al 31/01 del año siguiente).</span>
            <span className="grow" />
            {!ro && <button type="button" className="btn sm" onClick={() => setNewType((v) => !v)}><Icon.plus /> Nuevo tipo de vacaciones</button>}
            {!ro && (
              <button type="button" className="btn sm" onClick={() => addVacRow()} disabled={!types.length}
                title={!types.length ? 'No hay tipos de vacaciones: crea uno' : undefined}>
                <Icon.plus /> Añadir periodo
              </button>
            )}
          </div>
          {newType && !ro && <NewVacationType info={vacationTypes} onCreated={typeCreated} onCancel={() => setNewType(false)} />}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Tipo de vacaciones</th>
                  <th>Inicio del periodo</th>
                  <th>Fin del periodo</th>
                  <th>Cantidad</th>
                  <th>Pluses</th>
                  {!ro && <th style={{ width: 44 }} />}
                </tr>
              </thead>
              <tbody>
                {vacRows.map((r) => {
                  const info = typeByCode.get(r.type);
                  const err = touched ? vacError(r) : '';
                  return (
                    <Fragment key={r.key}>
                    <tr>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <TypeDot color={info?.color} />
                          <select className="select" style={{ minWidth: 244 }} aria-label="Tipo de vacaciones" title={info ? `${info.code} · ${info.name}` : r.type} value={r.type} disabled={ro} onChange={(e) => setVacRow(r.key, { type: e.target.value })}>
                            {!info && <option value={r.type}>{r.type} · (no existe en TIPOSVACACIONES)</option>}
                            {types.map((t) => <option key={t.code} value={t.code}>{t.code} · {t.name}</option>)}
                          </select>
                          {!info && <span className="tag warn" title="El código no está en la tabla TIPOSVACACIONES">?</span>}
                        </div>
                      </td>
                      <td><DayMonth label={`Inicio del periodo de ${r.type}`} day={r.day} month={r.month} disabled={ro} onChange={(day, month) => setVacRows((rs) => rs.map((x) => (x.key === r.key ? withStart(x, day, month) : x)))} /></td>
                      <td>
                        <EndPicker label={`Fin del periodo de ${r.type}`} end={r} disabled={ro} onChange={(e) => setVacRow(r.key, e)} />
                        <div className="xs muted" style={{ marginTop: 4 }}>Actual: {periodText(r.day, r.month, r)}</div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                          <input className="input" style={{ width: r.unit === 'H' ? 84 : 66 }} inputMode={r.unit === 'D' ? 'decimal' : 'text'} value={r.text} disabled={ro} placeholder={r.unit === 'D' ? '22' : 'HH:MM'}
                            aria-label={r.unit === 'D' ? `Días de ${r.type}` : `Horas de ${r.type}`} aria-invalid={!!err} onChange={(e) => setVacRow(r.key, { text: e.target.value })} />
                          <select className="select" style={{ width: 90 }} aria-label={`Unidad del periodo de ${r.type}`} value={r.unit} disabled={ro}
                            title="El periodo se genera en VACACIONES en días o en horas" onChange={(e) => setVacUnit(r, e.target.value === 'H' ? 'H' : 'D')}>
                            <option value="D">días</option>
                            <option value="H">horas</option>
                          </select>
                        </div>
                        {r.unit === 'H' && (
                          <label className="row xs muted" style={{ gap: 6, marginTop: 6, flexWrap: 'nowrap' }} title="Horas que se asignan al poner un día de vacaciones de este tipo (MINUTOSDIA en VACACIONES)">
                            <span style={{ whiteSpace: 'nowrap' }}>1 día =</span>
                            <input className="input" style={{ width: 66 }} value={r.dayText} disabled={ro} placeholder="08:00" aria-label={`Horas de un día de vacaciones de ${r.type}`}
                              onChange={(e) => setVacRow(r.key, { dayText: e.target.value })} />
                            <span>h</span>
                          </label>
                        )}
                        {err && <div className="xs" style={{ color: 'var(--bad)' }}>{err}</div>}
                      </td>
                      <td><PlusToggle unit={r.unit} pluses={r.pluses} open={openPlus.has(r.key)} onToggle={() => togglePlus(r.key)} ro={ro} /></td>
                      {!ro && <td><button type="button" className="icon-btn" aria-label={`Quitar ${r.type}`} onClick={() => setVacRows((rs) => rs.filter((x) => x.key !== r.key))}><Icon.trash /></button></td>}
                    </tr>
                    {openPlus.has(r.key) && (
                      <tr><td colSpan={ro ? 5 : 6} style={{ background: 'var(--surface-2)' }}>
                        <PlusEditor unit={r.unit} pluses={r.pluses} ro={ro} touched={touched} what={`del periodo de ${r.type}`} onChange={(pl) => setVacRow(r.key, { pluses: pl })} />
                      </td></tr>
                    )}
                    </Fragment>
                  );
                })}
                {!vacRows.length && (
                  <tr><td colSpan={ro ? 5 : 6} className="muted small" style={{ padding: 20, textAlign: 'center' }}>
                    Sin periodos de vacaciones.{!ro && (types.length ? ' Añade tantos periodos como necesites.' : ' Crea primero un tipo de vacaciones.')}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        )}

        {tab === 'inc' && (
        <div className="col" style={{ gap: 14 }}>
          <div className="row wrap" style={{ gap: 12, padding: '12px 14px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <b className="small">Periodo de incidencias</b>
            <span className="small muted">del</span>
            <DayMonth label="Inicio del periodo de incidencias" day={inc.day} month={inc.month} disabled={ro} onChange={(day, month) => setInc((x) => withStart(x, day, month))} />
            <span className="small muted">al</span>
            <EndPicker label="Fin del periodo de incidencias" end={inc} disabled={ro} onChange={(e) => setInc((x) => ({ ...x, ...e }))} />
            <span className="xs muted" style={{ flexBasis: '100%' }}>Periodo actual: {periodText(inc.day, inc.month, inc)}. Los límites cuentan dentro de cada periodo.</span>
            {touched && endError(inc.day, inc.month, inc) && <span className="xs" style={{ color: 'var(--bad)', flexBasis: '100%' }}>{endError(inc.day, inc.month, inc)}</span>}
          </div>

        <div className="col" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 8 }}>
            <b className="small">Límites de incidencia</b>
            <span className="xs muted">en horas</span>
            <span className="grow" />
            {!ro && (
              <button type="button" className="btn sm" onClick={addRow} disabled={!free.length} title={!incidences.length ? 'No hay incidencias en INCIDENC' : !free.length ? 'Ya están todas las incidencias' : undefined}>
                <Icon.plus /> Añadir incidencia
              </button>
            )}
          </div>
          {rows.some((r) => r.fromDays !== undefined) && (
            <div className="alert warn small">
              Algunos límites estaban guardados en días. Las incidencias van siempre en horas: se han pasado a {HOURS_PER_DAY} h por día
              (marcados con «Antes … d»). Revísalos y pulsa Guardar para dejarlos en horas.
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Incidencia</th>
                  <th>Límite por periodo (horas)</th>
                  <th>Pluses</th>
                  {!ro && <th style={{ width: 44 }} />}
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const info = byCode.get(r.incidence);
                  const err = touched ? rowError(r) : '';
                  return (
                    <Fragment key={r.key}>
                    <tr>
                      <td>
                        <div className="row" style={{ gap: 8 }}>
                          <select className="select grow" style={{ minWidth: 230 }} aria-label="Incidencia" value={r.incidence} disabled={ro} onChange={(e) => setRow(r.key, { incidence: e.target.value })}>
                            {!info && <option value={r.incidence}>{r.incidence} · (no existe en INCIDENC)</option>}
                            {incidences.filter((i) => i.code === r.incidence || !used.has(i.code)).map((i) => <option key={i.code} value={i.code}>{i.code} · {i.name}</option>)}
                          </select>
                          {info?.type && <span className={`tag ${info.type === 'A' ? 'info' : 'outline'}`} title={TYPE_LABEL[info.type] || `Tipo ${info.type}`}>{info.type}</span>}
                          {!info && <span className="tag warn" title="El código no está en la tabla INCIDENC">?</span>}
                        </div>
                      </td>
                      <td>
                        <div className="row" style={{ gap: 6 }}>
                          <input className="input" style={{ width: 110 }} value={r.text} disabled={ro} placeholder="HH:MM" aria-label="Límite en horas" aria-invalid={!!err}
                            onChange={(e) => setRow(r.key, { text: e.target.value, fromDays: undefined })} />
                          <span className="small muted">h</span>
                          {r.fromDays !== undefined && (
                            <span className="tag warn" title={`Estaba guardado como ${fmtDays(r.fromDays)} días. Se ha pasado a horas a ${HOURS_PER_DAY} h por día: revísalo y guarda.`}>
                              Antes {fmtDays(r.fromDays)} d
                            </span>
                          )}
                        </div>
                        {err && <div className="xs" style={{ color: 'var(--bad)' }}>{err}</div>}
                      </td>
                      <td><PlusToggle unit="H" pluses={r.pluses} open={openPlus.has(r.key)} onToggle={() => togglePlus(r.key)} ro={ro} /></td>
                      {!ro && <td><button type="button" className="icon-btn" aria-label={`Quitar ${r.incidence}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}><Icon.trash /></button></td>}
                    </tr>
                    {openPlus.has(r.key) && (
                      <tr><td colSpan={ro ? 3 : 4} style={{ background: 'var(--surface-2)' }}>
                        <PlusEditor unit="H" pluses={r.pluses} ro={ro} touched={touched} what={`de la incidencia ${r.incidence}`} onChange={(pl) => setRow(r.key, { pluses: pl })} />
                      </td></tr>
                    )}
                    </Fragment>
                  );
                })}
                {!rows.length && (
                  <tr><td colSpan={ro ? 3 : 4} className="muted small" style={{ padding: 20, textAlign: 'center' }}>
                    Sin límites de incidencia.{!ro && incidences.length > 0 && ' Añade las incidencias que quieras limitar.'}
                  </td></tr>
                )}
              </tbody>
            </table>
          </div>
          {!incidences.length && <span className="xs muted">No se han encontrado incidencias en la tabla INCIDENC.</span>}
        </div>

        </div>
        )}

        {tab === 'per' && (linkable ? (
          <ConvenioPeople
            people={people.data?.items || null} org={people.data?.org || null} error={people.error} members={memberList} ro={ro}
            current={convenio?.code || code.trim().toUpperCase()} convenioNames={convenioNames} saved={convenio?.code || null}
            onChange={setMembers}
          />
        ) : (
          <div className="alert warn xs">La tabla PERSONAL no tiene la columna EM_CONV: no se puede vincular el personal a los convenios.</div>
        ))}
        </div>
        </div>

        <div className="row" style={{ justifyContent: 'space-between', gap: 8 }}>
          {!isNew && canDelete ? <button type="button" className="btn danger sm" onClick={remove}><Icon.trash /> Eliminar</button> : <span />}
          <div className="row" style={{ gap: 8 }}>
            <button type="button" className="btn" onClick={onClose}>{ro ? 'Cerrar' : 'Cancelar'}</button>
            {!ro && <button className="btn primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar'}</button>}
          </div>
        </div>
      </form>
    </Modal>
  );
}

// ---------- Pluses por antigüedad ----------
/** Botón de la columna «Pluses»: resume los tramos y despliega el editor. */
function PlusToggle({ unit, pluses, open, onToggle, ro }: { unit: 'D' | 'H'; pluses: PlusRow[]; open: boolean; onToggle: () => void; ro: boolean }) {
  const summary = plusSummary(unit, pluses);
  return (
    <button type="button" className="btn sm" style={{ whiteSpace: 'nowrap' }} onClick={onToggle} aria-expanded={open} title={summary || undefined}>
      <span style={{ display: 'inline-flex', transform: open ? 'rotate(0deg)' : 'rotate(-90deg)', transition: 'transform .15s' }}><Icon.chevron /></span>
      {pluses.length ? `${pluses.length} plus${pluses.length === 1 ? '' : 'es'}` : <span className="muted">{ro ? 'Sin pluses' : 'Añadir'}</span>}
    </button>
  );
}

/** Tramos «a partir de N años, X días u horas más» de una línea (periodo de vacaciones o límite de incidencia). */
function PlusEditor({ unit, pluses, ro, touched, what, onChange }: { unit: 'D' | 'H'; pluses: PlusRow[]; ro: boolean; touched: boolean; what: string; onChange: (p: PlusRow[]) => void }) {
  const set = (key: number, patch: Partial<PlusRow>) => onChange(pluses.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  function add() {
    const max = pluses.reduce((m, p) => Math.max(m, Number(p.years) || 0), 0);
    onChange([...pluses, { key: ++rowSeq, years: String(Math.min(60, max + 1 || 1)), text: '' }]);
  }
  return (
    <div className="col" style={{ gap: 8, padding: '4px 0' }}>
      <span className="xs muted">Pluses por antigüedad {what}: a partir de los años indicados se suman {unit === 'D' ? 'los días' : 'las horas'} del plus.</span>
      {pluses.map((p) => {
        const err = touched || p.text ? plusError(unit, p, pluses) : '';
        return (
          <div key={p.key} className="row wrap" style={{ gap: 8 }}>
            <span className="small">A partir de</span>
            <input className="input" style={{ width: 64 }} inputMode="numeric" aria-label="Años" value={p.years} disabled={ro} onChange={(e) => set(p.key, { years: e.target.value.replace(/\D/g, '').slice(0, 2) })} />
            <span className="small">años,</span>
            <input className="input" style={{ width: 96 }} inputMode={unit === 'D' ? 'decimal' : 'text'} aria-label={unit === 'D' ? 'Días más' : 'Horas más'} value={p.text} disabled={ro}
              placeholder={unit === 'D' ? '1' : '03:00'} onChange={(e) => set(p.key, { text: e.target.value })} aria-invalid={!!err} />
            <span className="small">{unit === 'D' ? 'días más' : 'horas más'}</span>
            {!ro && <button type="button" className="icon-btn" aria-label={`Quitar el plus de ${p.years} años`} onClick={() => onChange(pluses.filter((x) => x.key !== p.key))}><Icon.trash /></button>}
            {err && <span className="xs" style={{ color: 'var(--bad)' }}>{err}</span>}
          </div>
        );
      })}
      {!pluses.length && <span className="small muted">Sin pluses.</span>}
      {!ro && <button type="button" className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={add}><Icon.plus /> Añadir plus</button>}
    </div>
  );
}

// ---------- Personal del convenio (EM_CONV) ----------
const ORG_KINDS: [EvalosOrgKind, string][] = [['company', 'Empresa'], ['department', 'Departamento'], ['section', 'Sección'], ['area', 'Área']];

/** Resumen tras generar periodos de VACACIONES e INCIDENCIALIMITE. */
function syncToast(toast: (msg: string, error?: boolean) => void, s: EvalosPeriodSync | null | undefined) {
  if (!s) return;
  if (s.created || s.updated) toast(`Periodos de vacaciones y límites: ${s.created} nuevos, ${s.updated} actualizados`);
  for (const w of s.warnings) toast(w, true);
  if (s.alerts.length) toast(`${s.alerts.length} aviso(s): hay personas con más días u horas disfrutados que disponibles. Míralo en la pestaña Personal.`, true);
}

function ConvenioPeople({ people, org, error, members, ro, current, saved, convenioNames, onChange }: {
  people: EvalosConvenioPerson[] | null; org: Record<EvalosOrgKind, { code: string; description: string }[]> | null; error: string | null;
  members: string[]; ro: boolean; current: string; saved: string | null; convenioNames: Map<string, string>; onChange: (m: string[]) => void;
}) {
  const toast = useToast();
  // Avisos vigentes (VACACIONES / INCIDENCIALIMITE con más disfrutado que disponible) de las personas ya guardadas.
  const avisos = useData(() => (saved ? api.get<{ alerts: { employee: string; text: string }[]; error: string }>(`/api/evalos/convenios/${encodeURIComponent(saved)}/avisos`) : Promise.resolve({ alerts: [], error: '' })), [saved]);
  const alertsBy = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const a of avisos.data?.alerts || []) m.set(a.employee, [...(m.get(a.employee) || []), a.text]);
    return m;
  }, [avisos.data]);
  const [generating, setGenerating] = useState(false);
  async function generateNext() {
    if (!saved || !confirmAction('Se crearán (o actualizarán) los periodos de vacaciones y límites del año siguiente para todas las personas en alta de este convenio. ¿Continuar?')) return;
    setGenerating(true);
    try { syncToast(toast, await api.post<EvalosPeriodSync>(`/api/evalos/convenios/${encodeURIComponent(saved)}/siguiente`, {})); avisos.reload(); }
    catch (e: any) { toast(e.message, true); }
    finally { setGenerating(false); }
  }
  const [q, setQ] = useState('');
  const [withInactive, setWithInactive] = useState(false);
  const [bulkKind, setBulkKind] = useState<EvalosOrgKind>('department');
  const [bulkValue, setBulkValue] = useState('');
  const byCode = useMemo(() => new Map((people || []).map((p) => [p.code, p])), [people]);
  const orgName = useMemo(() => {
    const m = {} as Record<EvalosOrgKind, Map<string, string>>;
    for (const [k] of ORG_KINDS) m[k] = new Map((org?.[k] || []).map((x) => [x.code, x.description]));
    return m;
  }, [org]);
  const describe = (k: EvalosOrgKind, code: string) => (code ? orgName[k].get(code) || code : '');
  const inSet = new Set(members);
  // Añadir en bloque: personas con ese valor de empresa / departamento / sección / área que aún no están.
  const eligible = (p: EvalosConvenioPerson) => !inSet.has(p.code) && (withInactive || p.active);
  const bulkOptions = useMemo(() => {
    const count = new Map<string, number>();
    for (const p of people || []) if (p[bulkKind] && eligible(p)) count.set(p[bulkKind], (count.get(p[bulkKind]) || 0) + 1);
    return [...count.entries()].map(([code, n]) => ({ code, n, label: describe(bulkKind, code) })).sort((a, b) => a.label.localeCompare(b.label));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [people, bulkKind, members, withInactive, orgName]);
  const bulkPeople = bulkValue ? (people || []).filter((p) => p[bulkKind] === bulkValue && eligible(p)) : [];
  const bulkMoving = bulkPeople.filter((p) => p.convenio && p.convenio !== current).length;
  // Quitar en bloque: personas del convenio con ese valor.
  const [remKind, setRemKind] = useState<EvalosOrgKind>('department');
  const [remValue, setRemValue] = useState('');
  const memberPeople = members.map((c) => byCode.get(c)).filter((p): p is EvalosConvenioPerson => !!p);
  const remOptions = (() => {
    const count = new Map<string, number>();
    for (const p of memberPeople) if (p[remKind]) count.set(p[remKind], (count.get(p[remKind]) || 0) + 1);
    return [...count.entries()].map(([code, n]) => ({ code, n, label: describe(remKind, code) })).sort((a, b) => a.label.localeCompare(b.label));
  })();
  const remPeople = remValue ? memberPeople.filter((p) => p[remKind] === remValue) : [];
  function removeBulk() {
    if (!remPeople.length) return;
    const out = new Set(remPeople.map((p) => p.code));
    onChange(members.filter((m) => !out.has(m)));
    toast(`${remPeople.length} persona(s) quitadas. Se guardará al pulsar Guardar.`);
    setRemValue('');
  }
  function addBulk() {
    if (!bulkPeople.length) return;
    onChange([...members, ...bulkPeople.map((p) => p.code)]);
    toast(`${bulkPeople.length} persona(s) añadidas. Se guardarán al pulsar Guardar.`);
    setBulkValue('');
  }
  const list = members.map((c) => byCode.get(c) || { code: c, name: '', company: '', department: '', section: '', area: '', convenio: current, active: true })
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const needle = q.trim().toLowerCase();
  const candidates = needle && people
    ? people.filter((p) => !inSet.has(p.code) && (withInactive || p.active) && (p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))).slice(0, 30)
    : [];
  const activeCount = list.filter((p) => p.active).length;
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 8 }}>
      <span className="xs muted grow">{list.length} persona(s) con este convenio{list.length ? `: ${activeCount} en alta${list.length > activeCount ? ` y ${list.length - activeCount} de baja` : ''}` : ''}.</span>
        {saved && !ro && (
          <button type="button" className="btn sm" onClick={generateNext} disabled={generating} title="Crea en VACACIONES e INCIDENCIALIMITE el periodo siguiente al que está en curso, para las personas en alta">
            <Icon.calendar /> {generating ? 'Generando…' : 'Generar periodos del año siguiente'}
          </button>
        )}
      </div>
      {!!avisos.data?.alerts.length && (
        <div className="alert warn small col" style={{ gap: 4, maxHeight: 160, overflowY: 'auto' }}>
          <b>{avisos.data.alerts.length} aviso(s) de vacaciones o límites</b>
          {avisos.data.alerts.map((a, i) => <span key={i}><span className="mono">{a.employee}</span> {byCode.get(a.employee)?.name || ''}: {a.text}</span>)}
        </div>
      )}
      {avisos.data?.error && <div className="alert warn xs">No se pudieron leer los periodos: {avisos.data.error}</div>}
      {error && <div className="alert warn xs">No se pudo leer el personal: {error}</div>}
      {!ro && (
        <div className="col" style={{ gap: 6 }}>
          <div className="row wrap" style={{ gap: 10 }}>
            <input className="input" style={{ maxWidth: 360 }} placeholder="Añadir personas: busca por código o nombre" value={q} onChange={(e) => setQ(e.target.value)} disabled={!people} />
            <label className="row small" style={{ gap: 6, fontWeight: 400 }}>
              <input type="checkbox" checked={withInactive} onChange={(e) => setWithInactive(e.target.checked)} /> Incluir personas de baja
            </label>
          </div>
          <div className="row wrap" style={{ gap: 8, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <b className="small" style={{ minWidth: 118 }}>Añadir en bloque</b>
            <select className="select" style={{ width: 160 }} aria-label="Añadir en bloque por" value={bulkKind} disabled={!people}
              onChange={(e) => { setBulkKind(e.target.value as EvalosOrgKind); setBulkValue(''); }}>
              {ORG_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select className="select" style={{ minWidth: 260, width: 'auto' }} aria-label="Valor" value={bulkValue} disabled={!people} onChange={(e) => setBulkValue(e.target.value)}>
              <option value="">{bulkOptions.length ? 'Elige…' : 'No hay personas para añadir'}</option>
              {bulkOptions.map((o) => <option key={o.code} value={o.code}>{o.label}{o.label !== o.code ? ` (${o.code})` : ''} · {o.n} persona(s)</option>)}
            </select>
            <button type="button" className="btn sm primary" onClick={addBulk} disabled={!bulkPeople.length}>
              <Icon.plus /> Añadir {bulkPeople.length || ''} persona(s)
            </button>
            {bulkMoving > 0 && <span className="xs muted">{bulkMoving === 1 ? 'Una de ellas está en otro convenio y se cambiará a este.' : `${bulkMoving} de ellas están en otro convenio y se cambiarán a este.`}</span>}
          </div>
          <div className="row wrap" style={{ gap: 8, padding: '10px 12px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
            <b className="small" style={{ minWidth: 118 }}>Quitar en bloque</b>
            <select className="select" style={{ width: 160 }} aria-label="Quitar en bloque por" value={remKind} disabled={!people}
              onChange={(e) => { setRemKind(e.target.value as EvalosOrgKind); setRemValue(''); }}>
              {ORG_KINDS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
            <select className="select" style={{ minWidth: 260, width: 'auto' }} aria-label="Valor a quitar" value={remValue} disabled={!people} onChange={(e) => setRemValue(e.target.value)}>
              <option value="">{remOptions.length ? 'Elige…' : 'Nadie del convenio tiene valor aquí'}</option>
              {remOptions.map((o) => <option key={o.code} value={o.code}>{o.label}{o.label !== o.code ? ` (${o.code})` : ''} · {o.n} persona(s)</option>)}
            </select>
            <button type="button" className="btn sm danger" onClick={removeBulk} disabled={!remPeople.length}>
              <Icon.trash /> Quitar {remPeople.length || ''} persona(s)
            </button>
          </div>
          {needle && (
            <div className="table-wrap" style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table className="table">
                <tbody>
                  {candidates.map((p) => (
                    <tr key={p.code}>
                      <td className="mono small" style={{ width: 130 }}>{p.code}</td>
                      <td className="small">{p.name}{!p.active && <span className="tag outline" style={{ marginLeft: 6 }}>De baja</span>}</td>
                      <td className="xs muted">{p.convenio ? `Ahora en ${p.convenio}${convenioNames.get(p.convenio) ? ` · ${convenioNames.get(p.convenio)}` : ''}: se cambiará a este` : 'Sin convenio'}</td>
                      <td style={{ width: 110, textAlign: 'right' }}><button type="button" className="btn sm" onClick={() => onChange([...members, p.code])}><Icon.plus /> Añadir</button></td>
                    </tr>
                  ))}
                  {!candidates.length && <tr><td className="muted small" style={{ padding: 14, textAlign: 'center' }}>Nadie coincide con la búsqueda (o ya está en el convenio).</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      <div className="table-wrap" style={{ maxHeight: 280, overflowY: 'auto' }}>
        <table className="table">
          <thead><tr><th>Código</th><th>Nombre</th><th>Empresa</th><th>Departamento</th><th>Estado</th>{!ro && <th style={{ width: 44 }} />}</tr></thead>
          <tbody>
            {!people && !error && <tr><td colSpan={6} className="muted small" style={{ padding: 16, textAlign: 'center' }}>Cargando personal…</td></tr>}
            {people && list.map((p) => (
              <tr key={p.code}>
                <td className="mono small">{p.code}</td>
                <td className="small">{p.name || <span className="muted">—</span>}</td>
                <td className="small">{describe('company', p.company) || <span className="muted">—</span>}</td>
                <td className="small">{describe('department', p.department) || <span className="muted">—</span>}</td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    {p.active ? <span className="tag ok">En alta</span> : <span className="tag outline">De baja</span>}
                    {alertsBy.has(p.code) && <span className="tag warn" title={alertsBy.get(p.code)!.join('\n')}>Aviso</span>}
                  </span>
                </td>
                {!ro && <td><button type="button" className="icon-btn" aria-label={`Quitar ${p.code} del convenio`} onClick={() => onChange(members.filter((m) => m !== p.code))}><Icon.trash /></button></td>}
              </tr>
            ))}
            {people && !list.length && <tr><td colSpan={6} className="muted small" style={{ padding: 16, textAlign: 'center' }}>Nadie tiene asignado este convenio.{!ro && ' Búscalos arriba para añadirlos.'}</td></tr>}
          </tbody>
        </table>
      </div>
      {!ro && <span className="xs muted">Los cambios de personal se aplican al pulsar Guardar: a las personas en alta se les crean o actualizan sus periodos de vacaciones y límites (los de quien sale del convenio no se borran). También se puede asignar el convenio desde la ficha de cada persona en Personal.</span>}
    </div>
  );
}

// ---------- Widget ----------
const ChevR = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;

export function ConveniosWidget() {
  const { data, error } = useConvenios();
  if (error) return error;
  if (!data) return <Loading />;
  if (data.missing) return <Link to="/evalos/convenios" className="small muted">Falta crear las tablas de convenios en Evalos 8. Abre la pantalla para ver el script →</Link>;
  // Lo accionable primero: convenios sin personas o sin límites definidos.
  const issue = (c: typeof data.convenios[number]) => (!(c.employees ?? 0) ? 'Sin personas' : !c.limits.length ? 'Sin límites' : null);
  const ranked = [...data.convenios].sort((a, b) => (issue(a) ? 0 : 1) - (issue(b) ? 0 : 1));
  const needReview = data.convenios.filter(issue).length;
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <div className="ev-mini grow"><span className="xs muted" style={{ fontWeight: 600 }}>Convenios</span><b>{data.convenios.length}</b></div>
        <div className={`ev-mini grow${needReview ? ' alert' : ''}`}><span className="xs muted" style={{ fontWeight: 600 }}>Necesitan repaso</span><b>{needReview}</b></div>
      </div>
      <div className="w-list">
        {ranked.slice(0, 4).map((c) => {
          const tag = issue(c);
          return (
            <Link key={c.code} to={`/evalos/convenios?code=${encodeURIComponent(c.code)}`} className="w-row">
              <span className="w-row-main"><b>{c.name}</b><span className="xs muted"><span className="mono">{c.code}</span> · {c.employees ?? 0} persona(s) · {c.limits.length} límite(s)</span></span>
              {tag && <span className="tag warn">{tag}</span>}
              <span className="chev-r"><ChevR /></span>
            </Link>
          );
        })}
        {!data.convenios.length && <div className="w-empty">Aún no hay convenios.</div>}
      </div>
      <div className="w-quick">
        {data.canEdit && <Link to="/evalos/convenios?new=1"><Icon.plus /> Nuevo convenio</Link>}
        <Link to="/evalos/convenios"><Icon.ext /> Abrir convenios</Link>
      </div>
    </div>
  );
}
