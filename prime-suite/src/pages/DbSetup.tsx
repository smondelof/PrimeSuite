// Conexión a SQL Server: se muestra cuando falta el fichero de conexión o la base de datos no responde.
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { Loading, Logo } from '../components/ui';

export interface DbStatus {
  store: string;
  status: 'iniciando' | 'conectando' | 'sin-configurar' | 'error' | 'lista';
  ready: boolean;
  error: string | null;
  configured?: boolean;
  suggestedDatabase?: string;
  installation?: string;
  config?: { server: string; port: number | null; database: string; encrypt: boolean; trustServerCertificate: boolean } | null;
  configFile?: string;
  sqlite?: { file: string; exists: boolean; migrated: boolean };
}

/** Delante de toda la app: si la base de datos no está lista, muestra el formulario de conexión. */
export function DbGate({ children }: { children: ReactNode }) {
  const [st, setSt] = useState<DbStatus | null>(null);

  async function load() {
    try {
      setSt(await api.get<DbStatus>('/api/db/status'));
    } catch {
      // Servidor sin este endpoint (p. ej. Netlify) o caído: se deja pasar y la app mostrará sus errores.
      setSt({ store: 'desconocido', status: 'lista', ready: true, error: null });
    }
  }

  useEffect(() => {
    load();
    const onLost = () => load();
    window.addEventListener('ps:dbsetup', onLost);
    return () => window.removeEventListener('ps:dbsetup', onLost);
  }, []);

  // Mientras conecta, se consulta de nuevo cada 2 s.
  useEffect(() => {
    if (st && (st.status === 'conectando' || st.status === 'iniciando')) {
      const t = setTimeout(load, 2000);
      return () => clearTimeout(t);
    }
  }, [st]);

  if (!st || st.status === 'iniciando' || st.status === 'conectando') return <Loading />;
  if (st.ready) return <>{children}</>;
  return <DbSetup status={st} onDone={() => window.location.reload()} onRefresh={load} />;
}

function DbSetup({ status, onDone, onRefresh }: { status: DbStatus; onDone: () => void; onRefresh: () => void }) {
  const c = status.config;
  const [f, setF] = useState({
    code: '',
    server: c?.server || '',
    port: c?.port ? String(c.port) : '1433',
    database: c?.database || '',
    user: '',
    password: '',
    encrypt: c ? c.encrypt : true,
    trustServerCertificate: c ? c.trustServerCertificate : true
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'' | 'save' | 'retry'>('');
  const [done, setDone] = useState<string | null>(null);
  const [inUse, setInUse] = useState(false);
  const [takeOver, setTakeOver] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const named = f.server.includes('\\');

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy('save');
    setError(null);
    try {
      const r = await api.post<{ createdDatabase: boolean; migrated: { total: number; inserted: number } | null }>('/api/db/config', {
        ...f,
        port: named ? undefined : f.port,
        takeOver: inUse && takeOver
      });
      const parts = ['Conexión guardada.'];
      if (r.createdDatabase) parts.push(`Se ha creado la base de datos ${f.database}.`);
      parts.push('Tablas comprobadas.');
      if (r.migrated) parts.push(`Migrados ${r.migrated.inserted} de ${r.migrated.total} registros desde SQLite.`);
      setDone(parts.join(' '));
      setTimeout(onDone, 2500);
    } catch (err: any) {
      setError(err.message);
      if (err.code === 'DB_IN_USE') setInUse(true);
      setBusy('');
    }
  }

  async function retry() {
    setBusy('retry');
    setError(null);
    try {
      const s = await api.post<DbStatus>('/api/db/retry');
      if (s.ready) onDone();
      else setError(s.error || 'Sigue sin poder conectar.');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy('');
      onRefresh();
    }
  }

  return (
    <div className="auth">
      <form className="auth-card" style={{ width: 'min(560px, 100%)' }} onSubmit={submit}>
        <div className="col" style={{ gap: 6, alignItems: 'flex-start' }}>
          <div className="row" style={{ gap: 8, color: 'var(--ink)' }}>
            <Logo height={28} />
            <span style={{ fontSize: 16, fontWeight: 600, color: 'var(--ink)', opacity: .72 }}>Suite</span>
          </div>
          <h2 style={{ marginTop: 4 }}>Base de datos SQL Server</h2>
          <span className="xs muted">
            {status.status === 'error'
              ? 'No hay conexión con la base de datos. Reintenta o corrige los datos de conexión.'
              : 'Prime Suite guarda sus datos en SQL Server. Indica a qué servidor conectarse.'}
          </span>
        </div>

        {status.status === 'error' && status.error && !error && <div className="alert warn small">{status.error}</div>}
        {error && <div className="alert error small">{error}</div>}
        {done && <div className="alert ok small">{done}</div>}

        {status.status === 'error' && status.configured && (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="xs muted">Se reintenta solo cada 30 segundos.</span>
            <button type="button" className="btn" onClick={retry} disabled={!!busy}>{busy === 'retry' ? 'Conectando…' : 'Reintentar ahora'}</button>
          </div>
        )}

        <label className="field">Código de configuración
          <span className="hint">Está en el log del contenedor (docker compose logs app) y en /data/codigo-configuracion.txt</span>
          <input className="input mono" value={f.code} onChange={set('code')} placeholder="XXXXX-XXXXX" autoComplete="off" required />
        </label>
        <div className="grid-2">
          <label className="field">Servidor<span className="hint">Nombre o IP; admite servidor\INSTANCIA</span>
            <input className="input mono" value={f.server} onChange={set('server')} required />
          </label>
          <label className="field">Puerto<span className="hint">{named ? 'No se usa con instancia con nombre' : 'Normalmente 1433'}</span>
            <input className="input mono" value={named ? '' : f.port} onChange={set('port')} inputMode="numeric" disabled={named} />
          </label>
          <label className="field">Base de datos<span className="hint">Una distinta por entorno · se crea si no existe</span>
            <input className="input mono" value={f.database} onChange={(e) => { set('database')(e); setInUse(false); setTakeOver(false); }}
              placeholder={status.suggestedDatabase ? `p. ej. ${status.suggestedDatabase}` : 'p. ej. PrimeSuite_Dev'} required />
          </label>
          <span />
          <label className="field">Usuario<input className="input" value={f.user} onChange={set('user')} autoComplete="off" required /></label>
          <label className="field">Contraseña<input className="input" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" required={!status.configured} /></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.encrypt} onChange={set('encrypt')} /> Cifrar la conexión</label>
        <label className="check"><input type="checkbox" checked={f.trustServerCertificate} onChange={set('trustServerCertificate')} /> Confiar en el certificado del servidor</label>

        {status.sqlite?.exists && !status.sqlite.migrated && (
          <div className="alert info small">Al conectar se copiarán a SQL Server todos los datos actuales de Prime Suite (fichero SQLite). No se sobrescribe nada que ya exista en la base de datos.</div>
        )}
        <div className="alert info small">
          Desarrollo y producción pueden usar el mismo servidor, pero cada uno con <b>su propia base de datos</b>.
          Si eliges una que ya usa otra instalación de Prime Suite, se avisa y no se conecta.
          {status.installation && <> Esta instalación: <span className="mono">{status.installation}</span>.</>}
        </div>
        {inUse && (
          <label className="check" style={{ alignItems: 'flex-start' }}>
            <input type="checkbox" checked={takeOver} onChange={(e) => setTakeOver(e.target.checked)} />
            <span>Es la base de datos de <b>esta misma</b> instalación (p. ej. tras reinstalarla): usarla igualmente. La otra instalación dejará de poder conectarse a ella.</span>
          </label>
        )}

        <button className="btn primary" disabled={!!busy || !!done}>{busy === 'save' ? 'Conectando y creando tablas…' : 'Guardar y conectar'}</button>
      </form>
    </div>
  );
}
