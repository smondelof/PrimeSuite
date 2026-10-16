import { useEffect, useState, type JSX } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useSession } from '../session';
import { Icon, LogoMark } from './ui';
import { api, initialsOf, PORTAL_ROLE_LABEL, type Category, type PortalApp } from '../api';
import { ModulesProvider, useModules } from '../modules';
import ModuleHost from './ModuleHost';
import { useNavGroup } from './navGroups';

/** Versión publicada (de /api/health); «desarrollo» en el entorno de desarrollo. */
let versionCache: Promise<string | null> | null = null;
function useVersion() {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    versionCache ||= api.get<{ version?: string }>('/api/health').then((h) => h.version || null).catch(() => { versionCache = null; return null; });
    versionCache.then(setV);
  }, []);
  return v;
}

/** Icono de cada categoría de aplicaciones (por nombre; si no se reconoce, una etiqueta). */
function CatIcon({ name }: { name: string }) {
  const n = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/analy|anali|insight|report|informe/.test(n)) return <Icon.chart />;
  if (/people|person|rrhh|recursos|hr\b|emplead/.test(n)) return <Icon.users />;
  if (/secur|segur|acces|control/.test(n)) return <Icon.shield />;
  if (/perform|rendim|productiv/.test(n)) return <Icon.trend />;
  if (/otro|other|varios|misc/.test(n)) return <Icon.apps />;
  return <Icon.tag />;
}
/** «ANALYTICS» → «Analytics», «RECURSOS HUMANOS» → «Recursos humanos». */
const prettyName = (s: string) => (s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);

export default function Layout() {
  // El proveedor de módulos envuelve toda la zona autenticada, de modo que los
  // iframes de los módulos abiertos se mantienen vivos al cambiar de ruta.
  return (
    <ModulesProvider>
      <Shell />
    </ModulesProvider>
  );
}

const NAV_KEY = 'ps.nav.open';

function Shell() {
  const { me, logout } = useSession();
  const version = useVersion();
  const nav = useNavigate();
  const loc = useLocation();
  const { setOnNative } = useModules();
  const [cats, setCats] = useState<Category[]>([]);
  const [adminOpen, toggleAdmin] = useNavGroup('admin', loc.pathname.startsWith('/admin'));
  const [navOpen, setNavOpen] = useState(() => {
    try {
      const v = localStorage.getItem(NAV_KEY);
      if (v !== null) return v === '1';
    } catch {}
    return typeof window === 'undefined' || window.innerWidth > 760;
  });

  // Los módulos nativos (p. ej. Prime Insights) navegan a su ruta interna.
  useEffect(() => { setOnNative((url) => nav(url)); }, [setOnNative, nav]);

  // Categorías con al menos una aplicación accesible, para la barra lateral.
  useEffect(() => {
    api.get<{ categories: Category[]; apps: PortalApp[] }>('/api/portal/apps')
      .then((d) => setCats(d.categories.filter((c) => d.apps.some((a) => a.categoryId === c.id))))
      .catch(() => {});
  }, [me?.user.id]);

  // En móvil, al cambiar de ruta se cierra el menú superpuesto.
  useEffect(() => {
    if (typeof window !== 'undefined' && window.innerWidth <= 760) setNavOpen(false);
  }, [loc.pathname]);

  const toggleNav = () => setNavOpen((v) => {
    const n = !v;
    try { localStorage.setItem(NAV_KEY, n ? '1' : '0'); } catch {}
    return n;
  });

  if (!me) return null;
  const activeCat = new URLSearchParams(loc.search).get('cat');

  return (
    <div className={`shell${navOpen ? '' : ' nav-hidden'}`}>
      {navOpen && <div className="nav-backdrop" onClick={toggleNav} aria-hidden="true" />}
      <aside className="side">
        <div className="brand">
          <LogoMark size={22} color="currentColor" />
          <span className="brand-text">
            <span className="brand-name">Prime Suite</span>
            {version && <span className="brand-version" title="Versión de Prime Suite">{version === 'desarrollo' ? 'Desarrollo' : `Versión ${version}`}</span>}
          </span>
          <button className="icon-btn side-collapse" title="Ocultar menú" aria-label="Ocultar menú" onClick={toggleNav}>
            <Icon.panel />
          </button>
        </div>

        <nav className="nav" aria-label="Principal">
          <NavLink to="/" end><Icon.home /> Inicio</NavLink>
          <NavLink to="/apps" end><Icon.grid /> Todas las aplicaciones</NavLink>
        </nav>

        {cats.length > 0 && (
          <nav className="nav" aria-label="Categorías">
            <span className="nav-label">Aplicaciones</span>
            {cats.map((c) => {
              const on = loc.pathname === '/apps' && activeCat === c.id;
              return (
                <NavLink key={c.id} to={`/apps?cat=${c.id}`} className={() => `cat${on ? ' active' : ''}`}>
                  <span className="cat-ico" style={{ background: c.color }}><CatIcon name={c.name} /></span> {prettyName(c.name)}
                </NavLink>
              );
            })}
          </nav>
        )}

        {me.isAdmin && (
          <nav className="nav" aria-label="Administración">
            <button className="nav-group-btn" aria-expanded={adminOpen} onClick={toggleAdmin}>
              <Icon.settings /> Administración
              <span className={`chev ${adminOpen ? 'open' : ''}`}><Icon.chevron /></span>
            </button>
            <div className={`nav-sub${adminOpen ? ' open' : ''}`}>
              <div>
                {([
                  ['/admin/integraciones', <Icon.plug />, 'Integraciones'],
                  ['/admin/identidad', <Icon.shield />, 'Identidad y SSO'],
                  ['/admin/usuarios', <Icon.users />, 'Usuarios'],
                  ['/admin/grupos', <Icon.layers />, 'Grupos y permisos'],
                  ['/admin/empresas', <Icon.building />, 'Empresas'],
                  ...(me.isSuper ? [['/admin/categorias', <Icon.tag />, 'Categorías']] : []),
                  ['/admin/auditoria', <Icon.list />, 'Auditoría']
                ] as [string, JSX.Element, string][]).map(([to, ico, label]) => (
                  <NavLink key={to} to={to} className="sub" tabIndex={adminOpen ? 0 : -1}>{ico} {label}</NavLink>
                ))}
              </div>
            </div>
          </nav>
        )}

      </aside>

      <div className="main">
        <header className="top">
          <button className="icon-btn nav-toggle" title={navOpen ? 'Ocultar menú' : 'Mostrar menú'} aria-label={navOpen ? 'Ocultar menú' : 'Mostrar menú'} onClick={toggleNav}>
            <Icon.menu />
          </button>
          <div className="top-user">
            <NavLink to="/perfil" className="row" style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="col" style={{ gap: 0, alignItems: 'flex-end' }}>
                <span className="small" style={{ fontWeight: 600 }}>{me.user.firstName} {me.user.lastName}</span>
                <span className="xs muted">{PORTAL_ROLE_LABEL[me.user.role]}</span>
              </div>
              <span className="avatar">{initialsOf(me.user.firstName, me.user.lastName)}</span>
            </NavLink>
            <button className="icon-btn" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={async () => { await logout(); nav('/login'); }}>
              <Icon.logout />
            </button>
          </div>
        </header>

        <div className="work">
          <div className="work-scroll">
            <main className="content"><Outlet /></main>
          </div>
          <ModuleHost />
        </div>
      </div>
    </div>
  );
}
