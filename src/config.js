const path = require('path');

// Define los turnos que se muestran en la aplicación y se validan en la API.
const SHIFTS = [
  { id: 'A', label: 'Turno A · 07:00–14:59' },
  { id: 'B', label: 'Turno B · 15:00–22:29' },
  { id: 'C', label: 'Turno C · 22:30–06:59' },
];

const PRODUCTION_DECIMAL_TYPE = 'decimal(38, 15)';

// Lee una variable de entorno, quitando espacios y tratando NONE/NULL como ausencia.
function configuredValue(variable, fallback = null) {
  if (!Object.prototype.hasOwnProperty.call(process.env, variable)) return fallback;
  const value = String(process.env[variable] ?? '').trim();
  if (!value || value.toUpperCase() === 'NONE' || value.toUpperCase() === 'NULL') return null;
  return value;
}

// Centraliza los nombres de columnas configurables y sus valores predeterminados.
const columns = {
  id: configuredValue('DB_ID_MACHINE', 'ID_Machine'),
  machine: configuredValue('DB_MACHINE', 'machine'),
  km: configuredValue('DB_KM_COLUMN', 'quantity_km'),
  ton: configuredValue('DB_TON_COLUMN', 'quantity_ton'),
  date: configuredValue('DB_DATE_COLUMN', 'production_Date'),
  shift: configuredValue('DB_SHIFT', 'shift'),
};

// Valida y delimita un identificador SQL simple antes de interpolarlo en una consulta.
function quoteIdentifier(identifier) {
  if (typeof identifier !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(identifier)) {
    throw new Error(`Identificador SQL no válido: ${identifier}`);
  }
  return `[${identifier}]`;
}

// Valida los formatos Tabla o esquema.Tabla y delimita cada componente SQL.
function quoteTableName(tableName) {
  const parts = String(tableName || '').split('.');
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_$]*$/.test(part))) {
    throw new Error('El nombre de tabla debe tener formato Tabla o esquema.Tabla, por ejemplo dbo.vw_get_Production_Report.');
  }
  return parts.map((part) => `[${part}]`).join('.');
}

// Indica si las cuatro credenciales mínimas para autenticarse están presentes.
function databaseIsConfigured() {
  const required = [
    process.env.DB_SERVER,
    process.env.DB_DATABASE,
    process.env.DB_USER,
    process.env.DB_PASSWORD,
  ];
  return required.every((value) => Boolean(value && !/^NombreDeTuBaseDeDatos$/.test(value)));
}

// Determina el origen de datos, respetando DEMO_MODE explícito si fue configurado.
function isDemoMode() {
  const configuredMode = String(process.env.DEMO_MODE || '').trim().toLowerCase();
  if (configuredMode === 'true') return true;
  if (configuredMode === 'false') return false;
  return !(process.env.DB_SERVER && process.env.DB_DATABASE);
}

// Expone configuración y utilidades utilizadas por el servidor y la capa de datos.
module.exports = {
  SHIFTS,
  PRODUCTION_DECIMAL_TYPE,
  columns,
  quoteIdentifier,
  quoteTableName,
  databaseIsConfigured,
  isDemoMode,
  publicDir: path.join(__dirname, '..', 'public'),
};
