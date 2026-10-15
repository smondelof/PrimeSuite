// Cliente HTTP del portal.
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}

async function request<T>(method: string, url: string, data?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    credentials: 'same-origin',
    headers: data !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: data !== undefined ? JSON.stringify(data) : undefined
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && !url.startsWith('/api/auth') && !url.startsWith('/api/me')) window.dispatchEvent(new Event('ps:unauthorized'));
    // Sin conexión a SQL Server: la app vuelve a la pantalla de conexión.
    if (res.status === 503 && json?.code === 'DB_SETUP' && !url.startsWith('/api/db/')) window.dispatchEvent(new Event('ps:dbsetup'));
    throw new ApiError(res.status, json?.error || `Error ${res.status}`, json?.code);
  }
  return json as T;
}

export const api = {
  get: <T>(u: string) => request<T>('GET', u),
  post: <T>(u: string, d: unknown = {}) => request<T>('POST', u, d),
  put: <T>(u: string, d: unknown) => request<T>('PUT', u, d),
  del: <T>(u: string, d?: unknown) => request<T>('DELETE', u, d)
};

// ---- Tipos compartidos con el backend ----
export type ModuleRole = 'admin' | 'user' | 'viewer';
export type AuthMethod = 'oidc' | 'prime_token' | 'none';
export type OpenMode = 'iframe' | 'tab' | 'fullscreen' | 'native';

export interface Me {
  user: { id: string; email: string; username?: string; firstName: string; lastName: string; role: 'superadmin' | 'admin' | 'user'; companyId: string };
  company: { id: string; name: string; code: string };
  groups: { id: string; name: string }[];
  isAdmin: boolean;
  isSuper: boolean;
  moduleCount: number;
}

export interface Category { id: string; name: string; color: string; order: number; enabled: boolean }

export interface WidgetDef { id: string; title: string; type: 'kpi' | 'list' | 'chart' | 'iframe' | 'superset' | 'evalos'; dashboardId?: string; screen?: string; endpoint?: string; size: 's' | 'm' | 'l'; refreshSec: number }

export interface PortalApp {
  id: string; name: string; description: string; initials: string; color: string; iconUrl?: string; iconGlyph?: string; categoryId: string | null;
  openMode: OpenMode; authMethod: AuthMethod; role: ModuleRole; widgets: number; nativeUrl?: string;
}

/** Inicio de sesión automático de un módulo sin SSO. La contraseña compartida nunca vuelve del servidor. */
export interface AutoLoginView {
  enabled: boolean;
  method: 'form' | 'url';
  loginUrl: string;
  userField: string;
  passField: string;
  extraFields: { name: string; value: string }[];
  credentials: 'user' | 'shared';
  sharedUser?: string;
  hasSharedPassword?: boolean;
  /** Solo al enviar: contraseña compartida nueva / borrarla. */
  sharedPassword?: string;
  clearSharedPassword?: boolean;
}

/** API REST de una integración (OAuth2 client credentials). El Client Secret nunca llega al navegador. */
export interface ApiRestView { apiUrl: string; tokenUrl: string; clientId: string; hasSecret: boolean; soapUrl?: string; updatedAt?: string; updatedBy?: string }
export interface ApiRestTest { ok: boolean; ms: number; status?: number; tokenType?: string; expiresIn?: number; scope?: string; error?: string }

export interface AdminModule {
  id: string; clientId: string; name: string; description: string; categoryId: string | null; initials: string; color: string; iconUrl?: string; iconGlyph?: string;
  url: string; openMode: OpenMode; authMethod: AuthMethod; tokenDelivery: 'fragment' | 'query' | 'form_post'; tokenParam: string; tokenTtlSec: number;
  redirectUris: string[]; postLogoutRedirectUris: string[]; initiateLoginUri?: string; responseTypes?: string[]; alwaysEmail?: boolean; autoLogin?: AutoLoginView; ssoDebug?: boolean; apiRest?: ApiRestView; defaultRole: ModuleRole | null;
  manifestUrl?: string; widgets: WidgetDef[]; enabled: boolean; order: number; hasSecret: boolean; companyCount?: number;
  createdAt: string; updatedAt: string;
}

export interface Company { id: string; name: string; code: string; taxId?: string; email?: string; enabledModules: string[]; moduleUrls: Record<string, string>; userCount?: number }
export interface Group { id: string; companyId: string | null; name: string; description?: string; moduleRoles: Record<string, ModuleRole>; memberCount?: number }
export interface AdminUser {
  id: string; companyId: string; companyName?: string; email: string; username?: string; firstName: string; lastName: string;
  role: 'superadmin' | 'admin' | 'user'; groupIds: string[]; groups?: string[]; status: 'active' | 'pending' | 'disabled'; lastLoginAt?: string; createdAt: string;
  evalos?: { initials: string; at: string }; evalosError?: string;
  /** Código del empleado de Evalos 8 vinculado (PERSONAL.EM_CODI). */
  evalosEmployee?: string;
}

export const AUTH_LABEL: Record<AuthMethod, string> = { oidc: 'OpenID Connect', prime_token: 'Prime Token', none: 'Sin SSO' };
export const OPEN_LABEL: Record<OpenMode, string> = { iframe: 'Embebido', tab: 'Pestaña nueva', fullscreen: 'Pantalla completa', native: 'Módulo nativo' };
export const ROLE_LABEL: Record<ModuleRole, string> = { admin: 'Administrador', user: 'Usuario', viewer: 'Lectura' };
export const PORTAL_ROLE_LABEL = { superadmin: 'Superadministrador', admin: 'Administrador', user: 'Usuario' } as const;

export const fmtDate = (s?: string) => (s ? new Date(s).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
/** Iniciales para el avatar. Con el nombre completo en un solo campo, usa sus dos primeras palabras. */
export const initialsOf = (a: string, b = '') => {
  if (b) return ((a[0] || '') + (b[0] || '')).toUpperCase();
  const p = a.trim().split(/\s+/);
  return ((p[0]?.[0] || '') + (p[1]?.[0] || '')).toUpperCase();
};

// ---- Prime Insights ----
export interface InsightCategory { id: string; name: string; order: number }
export interface InsightDashboard {
  id: string; serverId: string | null; name: string; description?: string; categoryId: string | null; supersetId?: number;
  embeddedUuid?: string; dashboardUrl?: string; order: number; enabled: boolean; showAsWidget: boolean;
  companyIds: string[]; groupIds: string[]; rlsClause?: string; updatedAt?: string;
}
export interface SupersetServer { id: string; name: string; baseUrl: string; username: string; provider: 'db' | 'ldap'; hasPassword: boolean; updatedAt: string }

// ---- Atajos de Evalos ----
export interface EvalosScreenInfo { key: string; title: string; description: string; glyph: string; widgetSize: 's' | 'm' | 'l' }
export interface EvalosMe {
  role: ModuleRole; canEdit: boolean; canDelete: boolean; canConfigure: boolean;
  configured: boolean; engine: 'mssql' | 'demo' | null; connHint: string | null; screens: EvalosScreenInfo[];
}
export interface EvalosMapping {
  departments: { schema?: string; table: string; code: string; description: string };
  employees: { schema?: string; table: string; code: string; name: string; department: string; endDate: string };
  departmentHistory?: { schema?: string; table: string; department: string } | null;
}
export interface EvalosConfigView {
  companyId: string; companyName: string; configured: boolean; engine: 'mssql' | 'demo'; hasConnection: boolean; connHint: string | null;
  mapping: EvalosMapping; uppercase: boolean; hiddenScreens: string[]; updatedAt: string | null; updatedBy: string | null;
  companies?: { id: string; name: string; code: string }[];
  /** Resultado del alta en Evalos 8 de los usuarios pendientes al guardar la conexión. */
  userSync?: { created: number; failed: { email: string; error: string }[] } | null;
}
export interface EvalosColumn { name: string; type: string; maxLength: number | null; nullable: boolean }
export interface EvalosDetect { mapping: EvalosMapping; candidates: { schema: string; name: string; columns: EvalosColumn[] }[]; warnings: string[] }
export interface EvalosDepartment { code: string; description: string; employees: number; active: number }
export interface EvalosDepartmentEmployee { code: string; name: string; active: boolean; endDate?: string }
export interface EvalosDepartmentsResponse {
  items: EvalosDepartment[]; limits: { code: number | null; description: number | null };
  canEdit: boolean; canDelete: boolean; uppercase: boolean; engine: 'mssql' | 'demo';
}

// Personal (tabla PERSONAL). Fechas en AAAA-MM-DD; '' = sin valor.
export interface EvalosPersonalInput {
  code: string; name: string; card: string; email: string; hireDate: string; endDate: string;
  company: string; department: string; section: string; area: string; consultas: string; solicitudes: string;
  /** EM_CONV → PS_CONVENIOS */
  convenio: string;
  /** EM_WORKFLOWROL: EMPLEADO, RESPONSABLE, RRHH o '' (perfil de solicitudes no gestionado por Prime Suite). */
  workflowRol: string;
}
export interface EvalosPersonal extends EvalosPersonalInput { active: boolean }
/** Históricos de la ficha (HIS_TARJETA, HIS_EMPRESA, HIS_DEPMENTO, HIS_SECCION, HIS_AREA). */
export type EvalosHistoryKind = 'card' | 'company' | 'department' | 'section' | 'area';
export type EvalosOrgKind = Exclude<EvalosHistoryKind, 'card'>;
/** Tramo de un histórico. to '' = sin fecha de baja. */
export interface EvalosHistoryEntry { value: string; from: string; to: string; type: string; active: boolean; recordedAt: string; user: string }
/** periods = periodos de alta/baja (HIS_VIGENCIA). */
export interface EvalosPersonalDetail extends EvalosPersonal {
  history: Record<EvalosHistoryKind, EvalosHistoryEntry[]>; periods: EvalosHistoryEntry[];
  /** Avisos de vacaciones o límites vigentes con más disfrutado que disponible. */
  periodAlerts?: string[];
}
/** Resultado de generar periodos (VACACIONES, INCIDENCIALIMITE) desde el convenio. */
export interface EvalosPeriodSync { created: number; updated: number; deleted?: number; alerts: { employee: string; text: string }[]; warnings: string[] }
export interface EvalosLookupItem { code: string; description: string }
export type EvalosPersonalLookupKey = 'company' | 'department' | 'section' | 'area' | 'consultas' | 'solicitudes' | 'convenio';
export interface EvalosPersonalResponse {
  items: EvalosPersonal[];
  /** null = la tabla no existe en esta instalación de Evalos (se escribe el código a mano). */
  lookups: Record<EvalosPersonalLookupKey, EvalosLookupItem[] | null>;
  limits: Partial<Record<keyof EvalosPersonalInput, number | null>>;
  canEdit: boolean; canDelete: boolean; uppercase: boolean; engine: 'mssql' | 'demo';
}

/** Sección «Empleado en Evalos» del alta de usuario: catálogos y límites de la empresa. */
export type EvalosEmployeeFormInfo =
  | { configured: false }
  | { configured: true; engine: 'mssql' | 'demo'; uppercase: boolean; lookups: EvalosPersonalResponse['lookups']; limits: EvalosPersonalResponse['limits'] };

// Calendarios
export type EvalosHolidayType = 'NACIONAL' | 'AUTONOMICO' | 'LOCAL' | 'EMPRESA';
export interface EvalosHoliday { date: string; type: EvalosHolidayType; description: string }
export interface EvalosCalendar { code: string; name: string; year: number; employees: number; holidays: number }
export interface EvalosCalendarDetail extends EvalosCalendar { days: EvalosHoliday[] }
export interface EvalosCalendariosResponse { calendars: EvalosCalendar[]; canEdit: boolean; canDelete: boolean; engine: 'mssql' | 'demo' }

// Convenios (PS_CONVENIOS): periodos de un año desde su día/mes de inicio.
/** Límite de una incidencia: unidad D = días (admite medios días), H = horas (valor en minutos). */
/** Plus por antigüedad: a partir de `years` años, `value` más en la unidad de su línea (días, o minutos si es en horas). */
export interface EvalosConvenioPlus { years: number; value: number }
/** Límite de incidencia: siempre en horas (valor y pluses en minutos). fromDays: estaba guardado en días y se ha pasado a horas. */
export interface EvalosConvenioLimit { incidence: string; unit: 'H'; value: number; pluses?: EvalosConvenioPlus[]; fromDays?: number }
/** Periodo de vacaciones de un tipo de TIPOSVACACIONES. */
/** Fin del periodo: endDay/endMonth, del año siguiente si endNextYear (sin fin: un año menos un día). */
/** Periodo de vacaciones del convenio: en días (days, medios días) o en horas (unit H, minutes; days = 0). Pluses en la misma unidad. */
export interface EvalosConvenioVacation { type: string; day: number; month: number; endDay?: number; endMonth?: number; endNextYear?: boolean; unit?: 'D' | 'H'; days: number; minutes?: number; pluses?: EvalosConvenioPlus[] }
export interface EvalosConvenio {
  code: string; name: string;
  /** Personas con este convenio (EM_CONV) y, de ellas, en alta. */
  employees?: number; active?: number;
  vacations: EvalosConvenioVacation[];
  incidenceDay: number; incidenceMonth: number;
  incidenceEndDay?: number; incidenceEndMonth?: number; incidenceEndNextYear?: boolean;
  limits: EvalosConvenioLimit[];
}
/** Empleado para la ventana del convenio, con su convenio actual. */
export interface EvalosConvenioPerson { code: string; name: string; company: string; department: string; section: string; area: string; convenio: string; active: boolean }
/** Personal para la ventana del convenio, con los nombres de empresa, departamento, sección y área. */
export interface EvalosConvenioPeopleResponse { items: EvalosConvenioPerson[]; org: Record<EvalosOrgKind, EvalosLookupItem[]> }
export interface EvalosIncidence { code: string; name: string; type?: string }
export interface EvalosVacationType { code: string; name: string; color: string | null }
export interface EvalosVacationTypesInfo { items: EvalosVacationType[]; codeMax: number; nameMax: number; numericCode: boolean; hasColor: boolean }
export interface EvalosVacationTypeCreated { type: EvalosVacationType; row: Record<string, unknown>; filled: string[] }
export interface EvalosConveniosResponse {
  convenios: EvalosConvenio[]; incidences: EvalosIncidence[]; incidencesError: string;
  vacationTypes: EvalosVacationTypesInfo; vacationTypesError: string;
  /** PERSONAL tiene la columna EM_CONV (se puede vincular personal). */
  linkable: boolean;
  canEdit: boolean; canDelete: boolean; engine: 'mssql' | 'demo';
  /** Faltan las tablas en la BD de Evalos 8: mensaje y script para crearlas. */
  missing: { message: string; script: string } | null;
}

// Perfiles Workflow (por departamentos): WORKFLOW + PS_WF2PERFILES + PS_WF2VALIDA
export type EvalosWfRole = 'EMPLEADO' | 'RESPONSABLE' | 'RRHH';
/** Resultado de recalcular los perfiles: creados, actualizados, borrados y personas con perfil nuevo. */
export interface EvalosWorkflowSync { created: { code: string; name: string }[]; updated: string[]; removed: { code: string; name: string }[]; assigned: number; warnings: string[] }
export interface EvalosWfPerson {
  code: string; name: string; active: boolean; email: string; department: string; workflowRol: string; profile: string;
  /** Quién la valida, asignado a mano (sustituye a los responsables de su departamento). */
  manual: string[];
  /** Departamentos de más que valida (responsables). */
  extraDepts: string[];
  /** Departamentos que valida (responsables en alta): el suyo y los añadidos. */
  validates: string[];
  /** Nivel 1 calculado y si sale de la asignación manual. */
  level1: string[]; level1Manual: boolean;
}
export interface EvalosWfProfile {
  code: string; name: string;
  /** Rol, departamento, departamentos que ve y validadores a mano si lo ha creado Prime Suite; null = perfil de Evalos (no se edita aquí). */
  dyn: { rol: string; department: string; depts: string[]; manual: string[] } | null;
  template: boolean;
  /** Autorizadores por nivel (WF_NIV1…WF_NIV4). */
  levels: Record<string, string[]>;
  /** Orden de validación por solicitud (columna → «1,2», «0» o vacío). */
  orders: Record<string, string>;
  filter: string; people: number; alerts: string[];
}
export interface EvalosWorkflowResponse {
  canEdit: boolean; canDelete: boolean; canConfigure: boolean; engine: 'mssql' | 'demo';
  settings: { templates: Record<EvalosWfRole, string>; prefix: string };
  roles: EvalosWfRole[];
  requests: { n: number; col: string; label: string }[];
  levelCols: string[];
  /** No se han podido crear las tablas: motivo y script como último recurso. */
  missing: { message: string; script: string } | null;
  /** Columnas que faltan en PERSONAL (EM_WORKFLOWROL) y no se han podido crear. */
  missingColumns?: string[];
  departments?: EvalosLookupItem[];
  profiles?: EvalosWfProfile[];
  people?: EvalosWfPerson[];
  /** Cambios que se aplicarían al recalcular ahora. */
  pending?: EvalosWorkflowSync;
}

// Correcciones
export interface EvalosMarcajePunch { time: string; type: 'E' | 'S' }
export interface EvalosMarcaje { id: string; employee: string; employeeName: string; date: string; punches: EvalosMarcajePunch[]; status: 'OK' | 'INCIDENCIA'; issue?: string }
export interface EvalosSolicitud { id: string; employee: string; employeeName: string; type: string; from: string; to: string; days: number; reason?: string; status: 'PENDIENTE' | 'APROBADA' | 'RECHAZADA'; createdAt: string }
export interface EvalosAusencia { id: string; employee: string; employeeName: string; type: string; from: string; to: string; days: number; reason?: string }
export interface EvalosEmployeeBrief { code: string; name: string; company?: string; department?: string; section?: string; area?: string }
export type EvalosOrgKey = 'company' | 'department' | 'section' | 'area';
export interface EvalosCorreccionesResponse {
  /** 'rest' = conexión real: los marcajes se piden a /api/evalos/correcciones/marcajes (EvalosRest). */
  mode?: 'rest';
  /** Con conexión real: valores de empresa, departamento, sección y área para los filtros de Marcajes. */
  lookups?: Partial<Record<EvalosOrgKey, { code: string; description: string }[] | null>>;
  marcajes: EvalosMarcaje[]; solicitudes: EvalosSolicitud[]; ausencias: EvalosAusencia[]; employees: EvalosEmployeeBrief[];
  canEdit: boolean; canDelete: boolean; engine: 'mssql' | 'demo';
}
// Correcciones con conexión real (EvalosRest)
export interface EvalosBookingRef { id?: string; installation?: string; clock?: string; lector?: string; card?: string; ip?: string; debug?: string }
export interface EvalosRestPunch { time: string; seconds: string; type: 'E' | 'S'; incidence: string; incidenceName?: string; terminal?: string; manual: boolean; anomaly?: string; ref?: EvalosBookingRef }
export interface EvalosRestMarcaje { id: string; employee: string; employeeName: string; date: string; punches: EvalosRestPunch[]; status: 'OK' | 'INCIDENCIA'; issues: string[]; schedule?: string; absence?: string; holiday?: string; day?: EvalosDayInfo }
export interface EvalosDayInfo { kind: 'absence' | 'holiday' | 'shift'; code: string; name: string; color: string | null }
export interface EvalosReportPreview { rows: number; anomalies: number; columns: string[]; sample: string }
export interface EvalosCalendarPreview { rows: number; days: number; columns: string[]; sample: string; dateFormat: string }
export interface EvalosRestMarcajesResponse { marcajes: EvalosRestMarcaje[]; warnings: string[]; ms: number; report: string; reportPreview: EvalosReportPreview | null; calendarPreview: EvalosCalendarPreview | null; hiddenUnknown?: number; from: string; to: string }
export interface EvalosIncidencia { code: string; name: string }

/** Paso del log de inicio de sesión (integraciones con «Ver log de inicio de sesión»). */
export interface SsoTraceEvent {
  id: string; at: string; userId: string | null; userEmail?: string;
  channel: 'portal' | 'navegador' | 'app'; status: 'info' | 'ok' | 'warn' | 'error';
  title: string; detail?: string; data?: Record<string, unknown>;
}
