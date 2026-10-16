// Atajos de Evalos: módulo nativo con las funciones principales de Evalos 8,
// trabajando directamente sobre su base de datos.
import { useState, type ReactNode } from 'react';
import { Navigate, NavLink, useParams } from 'react-router-dom';
import { AppIcon, ErrorBox, Icon, Loading } from '../../components/ui';
import { useNavGroup } from '../../components/navGroups';
import { SCREENS } from './screens';
import { ConnectionTag, EVALOS_COLOR, loadEvalosMe, useEvalosMe } from './common';
import EvalosConfig from './Config';
import EvalosCallLog from './CallLog';

export default function Evalos() {
  const { screen } = useParams();
  const { data: me, error, reload } = useEvalosMe();
  const [callLog, setCallLog] = useState(false);
  if (error) return <ErrorBox error={error} />;
  if (!me) return <Loading />;

  // Solo las opciones visibles en la Configuración de la empresa.
  const visible = SCREENS.filter((s) => me.screens.some((x) => x.key === s.key));
  const first = visible[0]?.key;
  if (!screen) {
    if ((!me.configured || !first) && me.canConfigure) return <Navigate to="/evalos/configuracion" replace />;
    if (!first) return <div className="empty">No hay opciones de Atajos de Evalos visibles. Un administrador puede activarlas en Configuración › Menú.</div>;
    return <Navigate to={`/evalos/${first}`} replace />;
  }
  const isConfig = screen === 'configuracion';
  const current = visible.find((s) => s.key === screen);
  if (!isConfig && !current) return <Navigate to="/evalos" replace />;
  if (isConfig && !me.canConfigure) return <Navigate to="/evalos" replace />;

  const groups = Array.from(new Set(visible.map((s) => s.group)));

  return (
    <>
      <div className="page-head">
        <div className="row" style={{ gap: 12, flexDirection: 'row', alignItems: 'center' }}>
          <AppIcon initials="AE" color={EVALOS_COLOR} glyph="clock" shadow />
          <div className="col" style={{ gap: 2 }}>
            <h1>Atajos de Evalos</h1>
            <span className="muted small">Las funciones principales de Evalos 8, directamente sobre su base de datos.</span>
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexDirection: 'row', alignItems: 'center' }}>
          {me.isAdmin && (
            <button type="button" className="btn sm" onClick={() => setCallLog(true)} title="Lo que Prime Suite envía a Evalos 8 (SOAP, EvalosRest y periodos) y lo que responde">
              <Icon.list /> Log de llamadas
            </button>
          )}
          <ConnectionTag me={me} />
        </div>
      </div>
      {callLog && <EvalosCallLog onClose={() => setCallLog(false)} />}

      <div className="ev-layout">
        <nav className="card ev-nav" aria-label="Pantallas de Atajos de Evalos">
          {groups.map((g) => {
            const list = visible.filter((s) => s.group === g);
            return (
              <EvNavGroup key={g} id={`evalos:${g}`} label={g} icon={groupIcon(g)} active={list.some((s) => s.key === screen)}>
                {list.map((s) => (
                  <NavLink key={s.key} to={`/evalos/${s.key}`} className="ev-nav-item">
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" dangerouslySetInnerHTML={{ __html: s.glyph }} />
                    {s.title}
                  </NavLink>
                ))}
              </EvNavGroup>
            );
          })}
          {me.canConfigure && (
            <EvNavGroup id="evalos:Administración" label="Administración" icon={<Icon.settings />} active={isConfig}>
              <NavLink to="/evalos/configuracion" className="ev-nav-item">
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></svg>
                Configuración
              </NavLink>
            </EvNavGroup>
          )}
        </nav>

        <section className="ev-main">
          {isConfig ? (
            <EvalosConfig onSaved={() => { loadEvalosMe(true); reload(); }} />
          ) : (
            current && (
              <>
                <div className="col" style={{ gap: 2 }}>
                  <h2>{current.title}</h2>
                  <span className="xs muted">En Evalos 8: {current.evalosPath}</span>
                </div>
                <current.Page />
              </>
            )
          )}
        </section>
      </div>
    </>
  );
}

/** Icono de cada grupo del menú de Atajos de Evalos. */
function groupIcon(g: string) {
  const n = g.toLowerCase();
  if (n.startsWith('organiz')) return <Icon.building />;
  if (n.startsWith('personal')) return <Icon.users />;
  if (n.startsWith('gesti')) return <Icon.briefcase />;
  if (n.startsWith('admin')) return <Icon.settings />;
  return <Icon.layers />;
}

/** Grupo plegable del menú; se abre solo si contiene la pantalla actual y recuerda la elección. */
function EvNavGroup({ id, label, icon, active, children }: { id: string; label: string; icon: ReactNode; active: boolean; children: ReactNode }) {
  const [open, toggle] = useNavGroup(id, active, false);
  return (
    <div className="ev-nav-group">
      <button type="button" className={`ev-nav-head${active ? ' has-active' : ''}`} aria-expanded={open} onClick={toggle}>
        <span className="ev-nav-head-ico">{icon}</span>
        <span className="grow">{label}</span>
        <span className={`chev${open ? ' open' : ''}`}><Icon.chevron /></span>
      </button>
      <div className={`nav-sub${open ? ' open' : ''}`}><div>{children}</div></div>
    </div>
  );
}
