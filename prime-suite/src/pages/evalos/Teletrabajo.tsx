// Atajos de Evalos · Teletrabajo.
// Planificación de teletrabajo / presencial por empleado y día, bolsas de teletrabajo por periodo,
// aforo de la oficina, mínimos presenciales, acuerdos de trabajo a distancia (Ley 10/2021),
// compensación de gastos e informe anual. El mismo archivo exporta el widget del Inicio.
import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError } from '../../api';
import { Drawer, ErrorBox, Fold, Icon, Loading, Modal, Toggle, useData, useToast } from '../../components/ui';
import { NotConfigured } from './common';

// ---------- Tipos (espejo de server/evalos/telework.ts) ----------
type DayKind = 'O' | 'T' | 'H';
type Eff = { k: 'X' | 'F' | 'A' | 'N' } | { k: DayKind; h: number; planned: boolean };
type Mode = 'presencial' | 'hibrido' | 'remoto';
type Unit = 'days' | 'hours';
type Period = 'week' | 'month' | 'quarter' | 'year';
interface Policy { id: string; name: string; mode: Mode; unit: Unit; amount: number; period: Period; preferredDays: number[]; minOfficeDaysWeek: number; hoursPerDay: number; color: string }
interface Assignment { policyId: string; from: string; to?: string; agreementSigned: boolean; agreementDate?: string; notes?: string }
interface Settings { officeCapacity: number | null; allowancePerDay: number; legalThresholdPct: number; carryOver: boolean; maxCarryOver: number; calendarCode?: string; workDays: number[]; minOfficeByDept: Record<string, number>; defaultPolicyId?: string }
interface Balance { policyId: string | null; policyName: string; mode: Mode | null; unit: Unit; period: Period | null; from: string; to: string; allowance: number | null; carry: number; used: number; planned: number; available: number | null; exceeded: boolean }
interface AlertT { level: 'warn' | 'bad' | 'info'; employee?: string; date?: string; text: string }
interface Row { code: string; name: string; department: string; policyId: string | null; days: Record<string, Eff>; balance: Balance; legalPct: number; agreementSigned: boolean; twDays: number; officeDays: number; compensation: number; alerts: AlertT[] }
interface View { month: string; days: string[]; rows: Row[]; occupancy: Record<string, { office: number; remote: number; absent: number }>; alerts: AlertT[] }
interface Resp {
  month: string; today: string; engine: string; settings: Settings; policies: Policy[]; assignments: Record<string, Assignment>;
  departments: { code: string; description: string }[]; calendars: { code: string; name: string; year: number }[];
  holidays: string[]; view: View; warnings: string[]; canEdit: boolean; canAdmin: boolean;
}
interface ReportRow { code: string; name: string; department: string; policy: string; twDays: number; officeDays: number; absentDays: number; twHours: number; pct: number; compensation: number; agreementSigned: boolean; agreementDate: string }

const NC = { notConfigured: true } as unknown as Resp;
const WD = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const WD_LONG = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const PERIOD_LABEL: Record<Period, string> = { week: 'semana', month: 'mes', quarter: 'trimestre', year: 'año' };
const MODE_LABEL: Record<Mode, string> = { presencial: 'Presencial', hibrido: 'Híbrido', remoto: 'Teletrabajo completo' };
const fmt = (iso: string) => (iso ? iso.split('-').reverse().join('/') : '');
const wd = (iso: string) => ((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;
const shiftMonth = (m: string, n: number) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return d.toISOString().slice(0, 7); };
const monthLabel = (m: string) => { const [y, mo] = m.split('-').map(Number); return `${MONTHS[mo - 1]} ${y}`; };
const num = (n: number) => (Math.round(n * 100) / 100).toLocaleString('es-ES');
const unitLabel = (u: Unit, n: number) => (u === 'days' ? (Math.abs(n) === 1 ? 'día' : 'días') : 'h');

/** Valor que deja el pincel en un día ('clear' = volver a lo que marca la política). */
type Brush = 'O' | 'T' | 'H' | 'clear';
const BRUSHES: { k: Brush; label: string }[] = [
  { k: 'O', label: 'Oficina' }, { k: 'T', label: 'Teletrabajo' }, { k: 'H', label: 'Mixto' }, { k: 'clear', label: 'Borrar' }
];

function useTeletrabajo(month: string) {
  const { data, error, reload } = useData(() =>
    api.get<Resp>(`/api/evalos/teletrabajo?month=${month}`).catch((e) => {
      if (e instanceof ApiError && e.code === 'not_configured') return NC;
      throw e;
    }), [month]);
  let node: JSX.Element | null = null;
  if (data === NC) node = <NotConfigured />;
  else if (error && !data) node = <div className="col" style={{ gap: 8 }}><ErrorBox error={error} /><button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={reload}><Icon.refresh /> Reintentar</button></div>;
  return { data: data === NC ? null : data, error: node, reload };
}

// ---------- Celda de día ----------
function DayCell({ e, today, date, holiday, onDown, onEnter, big }: { e: Eff; today: string; date: string; holiday?: boolean; onDown?: () => void; onEnter?: () => void; big?: boolean }) {
  const cls = ['tw-d', `k-${e.k}`];
  if ('planned' in e && !e.planned) cls.push('def');
  if (date === today) cls.push('today');
  if (date < today) cls.push('past');
  if (big) cls.push('big');
  const label = e.k === 'T' ? 'T' : e.k === 'O' ? 'O' : e.k === 'H' ? '½' : e.k === 'A' ? 'A' : e.k === 'F' ? 'F' : '';
  const title = `${fmt(date)} · ${e.k === 'T' ? 'Teletrabajo' : e.k === 'O' ? 'Oficina' : e.k === 'H' ? `Mixto (${(e as any).h} h de teletrabajo)` : e.k === 'A' ? 'Ausencia / vacaciones' : e.k === 'F' || holiday ? 'Festivo' : e.k === 'N' ? 'Sin contrato' : 'No laborable'}${'planned' in e && !e.planned ? ' · según política' : ''}`;
  const editable = 'planned' in e;
  return (
    <span
      className={cls.join(' ')}
      title={title}
      onMouseDown={editable && onDown ? (ev) => { ev.preventDefault(); onDown(); } : undefined}
      onMouseEnter={editable ? onEnter : undefined}
    >
      {big ? <><b>{Number(date.slice(8))}</b><i>{label}{e.k === 'H' ? ` ${(e as any).h}h` : ''}</i></> : label}
    </span>
  );
}

function Meter({ value, max, bad }: { value: number; max: number; bad?: boolean }) {
  const pct = max > 0 ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return <span className="ev-meter sm"><span style={{ width: `${pct}%`, background: bad ? 'var(--bad)' : undefined }} /></span>;
}

function BalanceText({ b }: { b: Balance }) {
  if (b.allowance === null) return <span className="xs muted">Sin límite</span>;
  if (b.mode === 'presencial') return <span className="xs muted">Presencial</span>;
  const total = b.allowance + b.carry;
  return (
    <span className="row" style={{ gap: 6 }} title={`Cupo ${num(b.allowance)}${b.carry ? ` + arrastre ${num(b.carry)}` : ''} · consumido ${num(b.used)} · planificado ${num(b.planned)} (${PERIOD_LABEL[b.period!]} ${fmt(b.from)}–${fmt(b.to)})`}>
      <Meter value={b.used + b.planned} max={total} bad={b.exceeded} />
      <span className={`xs ${b.exceeded ? '' : 'muted'}`} style={{ color: b.exceeded ? 'var(--bad)' : undefined, fontWeight: 600, whiteSpace: 'nowrap' }}>
        {num(b.available!)} / {num(total)} {unitLabel(b.unit, total)}
      </span>
    </span>
  );
}

type Tab = 'plan' | 'politicas' | 'informe' | 'ajustes';
interface ChangeWarning { level: 'warn' | 'bad'; employee?: string; name?: string; date?: string; kind: 'quota' | 'minOffice' | 'capacity' | 'legal'; text: string }
type Change = { employee: string; date: string; value: string | null };

export default function Teletrabajo() {
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(() => { const m = params.get('month'); return m && /^\d{4}-\d{2}$/.test(m) ? m : new Date().toISOString().slice(0, 7); });
  const { data, error, reload } = useTeletrabajo(month);
  const [tab, setTab] = useState<Tab>('plan');
  const [dept, setDept] = useState('');
  const [q, setQ] = useState('');
  const [brush, setBrush] = useState<Brush>('T');
  const [hBrush, setHBrush] = useState(4);
  const [openEmp, setOpenEmp] = useState<string | null>(null);
  const [pattern, setPattern] = useState(false);
  const [assignFor, setAssignFor] = useState<string[] | null>(null);
  const [showAlerts, setShowAlerts] = useState(false);
  // Cambios que superan la bolsa u otras reglas: se piden confirmar con una ventana antes de guardarlos.
  const [confirm, setConfirm] = useState<{ changes: Change[]; warnings: ChangeWarning[] } | null>(null);
  // Cambios optimistas pendientes de guardar (se envían agrupados).
  const [local, setLocal] = useState<Record<string, Record<string, string | null>>>({});
  const pending = useRef<{ employee: string; date: string; value: string | null }[]>([]);
  const timer = useRef<number | null>(null);
  const painting = useRef(false);

  useEffect(() => { const up = () => { painting.current = false; }; window.addEventListener('mouseup', up); return () => window.removeEventListener('mouseup', up); }, []);
  useEffect(() => { setLocal({}); }, [data]);
  // Deep-link desde el widget del Inicio: ?emp=CODE abre su calendario, ?alerts=1 la lista de avisos, ?pattern=1 rellenar el mes.
  useEffect(() => {
    if (!data || (!params.get('emp') && !params.get('alerts') && !params.get('pattern'))) return;
    const emp = params.get('emp');
    if (emp && data.view.rows.some((r) => r.code === emp)) setOpenEmp(emp);
    if (params.get('alerts') === '1') { setTab('plan'); setShowAlerts(true); }
    if (params.get('pattern') === '1' && data.canEdit) setPattern(true);
    setParams({}, { replace: true });
  }, [data, params, setParams]);

  const deptName = useMemo(() => new Map((data?.departments || []).map((d) => [d.code, d.description])), [data]);
  const rows = useMemo(() => {
    if (!data) return [];
    const s = q.trim().toLowerCase();
    return data.view.rows.filter((r) => (!dept || r.department === dept) && (!s || r.name.toLowerCase().includes(s) || r.code.toLowerCase().includes(s)));
  }, [data, dept, q]);

  if (error) return error;
  if (!data) return <Loading />;
  const d = data;
  const holidays = new Set(d.holidays);
  const policyById = new Map(d.policies.map((p) => [p.id, p]));

  function save(list: Change[]) {
    return api.put('/api/evalos/teletrabajo/dias', { changes: list }).then(() => reload()).catch((e) => { toast(e.message, true); reload(); });
  }
  /** Antes de guardar se comprueba si los cambios superan la bolsa, el mínimo presencial o el aforo. */
  async function flush() {
    const list = pending.current;
    pending.current = [];
    timer.current = null;
    if (!list.length) return;
    try {
      const r = await api.post<{ warnings: ChangeWarning[] }>('/api/evalos/teletrabajo/comprobar', { changes: list });
      if (r.warnings.length) { setConfirm({ changes: list, warnings: r.warnings }); return; }
    } catch { /* si la comprobación falla, se guarda igualmente */ }
    save(list);
  }
  function discard(list: Change[]) {
    setLocal((l) => {
      const n = { ...l };
      for (const c of list) { if (n[c.employee]) { const e = { ...n[c.employee] }; delete e[c.date]; n[c.employee] = e; } }
      return n;
    });
  }
  /** Cambiar la política de un empleado desde su fila ('' = la política por defecto). */
  async function assignQuick(code: string, policyId: string) {
    const cur = d.assignments[code];
    try {
      await api.put('/api/evalos/teletrabajo/asignaciones', {
        codes: [code],
        assignment: policyId ? { policyId, from: cur?.from || `${d.today.slice(0, 4)}-01-01`, to: cur?.to, agreementSigned: !!cur?.agreementSigned, agreementDate: cur?.agreementDate, notes: cur?.notes } : null
      });
      toast(policyId ? `Política asignada: ${policyById.get(policyId)?.name}` : 'Vuelve a la política por defecto');
      reload();
    } catch (e: any) { toast(e.message, true); }
  }
  function paint(emp: string, date: string) {
    if (!d.canEdit) return;
    const value = brush === 'clear' ? null : brush === 'H' ? `H${hBrush}` : brush;
    setLocal((l) => ({ ...l, [emp]: { ...(l[emp] || {}), [date]: value } }));
    pending.current = pending.current.filter((x) => !(x.employee === emp && x.date === date)).concat({ employee: emp, date, value });
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(flush, 700);
  }
  /** Día efectivo con los cambios locales aún no guardados. */
  function effOf(r: Row, date: string): Eff {
    const base = r.days[date];
    const lv = local[r.code]?.[date];
    if (lv === undefined || !('planned' in base)) return base;
    if (lv === null) {
      const p = r.policyId ? policyById.get(r.policyId) : null;
      return { k: p?.mode === 'remoto' ? 'T' : 'O', h: 0, planned: false };
    }
    return lv[0] === 'H' ? { k: 'H', h: Number(lv.slice(1)), planned: true } : { k: lv as DayKind, h: 0, planned: true };
  }

  // Indicadores del mes (sobre los empleados visibles)
  const todayOcc = d.view.occupancy[d.today];
  const twSum = rows.reduce((a, r) => a + r.twDays, 0);
  const offSum = rows.reduce((a, r) => a + r.officeDays, 0);
  const visibleCodes = new Set(rows.map((r) => r.code));
  const alerts = d.view.alerts.filter((a) => !a.employee || visibleCodes.has(a.employee));
  const occ = (date: string) => {
    let office = 0, remote = 0;
    for (const r of rows) { const e = effOf(r, date); if (e.k === 'T') remote++; else if (e.k === 'O' || e.k === 'H') office++; }
    return { office, remote };
  };
  const cap = d.settings.officeCapacity;
  const emp = openEmp ? d.view.rows.find((r) => r.code === openEmp) || null : null;

  return (
    <div className="col" style={{ gap: 16 }}>
      {d.warnings.map((w, i) => <div key={i} className="alert warn small">{w}</div>)}

      <div className="ev-kpis tw-kpis">
        <Kpi label="Hoy en la oficina" value={todayOcc ? `${todayOcc.office}${cap ? ` / ${cap}` : ''}` : '—'} hint={todayOcc ? `${todayOcc.remote} en teletrabajo · ${todayOcc.absent} ausentes` : 'Hoy no es de este mes'} bad={!!(cap && todayOcc && todayOcc.office > cap)} />
        <Kpi label="Teletrabajo del mes" value={`${twSum + offSum ? Math.round((twSum / (twSum + offSum)) * 100) : 0} %`} hint={`${num(twSum)} días de teletrabajo · ${num(offSum)} presenciales`} />
        <Kpi label="Bolsas superadas" value={String(rows.filter((r) => r.balance.exceeded).length)} hint={`de ${rows.length} empleados`} bad={rows.some((r) => r.balance.exceeded)} />
        <Kpi label="Avisos" value={String(alerts.length)} hint={showAlerts ? 'Ocultar la lista' : 'Ver la lista'} bad={alerts.some((a) => a.level === 'bad')} onClick={() => { setTab('plan'); setShowAlerts((v) => !v); }} />
      </div>

      <div className="tabs" role="tablist">
        {([['plan', 'Planificación', <Icon.calendar />], ['politicas', 'Políticas y empleados', <Icon.users />], ['informe', 'Informe anual', <Icon.file />], ['ajustes', 'Ajustes', <Icon.sliders />]] as [Tab, string, JSX.Element][]).map(([k, l, ico]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{ico}{l}</button>
        ))}
      </div>

      {tab === 'plan' && (
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="row" style={{ gap: 4 }}>
            <button className="icon-btn" aria-label="Mes anterior" onClick={() => setMonth(shiftMonth(month, -1))}><Icon.back /></button>
            <b style={{ minWidth: 150, textAlign: 'center', textTransform: 'capitalize' }}>{monthLabel(month)}</b>
            <button className="icon-btn" aria-label="Mes siguiente" onClick={() => setMonth(shiftMonth(month, 1))}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon.back /></span></button>
            {month !== d.today.slice(0, 7) && <button className="btn sm ghost" onClick={() => setMonth(d.today.slice(0, 7))}>Hoy</button>}
          </div>
          <select className="select" style={{ width: 'auto', minWidth: 180 }} value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Departamento">
            <option value="">Todos los departamentos</option>
            {d.departments.map((x) => <option key={x.code} value={x.code}>{x.description || x.code}</option>)}
          </select>
          <div className="search" style={{ minWidth: 200, flex: '1 1 200px', maxWidth: 320 }}><Icon.search /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar empleado…" /></div>
          <span className="grow" />
          <button className="btn sm" onClick={reload}><Icon.refresh /> Actualizar</button>
          {d.canEdit && <button className="btn sm primary" onClick={() => setPattern(true)}>Rellenar el mes</button>}
        </div>
      )}

      {tab === 'plan' && showAlerts && (
        <div className="card" style={{ gap: 8 }}>
          <div className="row"><h3 className="grow">Avisos del mes ({alerts.length})</h3><button className="icon-btn" aria-label="Cerrar avisos" onClick={() => setShowAlerts(false)}><Icon.x /></button></div>
          {!alerts.length && <span className="small muted">Todo en orden: sin bolsas superadas, aforo respetado, mínimos cubiertos y acuerdos al día.</span>}
          <div className="col" style={{ gap: 6, maxHeight: 260, overflowY: 'auto' }}>
            {alerts.slice(0, 120).map((a, i) => (
              <button key={i} className={`alert ${a.level === 'bad' ? 'error' : 'warn'} small tw-alert-row`} onClick={() => a.employee && setOpenEmp(a.employee)}>
                {a.employee && <b>{d.view.rows.find((r) => r.code === a.employee)?.name || a.employee} · </b>}{a.text}
              </button>
            ))}
          </div>
        </div>
      )}

      {tab === 'plan' && (
        <div className="card flat">
          <div className="ev-toolbar">
            {d.canEdit ? (
              <>
                <span className="xs muted" style={{ fontWeight: 600 }}>Pincel</span>
                <div className="viewseg" role="group" aria-label="Pincel">
                  {BRUSHES.map((b) => (
                    <button key={b.k} className={brush === b.k ? 'on' : ''} aria-pressed={brush === b.k} onClick={() => setBrush(b.k)}>
                      <span className={`tw-sw k-${b.k === 'clear' ? 'def' : b.k}`} />{b.label}
                    </button>
                  ))}
                </div>
                {brush === 'H' && (
                  <label className="row xs" style={{ gap: 6 }}>Horas de teletrabajo
                    <input className="input" type="number" min={0.5} max={12} step={0.5} value={hBrush} onChange={(e) => setHBrush(Math.max(0.5, Math.min(12, Number(e.target.value) || 4)))} style={{ width: 70, padding: '6px 8px' }} />
                  </label>
                )}
                <span className="xs muted">Haz clic o arrastra sobre los días. Se guarda solo y avisa si alguien se pasa de su bolsa.</span>
              </>
            ) : <span className="xs muted">Solo lectura</span>}
            <span className="grow" />
            <Legend />
          </div>
          <div className="table-wrap tw-grid-wrap">
            <table className="tw-grid">
              <thead>
                <tr>
                  <th className="tw-emp"><div className="tw-emp-in">Empleado · política</div></th>
                  {d.view.days.map((day) => {
                    const w = wd(day);
                    const off = !d.settings.workDays.includes(w) || holidays.has(day);
                    return <th key={day} className={`tw-dh${off ? ' off' : ''}${day === d.today ? ' today' : ''}`}><span>{WD[w - 1]}</span><b>{Number(day.slice(8))}</b></th>;
                  })}
                  <th className="tw-bal">Bolsa</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.code}>
                    <td className="tw-emp"><div className="tw-emp-in">
                      <div className="tw-name">
                        <button className="tw-name-btn" onClick={() => setOpenEmp(r.code)} title={`Ver el calendario de ${r.name}${r.department ? ` (${deptName.get(r.department) || r.department})` : ''}`}><b>{r.name}</b></button>
                        <PolicyPicker d={d} code={r.code} policyById={policyById} onPick={(pid) => assignQuick(r.code, pid)} />
                      </div>
                      {r.alerts.length > 0 && <span className="tw-alert" title={r.alerts.map((a) => a.text).join('\n')}>{r.alerts.length}</span>}
                    </div></td>
                    {d.view.days.map((day) => (
                      <td key={day} className="tw-dc">
                        <DayCell e={effOf(r, day)} today={d.today} date={day} holiday={holidays.has(day)}
                          onDown={d.canEdit ? () => { painting.current = true; paint(r.code, day); } : undefined}
                          onEnter={d.canEdit ? () => { if (painting.current) paint(r.code, day); } : undefined} />
                      </td>
                    ))}
                    <td className="tw-bal"><BalanceText b={r.balance} /></td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={d.view.days.length + 2} className="muted small" style={{ padding: 28, textAlign: 'center' }}>No hay empleados con este filtro.</td></tr>}
              </tbody>
              <tfoot>
                <tr>
                  <td className="tw-emp xs muted" style={{ fontWeight: 700 }}>En la oficina{cap ? ` (aforo ${cap})` : ''}</td>
                  {d.view.days.map((day) => {
                    const work = d.settings.workDays.includes(wd(day)) && !holidays.has(day);
                    const o = occ(day);
                    return <td key={day} className={`tw-occ${work && cap && o.office > cap ? ' over' : ''}`}>{work ? o.office : ''}</td>;
                  })}
                  <td />
                </tr>
                <tr>
                  <td className="tw-emp xs muted" style={{ fontWeight: 700 }}>En teletrabajo</td>
                  {d.view.days.map((day) => {
                    const work = d.settings.workDays.includes(wd(day)) && !holidays.has(day);
                    return <td key={day} className="tw-occ rem">{work ? occ(day).remote : ''}</td>;
                  })}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </div>
      )}

      {tab === 'politicas' && <Politicas d={d} deptName={deptName} onSaved={reload} />}
      {tab === 'informe' && <Informe initialYear={Number(month.slice(0, 4))} deptFilter={dept} />}
      {tab === 'ajustes' && <Ajustes d={d} onSaved={reload} />}

      {emp && (
        <EmployeeDrawer d={d} row={emp} effOf={effOf} brush={brush} setBrush={setBrush} hBrush={hBrush} paint={paint} holidays={holidays}
          onClose={() => setOpenEmp(null)} onAssign={() => setAssignFor([emp.code])}
          onGenerate={async () => {
            const r = await api.post<{ changed: number }>('/api/evalos/teletrabajo/patron', { employees: [emp.code], from: `${month}-01`, to: d.view.days[d.view.days.length - 1], usePolicy: true, overwrite: false });
            toast(`${r.changed} día(s) planificados según su política`);
            reload();
          }} />
      )}
      {pattern && (
        <PatternModal d={d} month={month} codes={rows.map((r) => r.code)} scopeLabel={`${rows.length} empleado(s) visibles${dept ? ` de ${deptName.get(dept) || dept}` : ''}`}
          onClose={() => setPattern(false)} onDone={(n) => { setPattern(false); toast(`${n} día(s) planificados`); reload(); }} />
      )}
      {assignFor && (
        <AssignModal d={d} codes={assignFor} names={assignFor.map((c) => d.view.rows.find((r) => r.code === c)?.name || c)}
          onClose={() => setAssignFor(null)} onDone={() => { setAssignFor(null); toast('Política asignada'); reload(); }} />
      )}
      {confirm && (
        <OverLimitModal warnings={confirm.warnings}
          onCancel={() => { discard(confirm.changes); setConfirm(null); }}
          onConfirm={() => { const c = confirm.changes; setConfirm(null); save(c); toast('Guardado igualmente'); }} />
      )}
    </div>
  );
}

/** Desplegable de política en la fila del empleado: cambiarla es elegir otra. */
function PolicyPicker({ d, code, policyById, onPick }: { d: Resp; code: string; policyById: Map<string, Policy>; onPick: (policyId: string) => void }) {
  const assigned = d.assignments[code]?.policyId || '';
  const def = d.settings.defaultPolicyId ? policyById.get(d.settings.defaultPolicyId) : null;
  const shown = assigned ? policyById.get(assigned) : def;
  return (
    <span className="tw-pick">
      <span className="tw-pol" style={{ background: shown?.color || '#9FA5AD' }} />
      {d.canEdit ? (
        <select value={assigned} onChange={(e) => onPick(e.target.value)} aria-label="Política de teletrabajo" title="Cambiar la política de teletrabajo">
          <option value="">{def ? `${def.name} (por defecto)` : 'Sin política'}</option>
          {d.policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      ) : <span className="xs muted">{shown?.name || 'Sin política'}</span>}
    </span>
  );
}

/** Ventana de aviso cuando un cambio supera la bolsa de teletrabajo, el mínimo presencial o el aforo. */
function OverLimitModal({ warnings, onCancel, onConfirm }: { warnings: ChangeWarning[]; onCancel: () => void; onConfirm: () => void }) {
  const quota = warnings.some((w) => w.kind === 'quota');
  const groups = new Map<string, ChangeWarning[]>();
  for (const w of warnings) { const k = w.name || 'Oficina'; if (!groups.has(k)) groups.set(k, []); groups.get(k)!.push(w); }
  return (
    <Modal title={quota ? 'Más teletrabajo del permitido' : 'Revisa antes de guardar'} onClose={onCancel}>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <span className="tw-warn-ico" aria-hidden="true">!</span>
        <span className="small" style={{ lineHeight: 1.5 }}>
          {quota ? 'Este cambio deja a alguien por encima de su bolsa de teletrabajo.' : 'Este cambio incumple alguna de las reglas de teletrabajo.'} ¿Quieres asignarlo igualmente?
        </span>
      </div>
      <div className="col" style={{ gap: 10 }}>
        {[...groups].map(([name, list]) => (
          <div key={name} className="col" style={{ gap: 4 }}>
            <b className="small">{name}</b>
            {list.map((w, i) => <div key={i} className={`alert ${w.level === 'bad' ? 'error' : 'warn'} small`}>{w.text}</div>)}
          </div>
        ))}
      </div>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={onCancel} autoFocus>Cancelar el cambio</button>
        <button className="btn primary" onClick={onConfirm}>Asignar igualmente</button>
      </div>
    </Modal>
  );
}

function Kpi({ label, value, hint, bad, onClick }: { label: string; value: string; hint: string; bad?: boolean; onClick?: () => void }) {
  return (
    <div className="card" style={{ gap: 2, padding: '14px 16px', cursor: onClick ? 'pointer' : undefined }} onClick={onClick}>
      <span className="xs muted" style={{ fontWeight: 600 }}>{label}</span>
      <span className="stat" style={{ color: bad ? 'var(--bad)' : undefined }}>{value}</span>
      <span className="xs muted ev-kpi-hint">{hint}</span>
    </div>
  );
}

function Legend() {
  const items: [string, string][] = [['O', 'Oficina'], ['T', 'Teletrabajo'], ['H', 'Mixto'], ['A', 'Ausencia'], ['F', 'Festivo']];
  return (
    <span className="row wrap" style={{ gap: 10 }}>
      {items.map(([k, l]) => <span key={k} className="row xs muted" style={{ gap: 4 }}><span className={`tw-sw k-${k}`} />{l}</span>)}
      <span className="row xs muted" style={{ gap: 4 }}><span className="tw-sw k-def" />Según política</span>
    </span>
  );
}

// ---------- Calendario de un empleado ----------
function EmployeeDrawer({ d, row, effOf, brush, setBrush, hBrush, paint, holidays, onClose, onAssign, onGenerate }: {
  d: Resp; row: Row; effOf: (r: Row, date: string) => Eff; brush: Brush; setBrush: (b: Brush) => void; hBrush: number;
  paint: (emp: string, date: string) => void; holidays: Set<string>; onClose: () => void; onAssign: () => void; onGenerate: () => Promise<void>;
}) {
  const a = d.assignments[row.code];
  const p = row.policyId ? d.policies.find((x) => x.id === row.policyId) : null;
  const b = row.balance;
  const first = d.view.days[0];
  const lead = wd(first) - 1;
  const [busy, setBusy] = useState(false);
  return (
    <Drawer title={<div className="col" style={{ gap: 2 }}><h2>{row.name}</h2><span className="xs muted mono">{row.code}{row.department ? ` · ${row.department}` : ''}</span></div>} onClose={onClose}>
      <div className="row wrap" style={{ gap: 8 }}>
        <span className="tag" style={{ background: p ? `${p.color}22` : undefined, color: p?.color }}>{p?.name || 'Sin política'}</span>
        {a?.agreementSigned ? <span className="tag ok">Acuerdo firmado{a.agreementDate ? ` · ${fmt(a.agreementDate)}` : ''}</span> : <span className="tag outline">Sin acuerdo de teletrabajo</span>}
        {a && <span className="tag outline">Desde {fmt(a.from)}{a.to ? ` hasta ${fmt(a.to)}` : ''}</span>}
        {d.canEdit && <button className="btn sm" onClick={onAssign}>Cambiar política</button>}
      </div>

      <div className="grid-3" style={{ gap: 10 }}>
        <Mini label={`Bolsa (${b.period ? PERIOD_LABEL[b.period] : '—'})`} value={b.allowance === null ? '∞' : `${num(b.available!)} ${unitLabel(b.unit, b.available!)}`} sub={b.allowance === null ? 'Sin límite' : `de ${num(b.allowance + b.carry)}${b.carry ? ` (arrastre ${num(b.carry)})` : ''}`} bad={b.exceeded} />
        <Mini label="Teletrabajo 3 meses" value={`${row.legalPct} %`} sub={`umbral legal ${d.settings.legalThresholdPct} %`} bad={row.legalPct >= d.settings.legalThresholdPct && !row.agreementSigned} />
        <Mini label="Este mes" value={`${num(row.twDays)} días`} sub={`${num(row.officeDays)} presenciales${d.settings.allowancePerDay ? ` · ${num(row.compensation)} €` : ''}`} />
      </div>
      {b.allowance !== null && b.mode === 'hibrido' && (
        <span className="xs muted">Periodo {fmt(b.from)} – {fmt(b.to)}: consumido {num(b.used)}, planificado {num(b.planned)} {unitLabel(b.unit, 2)}.</span>
      )}
      {row.alerts.map((x, i) => <div key={i} className={`alert ${x.level === 'bad' ? 'error' : 'warn'} small`}>{x.text}</div>)}

      {d.canEdit && (
        <div className="row wrap" style={{ gap: 8 }}>
          <div className="viewseg" role="group" aria-label="Pincel">
            {BRUSHES.map((x) => <button key={x.k} className={brush === x.k ? 'on' : ''} onClick={() => setBrush(x.k)}><span className={`tw-sw k-${x.k === 'clear' ? 'def' : x.k}`} />{x.label}{x.k === 'H' ? ` ${hBrush}h` : ''}</button>)}
          </div>
          <button className="btn sm" disabled={busy} onClick={async () => { setBusy(true); try { await onGenerate(); } finally { setBusy(false); } }}>{busy ? 'Generando…' : 'Rellenar el mes según su política'}</button>
        </div>
      )}
      <div className="tw-cal">
        {WD.map((w) => <span key={w} className="tw-cal-h">{w}</span>)}
        {Array.from({ length: lead }).map((_, i) => <span key={`l${i}`} />)}
        {d.view.days.map((day) => (
          <DayCell key={day} big e={effOf(row, day)} today={d.today} date={day} holiday={holidays.has(day)} onDown={d.canEdit ? () => paint(row.code, day) : undefined} />
        ))}
      </div>
      {a?.notes && <div className="alert info small">{a.notes}</div>}
    </Drawer>
  );
}

function Mini({ label, value, sub, bad }: { label: string; value: string; sub: string; bad?: boolean }) {
  return (
    <div className="ev-mini">
      <span className="xs muted" style={{ fontWeight: 600 }}>{label}</span>
      <b style={{ color: bad ? 'var(--bad)' : undefined }}>{value}</b>
      <span className="xs muted">{sub}</span>
    </div>
  );
}

// ---------- Aplicar patrón ----------
function PatternModal({ d, month, codes, scopeLabel, onClose, onDone }: { d: Resp; month: string; codes: string[]; scopeLabel: string; onClose: () => void; onDone: (n: number) => void }) {
  const [from, setFrom] = useState(`${month}-01`);
  const [to, setTo] = useState(d.view.days[d.view.days.length - 1]);
  const [usePolicy, setUsePolicy] = useState(true);
  const [overwrite, setOverwrite] = useState(false);
  const [pat, setPat] = useState<Record<number, string>>({ 1: 'O', 2: 'O', 3: 'O', 4: 'O', 5: 'O' });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function run() {
    setBusy(true); setErr(null);
    try {
      const pattern: Record<string, string> = {};
      for (const [k, v] of Object.entries(pat)) if (v) pattern[k] = v;
      const r = await api.post<{ changed: number }>('/api/evalos/teletrabajo/patron', { employees: codes, from, to, usePolicy, pattern, overwrite });
      onDone(r.changed);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title="Aplicar patrón semanal" onClose={onClose}>
      <span className="small muted" style={{ marginTop: -8 }}>A {scopeLabel}. Los festivos, ausencias y días no laborables no se tocan.</span>
      <ErrorBox error={err} />
      <div className="grid-2">
        <label className="field">Desde<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">Hasta<input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="col" style={{ gap: 8 }}>
        <label className="check"><input type="radio" checked={usePolicy} onChange={() => setUsePolicy(true)} /> Según la política de cada empleado (sus días preferentes en teletrabajo)</label>
        <label className="check"><input type="radio" checked={!usePolicy} onChange={() => setUsePolicy(false)} /> Patrón personalizado</label>
      </div>
      {!usePolicy && (
        <div className="tw-pattern">
          {WD_LONG.map((w, i) => (
            <label key={w} className="field">{w}
              <select className="select" value={pat[i + 1] || ''} onChange={(e) => setPat({ ...pat, [i + 1]: e.target.value })}>
                <option value="">No tocar</option>
                <option value="O">Oficina</option>
                <option value="T">Teletrabajo</option>
                <option value="H4">Mixto (4 h teletrabajo)</option>
                <option value="clear">Según política</option>
              </select>
            </label>
          ))}
        </div>
      )}
      <label className="check"><input type="checkbox" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} /> Sobrescribir los días ya planificados</label>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn ghost" onClick={onClose}>Cancelar</button>
        <button className="btn primary" disabled={busy || !from || !to} onClick={run}>{busy ? 'Aplicando…' : 'Aplicar'}</button>
      </div>
    </Modal>
  );
}

// ---------- Asignar política ----------
function AssignModal({ d, codes, names, onClose, onDone }: { d: Resp; codes: string[]; names: string[]; onClose: () => void; onDone: () => void }) {
  const cur = codes.length === 1 ? d.assignments[codes[0]] : undefined;
  const [policyId, setPolicyId] = useState(cur?.policyId || d.policies.find((p) => p.mode === 'hibrido')?.id || d.policies[0]?.id || '');
  const [from, setFrom] = useState(cur?.from || d.today);
  const [to, setTo] = useState(cur?.to || '');
  const [signed, setSigned] = useState(!!cur?.agreementSigned);
  const [signedAt, setSignedAt] = useState(cur?.agreementDate || '');
  const [notes, setNotes] = useState(cur?.notes || '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const p = d.policies.find((x) => x.id === policyId);
  async function save(remove = false) {
    setBusy(true); setErr(null);
    try {
      await api.put('/api/evalos/teletrabajo/asignaciones', { codes, assignment: remove ? null : { policyId, from, to, agreementSigned: signed, agreementDate: signedAt, notes } });
      onDone();
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={codes.length === 1 ? `Política de ${names[0]}` : `Asignar política a ${codes.length} empleados`} onClose={onClose}>
      <ErrorBox error={err} />
      <label className="field">Política
        <select className="select" value={policyId} onChange={(e) => setPolicyId(e.target.value)}>
          {d.policies.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
        </select>
        {p && <span className="hint">{policySummary(p)}</span>}
      </label>
      <div className="grid-2">
        <label className="field">Vigente desde<input className="input" type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">Hasta<span className="hint">Vacío = indefinida</span><input className="input" type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <div className="col" style={{ gap: 6 }}>
        <label className="check"><input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> Acuerdo de trabajo a distancia firmado</label>
        <span className="xs muted" style={{ marginLeft: 26 }}>Obligatorio por la Ley 10/2021 cuando el teletrabajo supera el {d.settings.legalThresholdPct} % de la jornada en 3 meses.</span>
        {signed && <label className="field" style={{ marginLeft: 26, maxWidth: 220 }}>Fecha de firma<input className="input" type="date" value={signedAt} onChange={(e) => setSignedAt(e.target.value)} /></label>}
      </div>
      <label className="field">Notas<textarea className="textarea" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="Lugar de teletrabajo, equipos entregados, condiciones…" /></label>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        {cur ? <button className="btn danger sm" disabled={busy} onClick={() => save(true)}>Quitar política</button> : <span />}
        <div className="row"><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || !policyId} onClick={() => save()}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
      </div>
    </Modal>
  );
}

/** «oct 2026», «sem. 12/10», «T4 2026», «2026». */
function periodShort(b: Balance) {
  if (!b.period) return '—';
  const [y, m] = b.from.split('-').map(Number);
  if (b.period === 'week') return `sem. ${b.from.slice(8)}/${b.from.slice(5, 7)}`;
  if (b.period === 'month') return `${MONTHS[m - 1].slice(0, 3)} ${y}`;
  if (b.period === 'quarter') return `T${Math.floor((m - 1) / 3) + 1} ${y}`;
  return String(y);
}

function policySummary(p: Policy) {
  if (p.mode === 'presencial') return 'Siempre presencial.';
  if (p.mode === 'remoto') return 'Teletrabajo todos los días laborables, sin límite.';
  const dias = p.preferredDays.length ? ` Preferentes: ${p.preferredDays.map((n) => WD_LONG[n - 1].toLowerCase()).join(', ')}.` : '';
  const min = p.minOfficeDaysWeek ? ` Mínimo ${p.minOfficeDaysWeek} día(s) presencial(es) por semana.` : '';
  return `${num(p.amount)} ${p.unit === 'days' ? 'días' : 'horas'} de teletrabajo por ${PERIOD_LABEL[p.period]}.${dias}${min}`;
}

// ---------- Políticas ----------
function Politicas({ d, deptName, onSaved }: { d: Resp; deptName: Map<string, string>; onSaved: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<Policy[]>(() => d.policies.map((p) => ({ ...p })));
  const [pickFor, setPickFor] = useState<Policy | null>(null);
  useEffect(() => { setList(d.policies.map((p) => ({ ...p }))); }, [d.policies]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const used = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of Object.values(d.assignments)) m.set(a.policyId, (m.get(a.policyId) || 0) + 1);
    return m;
  }, [d]);
  const upd = (i: number, p: Partial<Policy>) => setList(list.map((x, j) => (j === i ? { ...x, ...p } : x)));
  async function save() {
    setBusy(true); setErr(null);
    try { await api.put('/api/evalos/teletrabajo/politicas', { policies: list }); toast('Políticas guardadas'); onSaved(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  const ro = !d.canAdmin;
  return (
    <div className="col" style={{ gap: 14 }}>
      <span className="small muted">Define cuánto teletrabajo tiene cada tipo de puesto y asígnalo a los empleados con «Asignar empleados». También puedes cambiar la política de una persona desde su fila en Planificación. {ro ? 'Solo un administrador de Atajos de Evalos puede modificar las políticas.' : ''}</span>
      <ErrorBox error={err} />
      <div className="tw-policies">
        {list.map((p, i) => (
          <fieldset key={p.id} disabled={ro} className="card" style={{ gap: 12, borderLeft: `4px solid ${p.color}` }}>
            <div className="row" style={{ gap: 8 }}>
              <input className="input grow" value={p.name} onChange={(e) => upd(i, { name: e.target.value })} aria-label="Nombre" style={{ fontWeight: 700 }} />
              <input type="color" value={p.color} onChange={(e) => upd(i, { color: e.target.value })} aria-label="Color" style={{ width: 38, height: 38, border: 0, background: 'none', padding: 0 }} />
              {!ro && <button className="icon-btn" aria-label="Eliminar política" title={used.get(p.id) ? `Asignada a ${used.get(p.id)} empleado(s)` : 'Eliminar'} disabled={!!used.get(p.id) || list.length < 2} onClick={() => setList(list.filter((_, j) => j !== i))}><Icon.trash /></button>}
            </div>
            <div className="viewseg" role="group" aria-label="Modalidad" style={{ alignSelf: 'flex-start' }}>
              {(['presencial', 'hibrido', 'remoto'] as Mode[]).map((m) => <button key={m} className={p.mode === m ? 'on' : ''} onClick={() => upd(i, { mode: m })}>{MODE_LABEL[m]}</button>)}
            </div>
            {p.mode === 'hibrido' && (
              <div className="row wrap" style={{ gap: 8 }}>
                <input className="input" type="number" min={0} step={p.unit === 'days' ? 0.5 : 1} value={p.amount} onChange={(e) => upd(i, { amount: Number(e.target.value) })} style={{ width: 90 }} aria-label="Cupo" />
                <select className="select" style={{ width: 'auto' }} value={p.unit} onChange={(e) => upd(i, { unit: e.target.value as Unit })} aria-label="Unidad"><option value="days">días</option><option value="hours">horas</option></select>
                <span className="small">de teletrabajo por</span>
                <select className="select" style={{ width: 'auto' }} value={p.period} onChange={(e) => upd(i, { period: e.target.value as Period })} aria-label="Periodo">
                  <option value="week">semana</option><option value="month">mes</option><option value="quarter">trimestre</option><option value="year">año</option>
                </select>
              </div>
            )}
            {p.mode !== 'presencial' && (
              <div className="field">Días preferentes de teletrabajo
                <div className="row" style={{ gap: 4 }}>
                  {WD.map((w, k) => {
                    const on = p.preferredDays.includes(k + 1);
                    return <button key={w} type="button" className={`tw-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => upd(i, { preferredDays: on ? p.preferredDays.filter((x) => x !== k + 1) : [...p.preferredDays, k + 1].sort() })}>{w}</button>;
                  })}
                </div>
              </div>
            )}
            <div className="grid-2" style={{ gap: 10 }}>
              <label className="field">Mínimo presencial / semana<input className="input" type="number" min={0} max={7} value={p.minOfficeDaysWeek} onChange={(e) => upd(i, { minOfficeDaysWeek: Number(e.target.value) })} /></label>
              <label className="field">Jornada (horas/día)<input className="input" type="number" min={1} max={24} step={0.5} value={p.hoursPerDay} onChange={(e) => upd(i, { hoursPerDay: Number(e.target.value) })} /></label>
            </div>
            <span className="xs muted">{policySummary(p)}</span>
            <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line-2)', paddingTop: 10 }}>
              <span className="small"><b>{used.get(p.id) || 0}</b> empleado(s){d.settings.defaultPolicyId === p.id ? ' + los que no tienen política (por defecto)' : ''}</span>
              {d.canEdit && (d.policies.some((x) => x.id === p.id)
                ? <button type="button" className="btn sm" onClick={() => setPickFor(p)}><Icon.users /> Asignar empleados</button>
                : <span className="xs muted">Guarda para poder asignarla</span>)}
            </div>
          </fieldset>
        ))}
      </div>
      {!ro && (
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <button className="btn" onClick={() => setList([...list, { id: `p${Date.now().toString(36)}`, name: 'Nueva política', mode: 'hibrido', unit: 'days', amount: 2, period: 'week', preferredDays: [], minOfficeDaysWeek: 0, hoursPerDay: 8, color: '#31506A' }])}><Icon.plus /> Nueva política</button>
          <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar políticas'}</button>
        </div>
      )}
      {pickFor && <AssignEmployeesModal d={d} policy={pickFor} deptName={deptName} onClose={() => setPickFor(null)} onDone={(n) => { setPickFor(null); toast(n ? `${n} cambio(s) de política guardados` : 'Sin cambios'); onSaved(); }} />}
    </div>
  );
}

/** Elegir qué empleados tienen una política: lista por departamento con casillas. */
function AssignEmployeesModal({ d, policy, deptName, onClose, onDone }: { d: Resp; policy: Policy; deptName: Map<string, string>; onClose: () => void; onDone: (changes: number) => void }) {
  const initial = useMemo(() => new Set(d.view.rows.filter((r) => d.assignments[r.code]?.policyId === policy.id).map((r) => r.code)), [d, policy]);
  const [sel, setSel] = useState<Set<string>>(() => new Set(initial));
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pname = new Map(d.policies.map((p) => [p.id, p.name]));
  const s = q.trim().toLowerCase();
  const groups = new Map<string, Row[]>();
  for (const r of d.view.rows) {
    if (s && !r.name.toLowerCase().includes(s) && !r.code.toLowerCase().includes(s)) continue;
    const k = r.department || '';
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }
  const toggle = (codes: string[], on: boolean) => { const n = new Set(sel); codes.forEach((c) => (on ? n.add(c) : n.delete(c))); setSel(n); };
  const added = [...sel].filter((c) => !initial.has(c));
  const removed = [...initial].filter((c) => !sel.has(c));
  async function save() {
    setBusy(true); setErr(null);
    try {
      if (added.length) await api.put('/api/evalos/teletrabajo/asignaciones', { codes: added, keepExisting: true, assignment: { policyId: policy.id, from: `${d.today.slice(0, 4)}-01-01` } });
      if (removed.length) await api.put('/api/evalos/teletrabajo/asignaciones', { codes: removed, assignment: null });
      onDone(added.length + removed.length);
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Modal title={`Empleados con «${policy.name}»`} onClose={onClose} wide>
      <span className="small muted" style={{ marginTop: -8 }}>Marca quién tiene esta política. Al desmarcar a alguien vuelve a la política por defecto. Se conservan sus acuerdos de teletrabajo.</span>
      <ErrorBox error={err} />
      <div className="search"><Icon.search /><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar empleado…" autoFocus /></div>
      <div className="col" style={{ gap: 14, maxHeight: '52vh', overflowY: 'auto', paddingRight: 4 }}>
        {[...groups].map(([dep, list]) => {
          const all = list.every((r) => sel.has(r.code));
          return (
            <div key={dep} className="col" style={{ gap: 6 }}>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <b className="small">{deptName.get(dep) || dep || 'Sin departamento'} <span className="muted xs">({list.length})</span></b>
                <button type="button" className="btn sm ghost" onClick={() => toggle(list.map((r) => r.code), !all)}>{all ? 'Quitar todo el departamento' : 'Todo el departamento'}</button>
              </div>
              <div className="tw-pick-grid">
                {list.map((r) => {
                  const other = d.assignments[r.code]?.policyId;
                  return (
                    <label key={r.code} className={`tw-pick-emp${sel.has(r.code) ? ' on' : ''}`}>
                      <input type="checkbox" checked={sel.has(r.code)} onChange={(e) => toggle([r.code], e.target.checked)} />
                      <span className="col" style={{ gap: 0, minWidth: 0 }}>
                        <span className="small" style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
                        <span className="xs muted">{other && other !== policy.id ? `Ahora: ${pname.get(other) || other}` : other === policy.id ? 'Ya la tiene' : 'Por defecto'}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="xs muted">{sel.size} marcado(s){added.length || removed.length ? ` · ${added.length} a añadir, ${removed.length} a quitar` : ''}</span>
        <div className="row"><button className="btn ghost" onClick={onClose}>Cancelar</button><button className="btn primary" disabled={busy || (!added.length && !removed.length)} onClick={save}>{busy ? 'Guardando…' : 'Guardar'}</button></div>
      </div>
    </Modal>
  );
}

// ---------- Informe anual ----------
function Informe({ initialYear, deptFilter }: { initialYear: number; deptFilter: string }) {
  const [year, setYear] = useState(initialYear);
  const { data, error } = useData(() => api.get<{ year: number; rows: ReportRow[]; allowancePerDay: number; departments: { code: string; description: string }[] }>(`/api/evalos/teletrabajo/informe?year=${year}`), [year]);
  if (error && !data) return <ErrorBox error={error} />;
  if (!data) return <Loading />;
  const rows = data.rows.filter((r) => !deptFilter || r.department === deptFilter);
  const dn = new Map(data.departments.map((x) => [x.code, x.description]));
  const tot = rows.reduce((a, r) => ({ tw: a.tw + r.twDays, off: a.off + r.officeDays, comp: a.comp + r.compensation, abs: a.abs + r.absentDays }), { tw: 0, off: 0, comp: 0, abs: 0 });
  function exportCsv() {
    const head = ['Código', 'Empleado', 'Departamento', 'Política', 'Días teletrabajo', 'Días presenciales', 'Días ausencia', 'Horas teletrabajo', '% teletrabajo', 'Compensación (€)', 'Acuerdo firmado', 'Fecha acuerdo'];
    const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head.map(esc).join(';'), ...rows.map((r) => [r.code, r.name, dn.get(r.department) || r.department, r.policy, num(r.twDays), num(r.officeDays), r.absentDays, num(r.twHours), num(r.pct), num(r.compensation), r.agreementSigned ? 'Sí' : 'No', fmt(r.agreementDate)].map(esc).join(';'))];
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `teletrabajo-${year}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  return (
    <div className="card flat">
      <div className="ev-toolbar">
        <button className="icon-btn" aria-label="Año anterior" onClick={() => setYear(year - 1)}><Icon.back /></button>
        <b>{year}</b>
        <button className="icon-btn" aria-label="Año siguiente" onClick={() => setYear(year + 1)}><span style={{ display: 'inline-flex', transform: 'rotate(180deg)' }}><Icon.back /></span></button>
        <span className="xs muted">{rows.length} empleado(s) · {num(tot.tw)} días de teletrabajo · {num(tot.off)} presenciales{data.allowancePerDay ? ` · ${num(tot.comp)} € de compensación` : ''}</span>
        <span className="grow" />
        <button className="btn sm" onClick={exportCsv}>Exportar a Excel (CSV)</button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Empleado</th><th>Política actual</th><th style={{ textAlign: 'right' }}>Teletrabajo</th><th style={{ textAlign: 'right' }}>Presencial</th><th style={{ textAlign: 'right' }}>Ausencias</th><th style={{ minWidth: 150 }}>% teletrabajo</th>{data.allowancePerDay > 0 && <th style={{ textAlign: 'right' }}>Compensación</th>}<th>Acuerdo</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.code}>
                <td><b className="small">{r.name}</b><div className="xs muted">{dn.get(r.department) || r.department}</div></td>
                <td className="small">{r.policy}</td>
                <td className="small" style={{ textAlign: 'right' }}>{num(r.twDays)} d</td>
                <td className="small" style={{ textAlign: 'right' }}>{num(r.officeDays)} d</td>
                <td className="small" style={{ textAlign: 'right' }}>{r.absentDays}</td>
                <td><span className="row" style={{ gap: 8 }}><Meter value={r.pct} max={100} /><span className="xs" style={{ fontWeight: 600 }}>{num(r.pct)} %</span></span></td>
                {data.allowancePerDay > 0 && <td className="small" style={{ textAlign: 'right' }}>{num(r.compensation)} €</td>}
                <td>{r.agreementSigned ? <span className="tag ok">Firmado{r.agreementDate ? ` ${fmt(r.agreementDate)}` : ''}</span> : <span className="tag outline">No</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------- Ajustes ----------
function Ajustes({ d, onSaved }: { d: Resp; onSaved: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<Settings>({ ...d.settings, minOfficeByDept: { ...d.settings.minOfficeByDept } });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ro = !d.canAdmin;
  async function save() {
    setBusy(true); setErr(null);
    try { await api.put('/api/evalos/teletrabajo/ajustes', { settings: s }); toast('Ajustes guardados'); onSaved(); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <fieldset disabled={ro} className="col" style={{ gap: 14, border: 0, padding: 0, margin: 0 }}>
      {ro && <div className="alert info small">Solo un administrador de Atajos de Evalos puede cambiar los ajustes.</div>}
      <ErrorBox error={err} />
      <Fold id="tw-oficina" title="Oficina" icon={<Icon.building />} defaultOpen
        summary={`Aforo ${s.officeCapacity ?? 'sin límite'} · ${s.workDays.map((k) => WD[k - 1]).join(' ')}${s.calendarCode ? ` · calendario ${s.calendarCode}` : ''}`}>
        <div className="grid-3">
          <label className="field">Aforo (puestos)<span className="hint">Avisa si se planifica más gente. Vacío = sin límite.</span>
            <input className="input" type="number" min={0} value={s.officeCapacity ?? ''} onChange={(e) => setS({ ...s, officeCapacity: e.target.value === '' ? null : Number(e.target.value) })} />
          </label>
          <label className="field">Calendario de festivos<span className="hint">Sus festivos no cuentan como laborables.</span>
            <select className="select" value={s.calendarCode || ''} onChange={(e) => setS({ ...s, calendarCode: e.target.value || undefined })}>
              <option value="">Ninguno</option>
              {d.calendars.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.year})</option>)}
            </select>
          </label>
          <div className="field">Días laborables
            <div className="row" style={{ gap: 4 }}>
              {WD.map((w, k) => { const on = s.workDays.includes(k + 1); return <button key={w} type="button" className={`tw-chip${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setS({ ...s, workDays: on ? s.workDays.filter((x) => x !== k + 1) : [...s.workDays, k + 1].sort() })}>{w}</button>; })}
            </div>
          </div>
        </div>
      </Fold>
      <Fold id="tw-bolsas" title="Bolsas y cumplimiento" icon={<Icon.briefcase />}
        summary={`Por defecto: ${d.policies.find((p) => p.id === s.defaultPolicyId)?.name || '—'} · umbral ${s.legalThresholdPct} % · ${s.allowancePerDay} €/día${s.carryOver ? ` · arrastre máx. ${s.maxCarryOver}` : ''}`}>
        <div className="grid-3">
          <label className="field">Política por defecto<span className="hint">Para empleados sin política asignada.</span>
            <select className="select" value={s.defaultPolicyId || ''} onChange={(e) => setS({ ...s, defaultPolicyId: e.target.value })}>
              {d.policies.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <label className="field">Compensación de gastos (€ por día)<span className="hint">Ley 10/2021, art. 12. 0 = no se calcula.</span>
            <input className="input" type="number" min={0} step={0.5} value={s.allowancePerDay} onChange={(e) => setS({ ...s, allowancePerDay: Number(e.target.value) })} />
          </label>
          <label className="field">Umbral de teletrabajo regular (%)<span className="hint">Ley 10/2021: 30 % de la jornada en 3 meses.</span>
            <input className="input" type="number" min={1} max={100} value={s.legalThresholdPct} onChange={(e) => setS({ ...s, legalThresholdPct: Number(e.target.value) })} />
          </label>
        </div>
        <div className="row wrap" style={{ gap: 12 }}>
          <Toggle on={s.carryOver} onChange={(v) => setS({ ...s, carryOver: v })} label="Arrastre" />
          <div className="col grow" style={{ gap: 0 }}>
            <span className="small" style={{ fontWeight: 600 }}>Arrastrar el cupo no gastado al periodo siguiente</span>
            <span className="xs muted">Solo en políticas mensuales, trimestrales o anuales.</span>
          </div>
          {s.carryOver && <label className="field" style={{ width: 180 }}>Máximo a arrastrar<input className="input" type="number" min={0} value={s.maxCarryOver} onChange={(e) => setS({ ...s, maxCarryOver: Number(e.target.value) })} /></label>}
        </div>
      </Fold>
      <Fold id="tw-minimos" title="Mínimo de personas en la oficina por departamento" icon={<Icon.users />}
        subtitle="Avisa los días en que un departamento queda por debajo del mínimo presencial. 0 = sin mínimo."
        summary={(() => { const n = Object.values(s.minOfficeByDept).filter((v) => v > 0).length; return n ? `${n} departamento${n === 1 ? '' : 's'} con mínimo` : 'Sin mínimos definidos'; })()}>
        <div className="tw-depts">
          {d.departments.map((x) => (
            <label key={x.code} className="row small" style={{ justifyContent: 'space-between', gap: 8 }}>
              <span>{x.description || x.code}</span>
              <input className="input" type="number" min={0} style={{ width: 80, padding: '6px 8px' }} value={s.minOfficeByDept[x.code] || ''} placeholder="0"
                onChange={(e) => setS({ ...s, minOfficeByDept: { ...s.minOfficeByDept, [x.code]: Number(e.target.value) || 0 } })} />
            </label>
          ))}
          {!d.departments.length && <span className="small muted">No hay departamentos en Evalos.</span>}
        </div>
      </Fold>
      {!ro && <div className="row" style={{ justifyContent: 'flex-end' }}><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button></div>}
    </fieldset>
  );
}

// ---------- Widget del Inicio ----------
type Who = 'O' | 'T' | 'H' | 'A';
interface HoyDay { date: string; office: number; remote: number; absent: number; who: Record<string, Who>; hours: Record<string, number> }
interface Hoy {
  today: string; workday: boolean; office: number; remote: number; absent: number; capacity: number | null; employees: number; alerts: number; exceeded: number;
  next: { date: string; office: number; remote: number }[];
  days?: HoyDay[]; people?: { code: string; name: string; department: string }[];
  topAlerts?: { level: 'warn' | 'bad' | 'info'; employee?: string; name?: string; date?: string; text: string }[];
  canEdit?: boolean;
}
const ChevR = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;
const WHO_GROUPS: { k: Who; label: string }[] = [
  { k: 'T', label: 'En teletrabajo' }, { k: 'O', label: 'En la oficina' }, { k: 'H', label: 'Mixto' }, { k: 'A', label: 'Ausentes' }
];
/** Nombre corto para las fichas: «ÁLVAREZ TORRES, ANA» o «Ana Álvarez Torres» → «Ana Álvarez». */
function shortName(n: string) {
  const [sur, given] = n.includes(',') && n.split(',')[1].trim() ? n.split(',').map((x) => x.trim()) : ['', n.replace(',', ' ').trim()];
  const s = sur ? `${given.split(/\s+/)[0]} ${sur.split(/\s+/)[0]}` : given.split(/\s+/).slice(0, 2).join(' ');
  return s === s.toUpperCase() ? s.toLowerCase().replace(/(^|\s)\p{L}/gu, (c) => c.toUpperCase()) : s;
}
const empLink = (code: string, date: string) => `/evalos/teletrabajo?emp=${encodeURIComponent(code)}&month=${date.slice(0, 7)}`;

export function TeletrabajoWidget() {
  const { data, error } = useData(() => api.get<Hoy>('/api/evalos/teletrabajo/hoy').catch((e) => {
    if (e instanceof ApiError && e.code === 'not_configured') return null;
    throw e;
  }));
  const [sel, setSel] = useState<string | null>(null);
  const [expand, setExpand] = useState<Who | null>(null);
  if (error) return <ErrorBox error={error} />;
  if (data === null) return <NotConfigured compact />;
  if (!data) return <Loading />;
  const days = data.days || [];
  const bars = days.length ? days : data.next.map((n) => ({ ...n, absent: 0, who: {}, hours: {} }));
  const max = Math.max(1, ...bars.map((n) => n.office + n.remote));
  const day = days.find((x) => x.date === sel) || days[0];
  const people = new Map((data.people || []).map((p) => [p.code, p]));
  const isToday = day?.date === data.today;
  const dayLabel = day ? (isToday ? 'hoy' : `el ${WD_LONG[wd(day.date) - 1].toLowerCase()} ${Number(day.date.slice(8))}`) : '';
  const overCap = !!(data.capacity && day && day.office > data.capacity);
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <div className={`ev-mini grow${overCap ? ' alert' : ''}`}><span className="xs muted" style={{ fontWeight: 600 }}>{isToday || !day ? 'Hoy en la oficina' : `Oficina · ${WD[wd(day.date) - 1]} ${Number(day.date.slice(8))}`}</span><b>{day ? `${day.office}${data.capacity ? ` / ${data.capacity}` : ''}` : data.workday ? data.office : '—'}</b></div>
        <div className="ev-mini grow"><span className="xs muted" style={{ fontWeight: 600 }}>En teletrabajo</span><b>{day ? day.remote : data.workday ? data.remote : '—'}</b></div>
        <div className={`ev-mini grow${data.alerts ? ' alert' : ''}`}><span className="xs muted" style={{ fontWeight: 600 }}>Avisos</span><b>{data.alerts}</b></div>
      </div>

      <div className="tw-week" role="tablist" aria-label="Días">
        {bars.map((n) => {
          const on = day?.date === n.date;
          return (
            <button key={n.date} type="button" role="tab" aria-selected={on} className={`tw-wday${on ? ' on' : ''}`} disabled={!days.length}
              onClick={() => { setSel(n.date); setExpand(null); }} title={`${n.office} en oficina · ${n.remote} en teletrabajo`}>
              <div className="tw-bar"><span className="o" style={{ height: `${(n.office / max) * 100}%` }} /><span className="t" style={{ height: `${(n.remote / max) * 100}%` }} /></div>
              <span className="xs">{n.date === data.today ? 'Hoy' : `${WD[wd(n.date) - 1]} ${Number(n.date.slice(8))}`}</span>
            </button>
          );
        })}
      </div>

      {day && (
        <div className="col" style={{ gap: 8 }}>
          <span className="xs muted" style={{ fontWeight: 600 }}>Quién está {dayLabel}</span>
          {WHO_GROUPS.map(({ k, label }) => {
            const codes = Object.keys(day.who).filter((c) => day.who[c] === k)
              .sort((a, b) => (people.get(a)?.name || a).localeCompare(people.get(b)?.name || b, 'es'));
            if (!codes.length) return null;
            const LIMIT = 8;
            const shown = expand === k ? codes : codes.slice(0, LIMIT);
            return (
              <div key={k} className="tw-who">
                <span className="tw-who-h"><span className={`tw-sw k-${k}`} />{label} <b>{codes.length}</b></span>
                <div className="tw-who-list">
                  {shown.map((c) => {
                    const p = people.get(c);
                    return (
                      <Link key={c} to={empLink(c, day.date)} className="tw-who-chip" title={`${p?.name || c}${p?.department ? ` · ${p.department}` : ''}${k === 'H' ? ` · ${day.hours[c]} h de teletrabajo` : ''}`}>
                        {shortName(p?.name || c)}{k === 'H' && <span className="muted"> {day.hours[c]}h</span>}
                      </Link>
                    );
                  })}
                  {codes.length > LIMIT && (
                    <button type="button" className="tw-who-chip more" onClick={() => setExpand(expand === k ? null : k)}>
                      {expand === k ? 'Ver menos' : `+${codes.length - LIMIT} más`}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
          {!Object.keys(day.who).length && <div className="w-empty">Nadie con planificación para {dayLabel}.</div>}
        </div>
      )}

      {!!data.topAlerts?.length && (
        <div className="w-list">
          {data.topAlerts.slice(0, 3).map((a, i) => (
            <Link key={i} to={a.employee ? empLink(a.employee, a.date || data.today) : '/evalos/teletrabajo?alerts=1'} className="w-row">
              <span className="w-row-main"><b>{a.name || 'Oficina'}</b><span className="xs muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.text}</span></span>
              <span className={`tag ${a.level === 'bad' ? 'bad' : 'warn'}`}>{a.level === 'bad' ? 'Urgente' : 'Aviso'}</span>
              <span className="chev-r"><ChevR /></span>
            </Link>
          ))}
        </div>
      )}

      <div className="w-quick">
        <Link to="/evalos/teletrabajo"><Icon.calendar /> Planificación</Link>
        {data.alerts > 0 && <Link to="/evalos/teletrabajo?alerts=1"><Icon.ext /> Ver los {data.alerts} avisos</Link>}
        {data.canEdit && <Link to="/evalos/teletrabajo?pattern=1"><Icon.plus /> Rellenar el mes</Link>}
      </div>
      {data.exceeded > 0 && <span className="xs" style={{ color: 'var(--bad)' }}>{data.exceeded} bolsa(s) de teletrabajo superada(s) este mes</span>}
    </div>
  );
}
