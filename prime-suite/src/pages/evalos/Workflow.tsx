// Atajos de Evalos · Perfiles Workflow (por departamentos).
// Cada persona tiene su departamento y su rol (EMPLEADO, RESPONSABLE o RRHH); el responsable valida su departamento
// (y los que se le añadan), y a quien haga falta (p. ej. un jefe de departamento) se le asigna a mano quién le valida.
// Prime Suite crea y asigna los perfiles de WORKFLOW (nivel 1 calculado); aquí se editan los niveles 2 a 4 y el orden
// de validación de cada solicitud. El mismo archivo exporta el widget del Inicio.
import { Fragment, useEffect, useMemo, useState, type FormEvent, type JSX, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api, ApiError, type EvalosWfPerson, type EvalosWfProfile, type EvalosWfRole, type EvalosWorkflowResponse, type EvalosWorkflowSync } from '../../api';
import { ErrorBox, Icon, Loading, Modal, confirmAction, useData, useToast } from '../../components/ui';
import { NotConfigured, workflowToast } from './common';

const NC = { notConfigured: true } as unknown as EvalosWorkflowResponse;
type Tab = 'personas' | 'departamentos' | 'perfiles' | 'ajustes';
type D = Required<EvalosWorkflowResponse>;

function useWorkflow() {
  const { data, error, reload } = useData(() =>
    api.get<EvalosWorkflowResponse>('/api/evalos/workflow').catch((e) => {
      if (e instanceof ApiError && e.code === 'not_configured') return NC;
      throw e;
    })
  );
  let node: JSX.Element | null = null;
  if (data === NC) node = <NotConfigured />;
  else if (error) node = <div className="col" style={{ gap: 8 }}><ErrorBox error={error} /><button className="btn sm" style={{ alignSelf: 'flex-start' }} onClick={reload}><Icon.refresh /> Reintentar</button></div>;
  return { data: data === NC ? null : data, error: node, reload };
}

function useNames(d: D) {
  return useMemo(() => ({
    person: new Map(d.people.map((p) => [p.code, p.name])),
    dept: new Map(d.departments.map((x) => [x.code, x.description])),
    profile: new Map(d.profiles.map((p) => [p.code, p]))
  }), [d]);
}

export default function Workflow() {
  const { data, error, reload } = useWorkflow();
  const toast = useToast();
  const [params, setParams] = useSearchParams();
  const validTab = (t: string | null): t is Tab => ['personas', 'departamentos', 'perfiles', 'ajustes'].includes(t || '');
  const [tab, setTab] = useState<Tab>(validTab(params.get('tab')) ? (params.get('tab') as Tab) : 'personas');
  // Código a abrir que llega del widget del Inicio (?open=XX); se consume una vez.
  const [openCode, setOpenCode] = useState<string | undefined>(params.get('open') || undefined);
  const [applying, setApplying] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  useEffect(() => { if (params.get('tab') || params.get('open')) setParams({}, { replace: true }); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (error) return error;
  if (!data) return <Loading />;
  if (data.missing) return <MissingTables missing={data.missing} onRetry={reload} />;
  const d = data as D;
  const dynCount = d.profiles.filter((p) => p.dyn).length;

  async function applyPending() {
    setApplying(true);
    try {
      const r = await api.post<{ workflowSync: EvalosWorkflowSync }>('/api/evalos/workflow/recalcular', {});
      workflowToast(toast, r.workflowSync);
      if (!hasChanges(r.workflowSync)) toast('Los perfiles ya estaban al día');
      reload();
    } catch (e: any) { toast(e.message, true); }
    finally { setApplying(false); }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      {!!d.missingColumns?.length && <div className="alert warn">Falta en PERSONAL la columna {d.missingColumns.join(', ')} y no se ha podido crear automáticamente (el usuario de la conexión necesita permiso para modificar tablas).</div>}
      <div className="ev-kpis">
        <Kpi label="Departamentos con responsable" value={new Set(d.people.flatMap((p) => p.validates)).size} hint={`de ${d.departments.length} departamentos`} />
        <Kpi label="Personas con rol" value={d.people.filter((p) => p.workflowRol).length} hint={`${d.people.filter((p) => p.manual.length).length} con validador asignado a mano`} />
        <Kpi label="Perfiles creados por Prime Suite" value={dynCount} hint={`${d.profiles.length - dynCount} perfiles más en Evalos`} />
      </div>

      {hasChanges(d.pending) && (
        <div className="alert info row wrap" style={{ gap: 10 }}>
          <span className="grow small">
            <b>Hay cambios pendientes de aplicar en Evalos:</b>{' '}
            {[d.pending.created.length && `${d.pending.created.length} perfil(es) por crear`, d.pending.updated.length && `${d.pending.updated.length} por actualizar`,
              d.pending.removed.length && `${d.pending.removed.length} por borrar`, d.pending.assigned && `${d.pending.assigned} persona(s) por cambiar de perfil`].filter(Boolean).join(' · ')}.
          </span>
          {d.canEdit && <button className="btn sm primary" onClick={applyPending} disabled={applying}><Icon.refresh /> {applying ? 'Aplicando…' : 'Aplicar ahora'}</button>}
        </div>
      )}
      {!!d.pending.warnings.length && (
        <div className="alert warn small col" style={{ gap: 4 }}>
          <button type="button" className="row" style={{ gap: 6, background: 'none', border: 0, padding: 0, color: 'inherit', cursor: 'pointer', fontWeight: 700, textAlign: 'left' }} onClick={() => setShowWarnings((v) => !v)}>
            <Icon.warn /> {d.pending.warnings.length} aviso(s) de validación · {showWarnings ? 'ocultar' : 'ver'}
          </button>
          {showWarnings && d.pending.warnings.map((w, i) => <span key={i}>{w}</span>)}
        </div>
      )}

      <div className="tabs" role="tablist">
        {([['personas', 'Personas', <Icon.users />], ['departamentos', 'Departamentos', <Icon.building />], ['perfiles', 'Perfiles', <Icon.layers />], ...(d.canConfigure ? [['ajustes', 'Ajustes', <Icon.sliders />]] : [])] as [Tab, string, JSX.Element][]).map(([k, l, ico]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{ico}{l}</button>
        ))}
      </div>

      {tab === 'personas' && <PeopleTab d={d} onChanged={reload} openCode={tab === 'personas' ? openCode : undefined} onOpened={() => setOpenCode(undefined)} />}
      {tab === 'departamentos' && <DepartmentsTab d={d} />}
      {tab === 'perfiles' && <ProfilesTab d={d} onChanged={reload} openCode={tab === 'perfiles' ? openCode : undefined} onOpened={() => setOpenCode(undefined)} />}
      {tab === 'ajustes' && d.canConfigure && (
        <SettingsForm settings={d.settings} roles={d.roles} profiles={d.profiles} endpoint="/api/evalos/workflow/ajustes" onChanged={reload} />
      )}
    </div>
  );
}

// ---------- Personas ----------
function PeopleTab({ d, onChanged, openCode, onOpened }: { d: D; onChanged: () => void; openCode?: string; onOpened?: () => void }) {
  const toast = useToast();
  const names = useNames(d);
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [role, setRole] = useState('');
  const [withInactive, setWithInactive] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [bulkRole, setBulkRole] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [edit, setEdit] = useState<EvalosWfPerson | null>(null);
  // Abre la validación de la persona que llega del widget del Inicio.
  useEffect(() => {
    if (!openCode) return;
    const p = d.people.find((x) => x.code === openCode);
    if (p) setEdit(p);
    onOpened?.();
  }, [openCode]); // eslint-disable-line react-hooks/exhaustive-deps

  const needle = q.trim().toLowerCase();
  const list = d.people.filter((p) =>
    (withInactive || p.active)
    && (!needle || p.code.toLowerCase().includes(needle) || p.name.toLowerCase().includes(needle))
    && (!dept || (dept === '-' ? !p.department : p.department === dept))
    && (!role || (role === '-' ? !p.workflowRol : role === 'MANUAL' ? p.manual.length > 0 : p.workflowRol === role))
  ).sort((a, b) => a.name.localeCompare(b.name));
  const allSel = list.length > 0 && list.every((p) => sel.has(p.code));
  const toggleAll = () => setSel(allSel ? new Set([...sel].filter((c) => !list.some((p) => p.code === c))) : new Set([...sel, ...list.map((p) => p.code)]));
  const toggle = (c: string) => { const s = new Set(sel); if (s.has(c)) s.delete(c); else s.add(c); setSel(s); };

  async function apply() {
    if (!sel.size || bulkRole === null) return;
    if (!confirmAction(`Se pondrá a ${sel.size} persona(s) el rol ${bulkRole ? ROLE_LABEL[bulkRole] : '«sin rol»'} y se recalcularán sus perfiles de Workflow en Evalos. ¿Continuar?`)) return;
    setBusy(true);
    try {
      const r = await api.put<{ changed: number; workflowSync: EvalosWorkflowSync }>('/api/evalos/workflow/personas', { employees: [...sel], workflowRol: bulkRole });
      toast(`${r.changed} persona(s) actualizadas`);
      workflowToast(toast, r.workflowSync);
      setSel(new Set()); setBulkRole(null);
      onChanged();
    } catch (e: any) { toast(e.message, true); }
    finally { setBusy(false); }
  }
  const deptName = (c: string) => (c ? names.dept.get(c) || c : '');
  /** Por qué nadie valida a una persona (tooltip de «Nadie»). */
  const noValidatorReason = (p: EvalosWfPerson) => {
    if (!p.department) return 'No tiene departamento y tampoco validador asignado a mano. Asígnale departamento en Personal o pulsa la fila para asignarle quién la valida.';
    if (p.validates.includes(p.department)) return 'Es el único responsable de su departamento y no se valida a sí mismo. Pulsa la fila para asignarle a mano quién le valida (por ejemplo, su superior).';
    return `Ningún responsable en alta valida el departamento ${deptName(p.department)}. Da el rol Responsable a alguien del departamento, añade el departamento a un responsable o pulsa la fila para asignarle quién la valida.`;
  };

  return (
    <div className="card flat">
      <div className="ev-toolbar">
        <input className="input search" style={{ width: 220 }} placeholder="Buscar por código o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Departamento">
          <option value="">Todos los departamentos</option>
          <option value="-">Sin departamento</option>
          {d.departments.map((x) => <option key={x.code} value={x.code}>{x.description || x.code}</option>)}
        </select>
        <select className="select" style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Rol">
          <option value="">Todos los roles</option>
          <option value="-">Sin rol</option>
          {d.roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
          <option value="MANUAL">Con validador a mano</option>
        </select>
        <label className="row small" style={{ gap: 6, fontWeight: 400 }}><input type="checkbox" checked={withInactive} onChange={(e) => setWithInactive(e.target.checked)} /> Incluir bajas</label>
      </div>

      {d.canEdit && sel.size > 0 && (
        <div className="row wrap" style={{ gap: 8, padding: '10px 12px', margin: '0 12px 8px', borderRadius: 12, background: 'var(--surface-2)', border: '1px solid var(--line)' }}>
          <b className="small">{sel.size} seleccionada(s)</b>
          <select className="select" style={{ width: 'auto' }} value={bulkRole ?? '__keep__'} onChange={(e) => setBulkRole(e.target.value === '__keep__' ? null : e.target.value)} aria-label="Rol">
            <option value="__keep__">Rol: elige…</option>
            <option value="">Rol: quitar</option>
            {d.roles.map((r) => <option key={r} value={r}>Rol: {ROLE_LABEL[r]}</option>)}
          </select>
          <button className="btn sm primary" onClick={apply} disabled={busy || bulkRole === null}>{busy ? 'Aplicando…' : 'Aplicar'}</button>
          <button className="btn sm ghost" onClick={() => setSel(new Set())}>Quitar selección</button>
        </div>
      )}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              {d.canEdit && <th style={{ width: 36 }}><input type="checkbox" checked={allSel} onChange={toggleAll} aria-label="Seleccionar todas" /></th>}
              <th style={{ width: 120 }}>Código</th>
              <th>Nombre</th>
              <th>Departamento</th>
              <th>Rol</th>
              <th>Lo valida</th>
              <th>Valida</th>
              <th>Perfil de solicitudes</th>
            </tr>
          </thead>
          <tbody>
            {list.map((p) => {
              const prof = names.profile.get(p.profile);
              return (
                <tr key={p.code} className="clickable" onClick={() => setEdit(p)}>
                  {d.canEdit && <td onClick={(e) => e.stopPropagation()}><input type="checkbox" checked={sel.has(p.code)} onChange={() => toggle(p.code)} aria-label={`Seleccionar ${p.code}`} /></td>}
                  <td className="mono small">{p.code}</td>
                  <td className="small">
                    {p.name}
                    {!p.active && <span className="tag outline" style={{ marginLeft: 6 }}>De baja</span>}
                    {p.workflowRol && !p.email && <span className="tag warn" style={{ marginLeft: 6, cursor: 'help' }} title="No tiene email en la ficha (EM_WFEM): no recibirá los avisos por correo del Workflow. Añádeselo en Personal.">Sin email</span>}
                  </td>
                  <td className="small">{deptName(p.department) || <span className="muted">—</span>}</td>
                  <td><RoleTag rol={p.workflowRol} /></td>
                  <td className="small">
                    {!p.workflowRol ? <span className="muted">—</span>
                      : p.level1.length ? <>{p.level1.map((c) => names.person.get(c) || c).join(', ')}{p.level1Manual && <span className="tag info" style={{ marginLeft: 6 }}>A mano</span>}</>
                        : <span className="tag warn" style={{ cursor: 'help' }} title={noValidatorReason(p)}>Nadie</span>}
                  </td>
                  <td className="small">{p.validates.length ? p.validates.map(deptName).join(', ') : <span className="muted">—</span>}</td>
                  <td className="small">
                    {p.profile ? <><b className="mono">{p.profile}</b> {prof?.name || ''}</> : <span className="muted">Sin perfil</span>}
                  </td>
                </tr>
              );
            })}
            {!list.length && <tr><td colSpan={8} className="muted small" style={{ padding: 28, textAlign: 'center' }}>Nadie coincide con los filtros.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="ev-foot xs muted">
        El responsable valida las solicitudes de su departamento (y de los que se le añadan). Pulsa una persona para asignarle a mano quién la valida
        (por ejemplo, a un jefe de departamento su superior) o, si es responsable, añadirle departamentos. El departamento se cambia en su historial, en Personal.
      </div>
      {edit && <ValidationModal d={d} person={edit} onClose={() => setEdit(null)} onChanged={() => { setEdit(null); onChanged(); }} />}
    </div>
  );
}

/** Quién valida a una persona (a mano) y, si es responsable, departamentos de más que valida. */
function ValidationModal({ d, person, onClose, onChanged }: { d: D; person: EvalosWfPerson; onClose: () => void; onChanged: () => void }) {
  const toast = useToast();
  const names = useNames(d);
  const ro = !d.canEdit;
  const [manual, setManual] = useState<string[]>(person.manual);
  const [depts, setDepts] = useState<string[]>(person.extraDepts);
  const [addDept, setAddDept] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isResp = person.workflowRol === 'RESPONSABLE';
  const deptName = (c: string) => names.dept.get(c) || c;
  // Validadores por defecto: responsables (en alta) que validan su departamento, sin ella.
  const defaults = d.people.filter((p) => p.code !== person.code && p.validates.includes(person.department)).map((p) => p.name);
  const dirty = JSON.stringify(manual) !== JSON.stringify(person.manual) || JSON.stringify(depts) !== JSON.stringify(person.extraDepts);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.put<{ workflowSync: EvalosWorkflowSync | null }>(`/api/evalos/workflow/validacion/${encodeURIComponent(person.code)}`, { manual, depts: isResp ? depts : person.extraDepts });
      toast('Validación guardada y perfiles recalculados');
      workflowToast(toast, r.workflowSync, { quiet: true });
      onChanged();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }

  return (
    <Modal title={`${person.name} · ${person.code}`} onClose={onClose} wide>
      <div className="col" style={{ gap: 16 }}>
        <ErrorBox error={err} />
        <div className="row wrap small" style={{ gap: 14 }}>
          <span>Departamento: <b>{person.department ? deptName(person.department) : 'Sin departamento'}</b></span>
          <span>Rol: <RoleTag rol={person.workflowRol} /></span>
          {person.profile && <span>Perfil: <b className="mono">{person.profile}</b> {names.profile.get(person.profile)?.name || ''}</span>}
        </div>
        {!person.workflowRol && <div className="alert info small">Esta persona no tiene rol: su perfil de solicitudes no lo gestiona Prime Suite. Dale un rol en la pestaña Personas o en su ficha.</div>}

        <div className="col" style={{ gap: 8 }}>
          <h3 style={{ margin: 0 }}>Quién valida sus solicitudes (nivel 1)</h3>
          <span className="xs muted">
            Si lo dejas vacío, la validan los responsables de su departamento: {defaults.length ? <b>{defaults.join(', ')}</b> : <b>nadie ahora mismo</b>}.
            Si asignas a alguien aquí, lo sustituye (por ejemplo, a un jefe de departamento lo valida su superior).
          </span>
          <PeoplePicker people={d.people} value={manual} onChange={setManual} disabled={ro} exclude={person.code} />
        </div>

        {isResp && (
          <div className="col" style={{ gap: 8 }}>
            <h3 style={{ margin: 0 }}>Departamentos que valida</h3>
            <span className="xs muted">Su propio departamento siempre; añade los demás cuyas solicitudes también tiene que validar. Verá a su gente en el Workflow.</span>
            <div className="row wrap" style={{ gap: 6 }}>
              {person.department && <span className="tag info">{deptName(person.department)} · el suyo</span>}
              {depts.map((c) => (
                <span key={c} className="tag outline">
                  {deptName(c)}
                  {!ro && <button type="button" aria-label={`Quitar ${c}`} style={{ background: 'none', border: 0, cursor: 'pointer', padding: '0 0 0 4px', color: 'inherit' }} onClick={() => setDepts(depts.filter((x) => x !== c))}>×</button>}
                </span>
              ))}
            </div>
            {!ro && (
              <div className="row wrap" style={{ gap: 8 }}>
                <select className="select" style={{ width: 'auto', minWidth: 240 }} value={addDept} onChange={(e) => setAddDept(e.target.value)} aria-label="Departamento a añadir">
                  <option value="">Añadir departamento…</option>
                  {d.departments.filter((x) => x.code !== person.department && !depts.includes(x.code)).map((x) => <option key={x.code} value={x.code}>{x.description || x.code}</option>)}
                </select>
                <button type="button" className="btn sm" disabled={!addDept} onClick={() => { setDepts([...depts, addDept]); setAddDept(''); }}><Icon.plus /> Añadir</button>
              </div>
            )}
          </div>
        )}

        <div className="row" style={{ gap: 8 }}>
          {!ro && <button className="btn primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Guardando…' : 'Guardar'}</button>}
          <button className="btn ghost" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </Modal>
  );
}

// ---------- Departamentos ----------
function DepartmentsTab({ d }: { d: D }) {
  const names = useNames(d);
  const rows = d.departments.map((x) => {
    const members = d.people.filter((p) => p.active && p.department === x.code);
    const validators = d.people.filter((p) => p.validates.includes(x.code));
    return { ...x, members: members.length, withRole: members.filter((p) => p.workflowRol).length, manual: members.filter((p) => p.manual.length).length, validators };
  });
  return (
    <div className="card flat">
      <div className="ev-toolbar"><b className="small">{d.departments.length} departamento(s)</b></div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th style={{ width: 140 }}>Código</th><th>Departamento</th><th style={{ textAlign: 'right' }}>Personas</th><th style={{ textAlign: 'right' }}>Con rol</th><th>Lo validan</th><th style={{ textAlign: 'right' }}>Validador a mano</th></tr></thead>
          <tbody>
            {rows.map((x) => (
              <tr key={x.code}>
                <td className="mono"><b>{x.code}</b></td>
                <td className="small">{x.description}</td>
                <td style={{ textAlign: 'right' }} className="small">{x.members}</td>
                <td style={{ textAlign: 'right' }} className="small">{x.withRole}</td>
                <td className="small">
                  {x.validators.length
                    ? x.validators.map((p) => `${p.name}${p.department !== x.code ? ` (de ${names.dept.get(p.department) || p.department})` : ''}`).join(', ')
                    : x.withRole ? <span className="tag warn" style={{ cursor: 'help' }} title="Ningún responsable en alta valida este departamento: sus personas con rol no tienen autorizador de nivel 1 (salvo las que tengan validador asignado a mano). Da el rol Responsable a alguien del departamento o añade el departamento a un responsable.">Nadie</span> : <span className="muted">—</span>}
                </td>
                <td style={{ textAlign: 'right' }} className="small">{x.manual || <span className="muted">—</span>}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={6} className="muted small" style={{ padding: 28, textAlign: 'center' }}>No se han podido leer los departamentos.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="ev-foot xs muted">Un departamento lo validan sus responsables y los responsables de otros departamentos que lo tengan añadido. Se asignan en la pestaña Personas.</div>
    </div>
  );
}

// ---------- Perfiles ----------
function ProfilesTab({ d, onChanged, openCode, onOpened }: { d: D; onChanged: () => void; openCode?: string; onOpened?: () => void }) {
  const names = useNames(d);
  const [edit, setEdit] = useState<EvalosWfProfile | null>(null);
  const [showOthers, setShowOthers] = useState(false);
  useEffect(() => {
    if (!openCode) return;
    const p = d.profiles.find((x) => x.code === openCode);
    if (p) setEdit(p);
    onOpened?.();
  }, [openCode]); // eslint-disable-line react-hooks/exhaustive-deps
  const dyn = d.profiles.filter((p) => p.dyn).sort((a, b) => a.name.localeCompare(b.name));
  const others = d.profiles.filter((p) => !p.dyn);
  const deptName = (c: string) => names.dept.get(c) || c;
  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card flat">
        <div className="ev-toolbar"><b className="small">{dyn.length} perfil(es) creados por Prime Suite</b></div>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th style={{ width: 70 }}>Código</th><th>Descripción</th><th>Rol</th><th>Nivel 1</th><th>Niveles 2–4</th><th style={{ textAlign: 'right' }}>Solicitudes</th><th style={{ textAlign: 'right' }}>Personas</th><th style={{ width: 40 }} /></tr></thead>
            <tbody>
              {dyn.map((p) => {
                const extra = d.levelCols.slice(1).filter((c) => p.levels[c]?.length).length;
                return (
                  <tr key={p.code} className="clickable" onClick={() => setEdit(p)}>
                    <td className="mono"><b>{p.code}</b></td>
                    <td className="small">{p.name}{!!p.alerts.length && <span className="tag warn" style={{ marginLeft: 6, cursor: 'help' }} title={p.alerts.join('\n')}>Aviso</span>}</td>
                    <td><RoleTag rol={p.dyn!.rol} /></td>
                    <td className="small">{p.levels[d.levelCols[0]]?.length ? p.levels[d.levelCols[0]].map((c) => names.person.get(c) || c).join(', ') : <span className="tag warn" style={{ cursor: 'help' }} title="Este perfil no tiene autorizadores de nivel 1: ningún responsable en alta valida su departamento ni hay validador asignado a mano.">Nadie</span>}</td>
                    <td className="small">{extra ? `${extra} nivel(es) más` : <span className="muted">—</span>}</td>
                    <td style={{ textAlign: 'right' }} className="small">{d.requests.filter((r) => p.orders[r.col]).length} de {d.requests.length}</td>
                    <td style={{ textAlign: 'right' }}><b className="small">{p.people}</b></td>
                    <td className="muted">{d.canEdit ? <Icon.edit /> : <Icon.eye />}</td>
                  </tr>
                );
              })}
              {!dyn.length && <tr><td colSpan={8} className="muted small" style={{ padding: 28, textAlign: 'center' }}>Todavía no hay perfiles: se crean al dar rol a las personas.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="ev-foot xs muted">El nivel 1 lo calcula Prime Suite (responsables del departamento o el validador asignado a mano). En cada perfil puedes añadir autorizadores en los niveles 2 a 4 y elegir qué solicitudes aparecen y en qué orden se validan.</div>
      </div>
      <div className="card flat">
        <button type="button" className="ev-toolbar" style={{ background: 'none', border: 0, width: '100%', cursor: 'pointer', textAlign: 'left' }} onClick={() => setShowOthers((v) => !v)}>
          <b className="small">Otros perfiles de Evalos ({others.length})</b>
          <span className="grow" />
          <span className="xs muted">{showOthers ? 'Ocultar' : 'Ver'}</span>
        </button>
        {showOthers && (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 70 }}>Código</th><th>Descripción</th><th /><th style={{ textAlign: 'right' }}>Personas</th></tr></thead>
              <tbody>
                {others.map((p) => (
                  <tr key={p.code}>
                    <td className="mono"><b>{p.code}</b></td>
                    <td className="small">{p.name}</td>
                    <td>{p.template && <span className="tag info">Plantilla {Object.entries(d.settings.templates).filter(([, t]) => t === p.code).map(([r]) => ROLE_LABEL[r]).join(', ')}</span>}</td>
                    <td style={{ textAlign: 'right' }} className="small">{p.people}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {edit && (() => {
        const k = edit.dyn!;
        return (
          <ProfileEditorModal profile={edit} people={d.people} requests={d.requests} levelCols={d.levelCols} canEdit={d.canEdit}
            endpoint={`/api/evalos/workflow/perfiles/${encodeURIComponent(edit.code)}`} onClose={() => setEdit(null)} onChanged={() => { setEdit(null); onChanged(); }}
            level1Note={k.manual.length ? 'asignado a mano en la pestaña Personas' : `lo calcula Prime Suite: responsables de ${k.department ? deptName(k.department) : 'su departamento'}`}
            header={<>
              <span>Departamento: <b>{k.department ? deptName(k.department) : 'Sin departamento'}</b></span>
              <span>Rol: <RoleTag rol={k.rol} /></span>
              {k.depts.length > 0 && <span>Valida: <b>{k.depts.map(deptName).join(', ')}</b></span>}
              <span>Filtro de personal: <span className="mono xs">{edit.filter || (k.rol === 'RRHH' ? 'todo el personal' : 'el de la plantilla')}</span></span>
            </>} />
        );
      })()}
    </div>
  );
}

// ---------- Widget ----------
const ChevR = () => <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>;

export function WorkflowWidget() {
  const { data, error } = useWorkflow();
  if (error) return error;
  if (!data) return <Loading />;
  if (data.missing) return <Link to="/evalos/workflow" className="small muted">No se han podido crear las tablas de Perfiles Workflow en Evalos 8. Abre la pantalla para ver el motivo →</Link>;
  const d = data as D;
  const withRole = d.people.filter((p) => p.workflowRol).length;
  const noValidator = d.people.filter((p) => p.active && p.workflowRol && !p.level1.length);
  const profileAlerts = d.profiles.filter((p) => p.dyn && p.alerts.length);
  // Lo accionable: perfiles con avisos primero, luego personas sin validador.
  const rows = [
    ...profileAlerts.map((p) => ({ key: `p${p.code}`, to: `/evalos/workflow?tab=perfiles&open=${encodeURIComponent(p.code)}`, title: p.name, sub: p.alerts[0], tag: 'Aviso' })),
    ...noValidator.map((p) => ({ key: `u${p.code}`, to: `/evalos/workflow?tab=personas&open=${encodeURIComponent(p.code)}`, title: p.name, sub: `${ROLE_LABEL[p.workflowRol] || p.workflowRol} · sin validador de nivel 1`, tag: 'Sin validador' }))
  ];
  return (
    <div className="col" style={{ gap: 12 }}>
      <div className="row" style={{ gap: 10 }}>
        <div className="ev-mini grow"><span className="xs muted" style={{ fontWeight: 600 }}>Personas con rol</span><b>{withRole}</b></div>
        <div className={`ev-mini grow${profileAlerts.length ? ' alert' : ''}`}><span className="xs muted" style={{ fontWeight: 600 }}>Perfiles con aviso</span><b>{profileAlerts.length}</b></div>
        <div className={`ev-mini grow${noValidator.length ? ' alert' : ''}`}><span className="xs muted" style={{ fontWeight: 600 }}>Sin validador</span><b>{noValidator.length}</b></div>
      </div>
      <div className="w-list">
        {rows.slice(0, 4).map((r) => (
          <Link key={r.key} to={r.to} className="w-row">
            <span className="w-row-main"><b>{r.title}</b><span className="xs muted">{r.sub}</span></span>
            <span className="tag warn">{r.tag}</span>
            <span className="chev-r"><ChevR /></span>
          </Link>
        ))}
        {!rows.length && <div className="w-empty"><Icon.ok /> Todo en orden: perfiles con validadores.</div>}
      </div>
      <div className="w-quick">
        <Link to="/evalos/workflow?tab=perfiles"><Icon.layers /> Perfiles</Link>
        <Link to="/evalos/workflow?tab=personas"><Icon.users /> Personas</Link>
      </div>
    </div>
  );
}

// ---------- Piezas comunes ----------
export const ROLE_LABEL: Record<string, string> = { EMPLEADO: 'Empleado', RESPONSABLE: 'Responsable', RRHH: 'RR.HH.' };
export const ROLE_TAG: Record<string, string> = { EMPLEADO: 'outline', RESPONSABLE: 'info', RRHH: 'ok' };
export const RoleTag = ({ rol }: { rol: string }) => (rol
  ? <span className={`tag ${ROLE_TAG[rol] || 'warn'}`} style={ROLE_TAG[rol] ? undefined : { cursor: 'help' }} title={ROLE_TAG[rol] ? undefined : `El rol «${rol}» no es Empleado, Responsable ni RR.HH.: no se le asigna perfil de Workflow. Cámbialo por uno válido.`}>{ROLE_LABEL[rol] || rol}</span>
  : <span className="muted xs">Sin rol</span>);

export const hasChanges = (s?: EvalosWorkflowSync | null) => !!s && (s.created.length + s.updated.length + s.removed.length + s.assigned > 0);

export function Kpi({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="card" style={{ gap: 4, padding: '16px 18px' }}>
      <span className="xs muted" style={{ fontWeight: 600 }}>{label}</span>
      <span className="stat">{value}</span>
      {hint && <span className="xs muted ev-kpi-hint">{hint}</span>}
    </div>
  );
}

/**
 * Ventana de un perfil: autorizadores de los niveles 2 a 4 y asistente
 * del orden de validación de cada solicitud. El nivel 1 lo calcula Prime Suite.
 */
export function ProfileEditorModal({ profile, people, requests, levelCols, canEdit, endpoint, header, level1Note, onClose, onChanged }: {
  profile: { code: string; name: string; levels: Record<string, string[]>; orders: Record<string, string>; people: number };
  people: { code: string; name: string; active: boolean }[]; requests: { col: string; label: string }[]; levelCols: string[]; canEdit: boolean;
  endpoint: string; header: ReactNode; level1Note: string; onClose: () => void; onChanged: () => void;
}) {
  const toast = useToast();
  const d = { levelCols, requests, people };
  const personName = useMemo(() => new Map(people.map((p) => [p.code, p.name])), [people]);
  const ro = !canEdit;
  const [levels, setLevels] = useState<Record<string, string[]>>(() => Object.fromEntries(d.levelCols.map((c) => [c, [...(profile.levels[c] || [])]])));
  const [orders, setOrders] = useState<Record<string, string>>(() => ({ ...profile.orders }));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const emptyLevels = d.levelCols.map((c, i) => (levels[c].length ? 0 : i + 1)).filter(Boolean);
  const alerts = d.requests.flatMap((r) => {
    const o = orders[r.col];
    if (!o || o === '0') return [];
    const miss = o.split(',').map(Number).filter((n) => emptyLevels.includes(n));
    return miss.length ? [`${r.label}: pasa por el nivel ${miss.join(' y ')}, que no tiene autorizadores.`] : [];
  });
  const dirty = JSON.stringify(levels) !== JSON.stringify(Object.fromEntries(d.levelCols.map((c) => [c, profile.levels[c] || []]))) || JSON.stringify(orders) !== JSON.stringify(profile.orders);

  async function save() {
    setBusy(true); setErr(null);
    try {
      const r = await api.put<{ alerts: string[] }>(endpoint, {
        levels: Object.fromEntries(d.levelCols.slice(1).map((c) => [c, levels[c]])), orders
      });
      toast(`Perfil ${profile.code} guardado en Evalos`);
      for (const a of r.alerts) toast(a, true);
      onChanged();
    } catch (e: any) { setErr(e.message); setBusy(false); }
  }
  /** Copia el orden de una solicitud a todas las que aparecen. */
  function copyToAll(col: string) {
    const o = orders[col];
    setOrders(Object.fromEntries(d.requests.map((r) => [r.col, orders[r.col] ? o : orders[r.col]])));
  }

  return (
    <Modal title={`Perfil ${profile.code} · ${profile.name}`} onClose={onClose} width={900}>
      <div className="col" style={{ gap: 16 }}>
        <ErrorBox error={err} />
        <div className="row wrap small" style={{ gap: 14 }}>
          {header}
          <span>{profile.people} persona(s)</span>
        </div>

        <div className="col" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>Autorizadores por nivel</h3>
          <span className="xs muted">En cada nivel basta con que valide una de las personas.</span>
          {d.levelCols.map((c, i) => (
            <div key={c} className="row wrap" style={{ gap: 8, alignItems: 'flex-start' }}>
              <b className="small" style={{ minWidth: 70, paddingTop: 6 }}>Nivel {i + 1}</b>
              <div className="col grow" style={{ gap: 6 }}>
                {i === 0
                  ? <span className="small">{levels[c].length ? levels[c].map((x) => personName.get(x) || x).join(', ') : <span className="tag warn" style={{ cursor: 'help' }} title="El nivel 1 no tiene autorizadores: las solicitudes que pasen por él no las podrá validar nadie.">Nadie</span>} <span className="xs muted">· {level1Note}</span></span>
                  : <PeoplePicker people={d.people} value={levels[c]} onChange={(v) => setLevels({ ...levels, [c]: v })} disabled={ro} />}
              </div>
            </div>
          ))}
        </div>

        <div className="col" style={{ gap: 10 }}>
          <h3 style={{ margin: 0 }}>Solicitudes y orden de validación</h3>
          <span className="xs muted">Marca las solicitudes que aparecen y pulsa los niveles en el orden en que tienen que validar. «Sin validación» la aprueba directamente.</span>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th style={{ width: 40 }}>Ver</th><th>Solicitud</th><th>Orden de validación</th>{!ro && <th style={{ width: 180 }} />}</tr></thead>
              <tbody>
                {d.requests.map((r) => (
                  <OrderRow key={r.col} label={r.label} value={orders[r.col] || ''} emptyLevels={emptyLevels} ro={ro}
                    onChange={(v) => setOrders({ ...orders, [r.col]: v })} onCopyAll={() => copyToAll(r.col)} />
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {!!alerts.length && <div className="alert warn small col" style={{ gap: 4 }}>{alerts.map((a, i) => <span key={i}>{a}</span>)}</div>}
        <div className="row" style={{ gap: 8 }}>
          {!ro && <button className="btn primary" onClick={save} disabled={busy || !dirty}>{busy ? 'Guardando…' : 'Guardar en Evalos'}</button>}
          <button className="btn ghost" onClick={onClose}>Cerrar</button>
        </div>
      </div>
    </Modal>
  );
}

/** Fila del asistente de orden: disponible, sin validación o la secuencia de niveles (p. ej. 1 → 2). */
export function OrderRow({ label, value, emptyLevels, ro, onChange, onCopyAll }: {
  label: string; value: string; emptyLevels: number[]; ro: boolean; onChange: (v: string) => void; onCopyAll: () => void;
}) {
  const on = value !== '';
  const direct = value === '0';
  const seq = on && !direct ? value.split(',').map(Number) : [];
  const add = (n: number) => onChange([...seq, n].join(','));
  const removeAt = (i: number) => { const s = seq.filter((_, j) => j !== i); onChange(s.length ? s.join(',') : '0'); };
  return (
    <tr>
      <td><input type="checkbox" checked={on} disabled={ro} onChange={(e) => onChange(e.target.checked ? '1' : '')} aria-label={`Mostrar ${label}`} /></td>
      <td className="small" style={{ opacity: on ? 1 : 0.55 }}>{label}</td>
      <td>
        {!on ? <span className="xs muted">No aparece</span> : (
          <div className="row wrap" style={{ gap: 6 }}>
            <label className="row xs" style={{ gap: 4, fontWeight: 400 }}>
              <input type="checkbox" checked={direct} disabled={ro} onChange={(e) => onChange(e.target.checked ? '0' : '1')} /> Sin validación
            </label>
            {!direct && seq.map((n, i) => (
              <Fragment key={i}>
                {i > 0 && <span className="muted xs">→</span>}
                <button type="button" className={`tag ${emptyLevels.includes(n) ? 'warn' : 'info'}`} style={{ cursor: ro ? 'default' : 'pointer', border: 0 }} disabled={ro}
                  title={[emptyLevels.includes(n) ? `El nivel ${n} no tiene autorizadores: esta solicitud se quedará sin validar en ese paso. Añade personas al nivel ${n} arriba.` : '', ro ? '' : 'Pulsa para quitar este nivel.'].filter(Boolean).join(' ') || undefined} onClick={() => removeAt(i)}>Nivel {n}{!ro && ' ×'}</button>
              </Fragment>
            ))}
            {!direct && !ro && [1, 2, 3, 4].filter((n) => !seq.includes(n)).map((n) => (
              <button key={n} type="button" className="btn xs ghost" onClick={() => add(n)} title={emptyLevels.includes(n) ? 'Este nivel aún no tiene autorizadores' : undefined}>+ {n}</button>
            ))}
          </div>
        )}
      </td>
      {!ro && <td>{on && <button type="button" className="btn xs ghost" onClick={onCopyAll} title="Pone este mismo orden en todas las solicitudes que aparecen">Aplicar a todas</button>}</td>}
    </tr>
  );
}

/** Lista de personas: chips con el nombre y buscador para añadir. */
export function PeoplePicker({ people, value, onChange, disabled, exclude }: { people: { code: string; name: string; active: boolean }[]; value: string[]; onChange: (v: string[]) => void; disabled: boolean; exclude?: string }) {
  const [q, setQ] = useState('');
  const byCode = useMemo(() => new Map(people.map((p) => [p.code, p])), [people]);
  const needle = q.trim().toLowerCase();
  const hits = needle ? people.filter((p) => p.active && p.code !== exclude && !value.includes(p.code) && (p.code.includes(needle) || p.name.toLowerCase().includes(needle))).slice(0, 8) : [];
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        {value.map((c) => (
          <span key={c} className="tag outline">
            {byCode.get(c)?.name || c}
            {!disabled && <button type="button" aria-label={`Quitar ${c}`} style={{ background: 'none', border: 0, cursor: 'pointer', padding: '0 0 0 4px', color: 'inherit' }} onClick={() => onChange(value.filter((x) => x !== c))}>×</button>}
          </span>
        ))}
        {!value.length && <span className="xs muted">Sin autorizadores</span>}
      </div>
      {!disabled && (
        <div style={{ position: 'relative', maxWidth: 360 }}>
          <input className="input" placeholder="Añadir persona: busca por código o nombre" value={q} onChange={(e) => setQ(e.target.value)} />
          {!!hits.length && (
            <div className="card" style={{ position: 'absolute', zIndex: 5, left: 0, right: 0, top: '100%', marginTop: 4, padding: 4, gap: 0 }}>
              {hits.map((p) => (
                <button key={p.code} type="button" className="row small" style={{ gap: 8, background: 'none', border: 0, padding: '6px 8px', cursor: 'pointer', textAlign: 'left', width: '100%' }}
                  onClick={() => { onChange([...value, p.code]); setQ(''); }}>
                  <span className="mono xs muted">{p.code}</span> {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- Ajustes ----------
/** Ajustes: plantilla de cada rol y prefijo de los códigos. */
function SettingsForm({ settings, roles, profiles, endpoint, onChanged }: {
  settings: { templates: Record<EvalosWfRole, string>; prefix: string }; roles: EvalosWfRole[]; profiles: { code: string; name: string; dyn: unknown }[];
  endpoint: string; onChanged: () => void;
}) {
  const toast = useToast();
  const d = { roles };
  const [templates, setTemplates] = useState<Record<EvalosWfRole, string>>({ ...settings.templates });
  const [prefix, setPrefix] = useState(settings.prefix);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const candidates = profiles.filter((p) => !p.dyn);
  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await api.put(endpoint, { templates, prefix }); toast('Ajustes guardados'); onChanged(); }
    catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  }
  return (
    <form className="card col" style={{ gap: 14 }} onSubmit={save}>
      <ErrorBox error={err} />
      <span className="small muted">
        Cada perfil nuevo se crea copiando la plantilla de su rol (permisos, historial visible, adjuntos, mensajería…). Prime Suite solo cambia la descripción,
        los autorizadores, el filtro de personal de responsables y RR.HH. y, si la plantilla las deja vacías, pone todas las solicitudes con un nivel.
        Los cambios de plantilla se aplican a los perfiles que se creen a partir de ahora.
      </span>
      <div className="grid-2" style={{ gap: 12 }}>
        {d.roles.map((r) => (
          <label key={r} className="field">Plantilla {ROLE_LABEL[r]}
            <select className="select" value={templates[r]} onChange={(e) => setTemplates({ ...templates, [r]: e.target.value })}>
              {!candidates.some((p) => p.code === templates[r]) && <option value={templates[r]}>{templates[r]} (no existe en WORKFLOW)</option>}
              {candidates.map((p) => <option key={p.code} value={p.code}>{p.code} · {p.name}</option>)}
            </select>
          </label>
        ))}
        <label className="field">Prefijo de los códigos
          <span className="hint">Una letra: los perfiles se numeran {prefix || 'Q'}01, {prefix || 'Q'}02… (WF_CODI admite 3 caracteres).</span>
          <input className="input mono" value={prefix} maxLength={1} onChange={(e) => setPrefix(e.target.value.toUpperCase().replace(/[^A-Z]/g, ''))} required />
        </label>
      </div>
      <div className="row"><button className="btn primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button></div>
    </form>
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
    const a = Object.assign(document.createElement('a'), { href: url, download: 'PS_PERFILES_WORKFLOW.sql' });
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

