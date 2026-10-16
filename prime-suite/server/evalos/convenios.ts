// Atajos de Evalos · Convenios.
// Un convenio predefine, para el personal al que se asigne:
//  - tantos periodos de vacaciones como se quiera: tipo (TIPOSVACACIONES), inicio y fin (día/mes) y lo que
//    corresponde en el periodo, en días (admite medios días) o en horas;
//  - el inicio (día/mes) del periodo de incidencias y, por cada incidencia de INCIDENC, su límite en horas
//    (los límites antiguos guardados en días se leen pasados a horas, a 8 h por día).
// Cada periodo dura un año desde su día/mes de inicio (p. ej. 01/04 → del 01/04 al 31/03 del año siguiente).
// En la base de datos de Evalos 8 se guarda en cuatro tablas propias de Prime Suite:
//  PS_CONVENIOS             cabecera (una fila por convenio)
//  PS_CONVENIOS_VACACIONES  periodos de vacaciones (una fila por periodo, numeradas por convenio)
//  PS_CONVENIOS_LIMITES     límites de incidencia (una fila por convenio e incidencia)
//  PS_CONVENIOS_PLUSES      pluses por antigüedad de cada periodo de vacaciones y de cada límite de incidencia
import { HttpError } from '../http.ts';
import type { Convenio, ConvenioLimit, ConvenioPlus, ConvenioVacation, PeriodEnd } from './types.ts';
import { defaultEnd } from './convperiods.ts';

export const CONVENIOS_TABLE = 'PS_CONVENIOS';
export const VACACIONES_TABLE = 'PS_CONVENIOS_VACACIONES';
export const LIMITES_TABLE = 'PS_CONVENIOS_LIMITES';
export const PLUSES_TABLE = 'PS_CONVENIOS_PLUSES';
export const MAX_PLUSES = 30;
export const MAX_PLUS_YEARS = 60;
export const CONVENIO_CODE_MAX = 10;
export const CONVENIO_NAME_MAX = 60;
export const MAX_VACATION_DAYS = 365;
export const MAX_VACATION_MINUTES = 8784 * 60; // un año bisiesto entero
export const MAX_LIMIT_DAYS = 366;
export const MAX_LIMIT_MINUTES = 8784 * 60; // un año bisiesto entero
export const MAX_LIMITS = 200;
export const MAX_VACATIONS = 50;
export const VACATION_TYPE_MAX = 10;

/** Días de cada mes. Febrero tiene 28: un periodo no puede empezar el 29/02, que no existe todos los años. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function validDayMonth(day: number, month: number) {
  return Number.isInteger(day) && Number.isInteger(month) && month >= 1 && month <= 12 && day >= 1 && day <= MONTH_DAYS[month - 1];
}

/** Periodo de un año que contiene `ref` (AAAA-MM-DD) y empieza el día/mes indicado. Fechas AAAA-MM-DD. */
export function periodAround(day: number, month: number, ref: string): { from: string; to: string } {
  const [y, m, d] = ref.split('-').map(Number);
  const startYear = m > month || (m === month && d >= day) ? y : y - 1;
  const from = new Date(Date.UTC(startYear, month - 1, day));
  const to = new Date(Date.UTC(startYear + 1, month - 1, day - 1));
  const iso = (x: Date) => x.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to) };
}

const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : NaN);
const halfDays = (n: number) => Math.round(n * 2) === n * 2;

/**
 * Fin de un periodo: día/mes válidos y, si es del mismo año, posterior al inicio. Sin fin, el de por defecto
 * (un año menos un día). Puede pasar del año (p. ej. del 01/01 al 31/01 del año siguiente).
 */
function sanitizeEnd(b: any, keys: [string, string, string], day: number, month: number, what: string): PeriodEnd {
  const [kd, km, ky] = keys;
  if (b?.[kd] === undefined && b?.[km] === undefined) return defaultEnd(day, month);
  const endDay = num(b?.[kd]), endMonth = num(b?.[km]), endNextYear = b?.[ky] === true || b?.[ky] === 1 || b?.[ky] === '1';
  if (!validDayMonth(endDay, endMonth)) throw new HttpError(400, `El fin ${what} no es una fecha válida (día/mes)`);
  if (!endNextYear && endMonth * 100 + endDay <= month * 100 + day) throw new HttpError(400, `El fin ${what} es anterior o igual a su inicio: si termina el año siguiente, márcalo así`);
  return { endDay, endMonth, endNextYear };
}

/** Pluses por antigüedad de una línea: años enteros (1-60, sin repetir) y valor en días (medios) o minutos. */
function sanitizePluses(raw: unknown, unit: 'D' | 'H', what: string): ConvenioPlus[] {
  const list: any[] = Array.isArray(raw) ? raw : [];
  if (list.length > MAX_PLUSES) throw new HttpError(400, `Como máximo ${MAX_PLUSES} pluses en ${what}`);
  const seen = new Set<number>();
  return list.map((p) => {
    const years = num(p?.years), value = num(p?.value);
    if (!Number.isInteger(years) || years < 1 || years > MAX_PLUS_YEARS) throw new HttpError(400, `Los años de los pluses de ${what} deben ser un número entero de 1 a ${MAX_PLUS_YEARS}`);
    if (seen.has(years)) throw new HttpError(400, `Hay dos pluses a los ${years} años en ${what}`);
    seen.add(years);
    if (unit === 'D' ? !(Number.isFinite(value) && value > 0 && value <= MAX_LIMIT_DAYS && halfDays(value)) : !(Number.isInteger(value) && value > 0 && value <= MAX_LIMIT_MINUTES))
      throw new HttpError(400, `El plus de ${years} años de ${what} debe ser ${unit === 'D' ? 'de 0,5 días o más (admite medios días)' : 'una cantidad de horas mayor que 00:00'}`);
    return { years, value };
  }).sort((a, b) => a.years - b.years);
}

/** Horas de un día al pasar a horas los límites que se guardaron en días (versión anterior). */
export const LIMIT_HOURS_PER_DAY = 8;
/** Minutos de un día de vacaciones en los periodos en horas si no se indica otra cosa (8 h). */
export const DEFAULT_MINUTES_PER_DAY = 480;

/**
 * Valida y normaliza un convenio recibido de la interfaz.
 * Las vacaciones van en días (admiten medios días) o en horas (minutos); los límites de incidencia, siempre en horas.
 */
export function sanitizeConvenio(b: any, opts: { uppercase: boolean; incidences?: Set<string>; vacationTypes?: Set<string> }): Convenio {
  const code = String(b?.code ?? '').trim();
  const finalCode = opts.uppercase ? code.toUpperCase() : code;
  if (!finalCode) throw new HttpError(400, 'Indica el código del convenio');
  if (finalCode.length > CONVENIO_CODE_MAX) throw new HttpError(400, `El código admite como máximo ${CONVENIO_CODE_MAX} caracteres`);
  if (!/^[A-Za-z0-9_.-]+$/.test(finalCode)) throw new HttpError(400, 'El código solo admite letras, números, guion, punto y guion bajo');
  const name = String(b?.name ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new HttpError(400, 'Indica el nombre del convenio');
  if (name.length > CONVENIO_NAME_MAX) throw new HttpError(400, `El nombre admite como máximo ${CONVENIO_NAME_MAX} caracteres`);

  // Periodos de vacaciones: tantos como se quiera (también del mismo tipo), en el orden en que se dan.
  const rawVac: any[] = Array.isArray(b?.vacations) ? b.vacations : [];
  if (rawVac.length > MAX_VACATIONS) throw new HttpError(400, `Como máximo ${MAX_VACATIONS} periodos de vacaciones por convenio`);
  const seenVac = new Set<string>();
  const vacations: ConvenioVacation[] = rawVac.map((v, i) => {
    const type = String(v?.type ?? '').trim();
    if (!type) throw new HttpError(400, `Elige el tipo de vacaciones de la línea ${i + 1}`);
    if (type.length > VACATION_TYPE_MAX) throw new HttpError(400, `El tipo de vacaciones admite como máximo ${VACATION_TYPE_MAX} caracteres`);
    if (opts.vacationTypes && !opts.vacationTypes.has(type)) throw new HttpError(400, `El tipo de vacaciones ${type} no existe en TIPOSVACACIONES`);
    const day = num(v?.day), month = num(v?.month);
    if (!validDayMonth(day, month)) throw new HttpError(400, `El inicio del periodo de ${type} no es una fecha válida (día/mes)`);
    const key = `${type}|${day}|${month}`;
    if (seenVac.has(key)) throw new HttpError(400, `El periodo de ${type} que empieza el ${String(day).padStart(2, '0')}/${String(month).padStart(2, '0')} está repetido`);
    seenVac.add(key);
    const end = sanitizeEnd(v, ['endDay', 'endMonth', 'endNextYear'], day, month, `del periodo de ${type}`);
    // Periodo en días (admite medios días) o en horas (el valor llega en minutos).
    const unit: 'D' | 'H' = String(v?.unit ?? 'D').toUpperCase() === 'H' ? 'H' : 'D';
    if (unit === 'H') {
      const minutes = num(v?.minutes);
      if (!Number.isInteger(minutes) || minutes <= 0 || minutes > MAX_VACATION_MINUTES)
        throw new HttpError(400, `Las horas de vacaciones de ${type} deben ser una cantidad mayor que 00:00`);
      // Cuántas horas es un día de vacaciones (MINUTOSDIA de VACACIONES): al asignar un día se asignan esas horas.
      const mpd = v?.minutesPerDay == null || v?.minutesPerDay === '' ? DEFAULT_MINUTES_PER_DAY : num(v.minutesPerDay);
      if (!Number.isInteger(mpd) || mpd <= 0 || mpd > 24 * 60)
        throw new HttpError(400, `Las horas de un día de vacaciones de ${type} deben estar entre 00:01 y 24:00`);
      return { type, day, month, ...end, unit, days: 0, minutes, minutesPerDay: mpd, pluses: sanitizePluses(v?.pluses, 'H', `el periodo de ${type}`) };
    }
    const days = num(v?.days);
    if (!Number.isFinite(days) || days <= 0 || days > MAX_VACATION_DAYS || !halfDays(days))
      throw new HttpError(400, `Los días de vacaciones de ${type} deben ser de 0,5 a ${MAX_VACATION_DAYS} (admite medios días)`);
    return { type, day, month, ...end, unit, days, pluses: sanitizePluses(v?.pluses, 'D', `el periodo de ${type}`) };
  });

  const incidenceDay = num(b?.incidenceDay), incidenceMonth = num(b?.incidenceMonth);
  if (!validDayMonth(incidenceDay, incidenceMonth)) throw new HttpError(400, 'El inicio del periodo de incidencias no es una fecha válida (día/mes)');
  const ie = sanitizeEnd(b, ['incidenceEndDay', 'incidenceEndMonth', 'incidenceEndNextYear'], incidenceDay, incidenceMonth, 'del periodo de incidencias');

  const raw: any[] = Array.isArray(b?.limits) ? b.limits : [];
  if (raw.length > MAX_LIMITS) throw new HttpError(400, `Como máximo ${MAX_LIMITS} incidencias por convenio`);
  const seen = new Set<string>();
  const limits: ConvenioLimit[] = raw.map((l, i) => {
    const incidence = String(l?.incidence ?? '').trim();
    if (!incidence) throw new HttpError(400, `Elige la incidencia de la línea ${i + 1}`);
    if (seen.has(incidence)) throw new HttpError(400, `La incidencia ${incidence} está repetida`);
    seen.add(incidence);
    if (opts.incidences && !opts.incidences.has(incidence)) throw new HttpError(400, `La incidencia ${incidence} no existe en la tabla INCIDENC`);
    // Las incidencias van siempre en horas: el valor llega en minutos.
    const value = num(l?.value);
    if (!Number.isInteger(value) || value <= 0 || value > MAX_LIMIT_MINUTES)
      throw new HttpError(400, `El límite de la incidencia ${incidence} debe ser una cantidad de horas mayor que 00:00`);
    return { incidence, unit: 'H' as const, value, pluses: sanitizePluses(l?.pluses, 'H', `la incidencia ${incidence}`) };
  }).sort((a, b) => a.incidence.localeCompare(b.incidence));

  return { code: finalCode, name, vacations, incidenceDay, incidenceMonth, incidenceEndDay: ie.endDay, incidenceEndMonth: ie.endMonth, incidenceEndNextYear: ie.endNextYear, limits };
}

/** Script de SQL Server que crea las tablas de convenios en la BD de Evalos 8 (se puede lanzar varias veces). */
export function conveniosSql(schema = 'dbo') {
  const s = `[${(schema || 'dbo').replace(/]/g, ']]')}]`;
  const q = (x: string) => x.replace(/'/g, "''"); // dentro de EXEC (N'...')
  return `-- Atajos de Evalos (Prime Suite) · Convenios
-- Crea las tablas de convenios en la base de datos de Evalos 8. Se puede ejecutar varias veces: solo crea lo que falta.
--
-- ${CONVENIOS_TABLE}: un registro por convenio.
--   CV_CODI  código del convenio
--   CV_DESC  nombre
--   CV_IDIA / CV_IMES  día y mes de inicio del periodo de incidencias
--   CV_IFDI / CV_IFME / CV_IFAN  día y mes de fin del periodo de incidencias; CV_IFAN 1 = del año siguiente
--                      (sin valor: un año menos un día)
--   CV_FECH / CV_HORA / CV_USUA  última modificación: fecha aaaammdd, hora hhmm e iniciales del usuario (como Evalos)
--
-- ${VACACIONES_TABLE}: periodos de vacaciones de cada convenio (tantos como se quiera, también del mismo tipo).
--   CA_CONV  código del convenio (${CONVENIOS_TABLE}.CV_CODI; se borra con el convenio)
--   CA_LINE  número de periodo dentro del convenio (1, 2, 3…)
--   CA_TVAC  tipo de vacaciones (TIPOSVACACIONES.CODIGO)
--   CA_VDIA / CA_VMES  día y mes de inicio del periodo
--   CA_FDIA / CA_FMES / CA_FANO  día y mes de fin del periodo; CA_FANO 1 = del año siguiente
--                      (sin valor: un año menos un día)
--   CA_UNID  D = periodo en días, H = periodo en horas (sin valor: en días)
--   CA_DIAS  días de vacaciones del periodo (admite medios días; solo en días)
--   CA_MINU  horas de vacaciones del periodo, en minutos (8:30 h = 510; solo en horas)
--   CA_MDIA  minutos de un día de vacaciones (solo en horas; sin valor: 480 = 8 h). Va a VACACIONES.MINUTOSDIA
--
-- ${LIMITES_TABLE}: límites de incidencia de cada convenio (una fila por incidencia).
--   CL_CONV  código del convenio (${CONVENIOS_TABLE}.CV_CODI; se borra con el convenio)
--   CL_INCI  código de la incidencia (INCIDENC.IN_CODI)
--   CL_UNID  H = límite en horas (las incidencias van siempre en horas; D solo en datos antiguos)
--   CL_DIAS  límite en días (solo datos antiguos con CL_UNID = 'D')
--   CL_MINU  límite en minutos (8:30 h = 510)
--
-- ${PLUSES_TABLE}: pluses por antigüedad (a partir de N años, X días u horas más).
--   CP_CONV  código del convenio (se borra con el convenio)
--   CP_TIPO  V = de un periodo de vacaciones, I = de un límite de incidencia
--   CP_REF   V: número del periodo (${VACACIONES_TABLE}.CA_LINE); I: código de la incidencia (CL_INCI)
--   CP_ANOS  años de antigüedad a partir de los que se aplica
--   CP_DIAS  días más (periodos de vacaciones en días; admite medios días)
--   CP_MINU  minutos más (periodos de vacaciones en horas y límites de incidencia)

IF OBJECT_ID(N'${s}.[${CONVENIOS_TABLE}]', N'U') IS NULL
BEGIN
  CREATE TABLE ${s}.[${CONVENIOS_TABLE}] (
    CV_CODI nvarchar(${CONVENIO_CODE_MAX}) NOT NULL,
    CV_DESC nvarchar(${CONVENIO_NAME_MAX}) NOT NULL,
    CV_IDIA tinyint       NOT NULL CONSTRAINT DF_PS_CONVENIOS_IDIA DEFAULT (1),
    CV_IMES tinyint       NOT NULL CONSTRAINT DF_PS_CONVENIOS_IMES DEFAULT (1),
    CV_FECH char(8)       NULL,
    CV_HORA char(4)       NULL,
    CV_USUA nvarchar(10)  NULL,
    CONSTRAINT PK_PS_CONVENIOS PRIMARY KEY (CV_CODI),
    CONSTRAINT CK_PS_CONVENIOS_INCIDENCIAS CHECK (CV_IMES BETWEEN 1 AND 12 AND CV_IDIA BETWEEN 1 AND 31)
  );
END;

-- Fin de los periodos (versiones anteriores: un año menos un día).
IF COL_LENGTH(N'${s}.[${CONVENIOS_TABLE}]', N'CV_IFDI') IS NULL
  ALTER TABLE ${s}.[${CONVENIOS_TABLE}] ADD CV_IFDI tinyint NULL, CV_IFME tinyint NULL, CV_IFAN bit NULL;

IF OBJECT_ID(N'${s}.[${VACACIONES_TABLE}]', N'U') IS NULL
BEGIN
  CREATE TABLE ${s}.[${VACACIONES_TABLE}] (
    CA_CONV nvarchar(${CONVENIO_CODE_MAX}) NOT NULL,
    CA_LINE smallint      NOT NULL,
    CA_TVAC nvarchar(${VACATION_TYPE_MAX}) NOT NULL,
    CA_VDIA tinyint       NOT NULL,
    CA_VMES tinyint       NOT NULL,
    CA_DIAS decimal(5, 1) NOT NULL,
    CONSTRAINT PK_PS_CONVENIOS_VACACIONES PRIMARY KEY (CA_CONV, CA_LINE),
    CONSTRAINT FK_PS_CONVENIOS_VACACIONES_CONV FOREIGN KEY (CA_CONV) REFERENCES ${s}.[${CONVENIOS_TABLE}] (CV_CODI) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT CK_PS_CONVENIOS_VACACIONES_INICIO CHECK (CA_VMES BETWEEN 1 AND 12 AND CA_VDIA BETWEEN 1 AND 31),
    CONSTRAINT CK_PS_CONVENIOS_VACACIONES_DIAS CHECK (CA_DIAS > 0 AND CA_DIAS <= ${MAX_VACATION_DAYS})
  );
END;

IF COL_LENGTH(N'${s}.[${VACACIONES_TABLE}]', N'CA_FDIA') IS NULL
  ALTER TABLE ${s}.[${VACACIONES_TABLE}] ADD CA_FDIA tinyint NULL, CA_FMES tinyint NULL, CA_FANO bit NULL;

-- Periodos de vacaciones en horas (versiones anteriores: solo en días). CA_DIAS pasa a admitir NULL.
IF COL_LENGTH(N'${s}.[${VACACIONES_TABLE}]', N'CA_UNID') IS NULL
BEGIN
  ALTER TABLE ${s}.[${VACACIONES_TABLE}] ADD CA_UNID char(1) NULL, CA_MINU int NULL;
  EXEC (N'IF EXISTS (SELECT 1 FROM sys.check_constraints WHERE name = N''CK_PS_CONVENIOS_VACACIONES_DIAS'' AND parent_object_id = OBJECT_ID(N''${q(q(s))}.[${VACACIONES_TABLE}]''))
      ALTER TABLE ${q(s)}.[${VACACIONES_TABLE}] DROP CONSTRAINT CK_PS_CONVENIOS_VACACIONES_DIAS;
    ALTER TABLE ${q(s)}.[${VACACIONES_TABLE}] ALTER COLUMN CA_DIAS decimal(5, 1) NULL;
    ALTER TABLE ${q(s)}.[${VACACIONES_TABLE}] ADD CONSTRAINT CK_PS_CONVENIOS_VACACIONES_VALOR CHECK (
      (ISNULL(CA_UNID, ''D'') = ''D'' AND CA_DIAS > 0 AND CA_DIAS <= ${MAX_VACATION_DAYS} AND CA_MINU IS NULL) OR
      (CA_UNID = ''H'' AND CA_MINU > 0 AND CA_DIAS IS NULL));');
END;

-- Horas de un día de vacaciones en los periodos en horas.
IF COL_LENGTH(N'${s}.[${VACACIONES_TABLE}]', N'CA_MDIA') IS NULL
  ALTER TABLE ${s}.[${VACACIONES_TABLE}] ADD CA_MDIA int NULL;

-- Tabla creada con una versión anterior del script (un solo periodo por tipo): se numeran los periodos.
IF COL_LENGTH(N'${s}.[${VACACIONES_TABLE}]', N'CA_LINE') IS NULL
BEGIN
  ALTER TABLE ${s}.[${VACACIONES_TABLE}] ADD CA_LINE smallint NOT NULL CONSTRAINT DF_PS_CONVENIOS_VACACIONES_LINE DEFAULT (1);
  EXEC (N'WITH n AS (SELECT CA_LINE, ROW_NUMBER() OVER (PARTITION BY CA_CONV ORDER BY CA_TVAC) AS r FROM ${q(s)}.[${VACACIONES_TABLE}])
    UPDATE n SET CA_LINE = r;
    ALTER TABLE ${q(s)}.[${VACACIONES_TABLE}] DROP CONSTRAINT PK_PS_CONVENIOS_VACACIONES;
    ALTER TABLE ${q(s)}.[${VACACIONES_TABLE}] ADD CONSTRAINT PK_PS_CONVENIOS_VACACIONES PRIMARY KEY (CA_CONV, CA_LINE);');
END;

IF OBJECT_ID(N'${s}.[${LIMITES_TABLE}]', N'U') IS NULL
BEGIN
  CREATE TABLE ${s}.[${LIMITES_TABLE}] (
    CL_CONV nvarchar(${CONVENIO_CODE_MAX}) NOT NULL,
    CL_INCI nvarchar(10)  NOT NULL,
    CL_UNID char(1)       NOT NULL,
    CL_DIAS decimal(5, 1) NULL,
    CL_MINU int           NULL,
    CONSTRAINT PK_PS_CONVENIOS_LIMITES PRIMARY KEY (CL_CONV, CL_INCI),
    CONSTRAINT FK_PS_CONVENIOS_LIMITES_CONV FOREIGN KEY (CL_CONV) REFERENCES ${s}.[${CONVENIOS_TABLE}] (CV_CODI) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT CK_PS_CONVENIOS_LIMITES_VALOR CHECK (
      (CL_UNID = 'D' AND CL_DIAS > 0 AND CL_MINU IS NULL) OR
      (CL_UNID = 'H' AND CL_MINU > 0 AND CL_DIAS IS NULL)
    )
  );
END;

IF OBJECT_ID(N'${s}.[${PLUSES_TABLE}]', N'U') IS NULL
BEGIN
  CREATE TABLE ${s}.[${PLUSES_TABLE}] (
    CP_CONV nvarchar(${CONVENIO_CODE_MAX}) NOT NULL,
    CP_TIPO char(1)       NOT NULL,
    CP_REF  nvarchar(10)  NOT NULL,
    CP_ANOS smallint      NOT NULL,
    CP_DIAS decimal(5, 1) NULL,
    CP_MINU int           NULL,
    CONSTRAINT PK_PS_CONVENIOS_PLUSES PRIMARY KEY (CP_CONV, CP_TIPO, CP_REF, CP_ANOS),
    CONSTRAINT FK_PS_CONVENIOS_PLUSES_CONV FOREIGN KEY (CP_CONV) REFERENCES ${s}.[${CONVENIOS_TABLE}] (CV_CODI) ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT CK_PS_CONVENIOS_PLUSES_TIPO CHECK (CP_TIPO IN ('V', 'I')),
    CONSTRAINT CK_PS_CONVENIOS_PLUSES_ANOS CHECK (CP_ANOS BETWEEN 1 AND ${MAX_PLUS_YEARS}),
    CONSTRAINT CK_PS_CONVENIOS_PLUSES_VALOR CHECK ((CP_DIAS > 0 AND CP_MINU IS NULL) OR (CP_MINU > 0 AND CP_DIAS IS NULL))
  );
END;
`;
}

// ---------- Tipos de vacaciones (TIPOSVACACIONES de Evalos 8) ----------
/**
 * Valores con los que se crea un tipo de vacaciones nuevo, como los deja Evalos 8 (S = marcado, N = sin marcar,
 * '' = vacío). Solo se escriben las columnas que existan en la tabla.
 */
export const VACATION_TYPE_DEFAULTS: Record<string, 'S' | 'N' | ''> = {
  TEORICAS_HORARIO: 'S', TEORICAS_VACACIONES: 'N', TEORICAS_OTROS: 'N', FESTIVO: 'N', NOLABORABLE: 'N',
  DIASTRIENIO: '', DESDETRIENIO: '', HASTATRIENIO: '', DIASTRIENIO2: '', DESDETRIENIO2: '', HASTATRIENIO2: '',
  MAXDAYS: '', DIASPERIODO: '', HORASDISPO: 'N', INCIDENCIACOMPENSAR: '', YEAR: '',
  PERMITIRDIA: 'S', PERMITIRMEDIODIA: 'S', PERMITIRHORAS: 'S'
};

/**
 * Valor de VACATION_TYPE_DEFAULTS adaptado al tipo de la columna: en texto se escribe tal cual; en columnas
 * numéricas o bit, S/N pasan a 1/0 y el vacío a NULL (o 0 si la columna no admite NULL).
 * Devuelve undefined si no se sabe escribir en ese tipo de columna (se deja al valor por defecto de la tabla).
 */
export function vacationTypeDefault(v: 'S' | 'N' | '', col: { type: string; nullable: boolean }, kinds: { text: string[]; num: string[] }): string | number | null | undefined {
  if (kinds.text.includes(col.type)) return v;
  if (kinds.num.includes(col.type)) return v === 'S' ? 1 : v === 'N' ? 0 : col.nullable ? null : 0;
  return v === '' && col.nullable ? null : undefined;
}
/** Formato en que la tabla guarda el color, deducido de los valores que ya tiene. */
export type ColorFormat = 'hex' | 'argb' | 'ole' | 'none';

/** Color #rrggbb → valor para la columna, en el mismo formato que las filas existentes. */
export function encodeColor(hex: string, format: ColorFormat): string | number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m || format === 'none') return null;
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  if (format === 'hex') return m[1].toUpperCase();
  if (format === 'argb') return (0xff000000 | n) | 0;            // System.Drawing.Color.ToArgb() (opaco, negativo)
  return r + g * 256 + b * 65536;                                // OLE/Win32: BGR
}

/** Deduce el formato del color a partir del tipo de columna y de los valores guardados. */
export function detectColorFormat(columnIsText: boolean, samples: unknown[]): ColorFormat {
  const vals = samples.map((v) => (v == null ? '' : String(v).trim())).filter(Boolean);
  if (columnIsText && (!vals.length || vals.some((v) => /^#?[0-9a-f]{6}$/i.test(v) && !/^-?\d+$/.test(v)))) return 'hex';
  if (vals.some((v) => /^-\d+$/.test(v) || Number(v) > 0xffffff)) return 'argb';
  if (columnIsText && vals.length && vals.every((v) => /^\d+$/.test(v) && v.length !== 6)) return 'ole';
  return columnIsText ? 'hex' : 'ole';
}
