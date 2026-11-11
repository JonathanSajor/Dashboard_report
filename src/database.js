const sql = require('mssql');

// Promesa compartida para no abrir varias conexiones simultáneas al mismo SQL Server.
let poolPromise;

// Construye opciones de conexión desde .env y aplica límites de tiempo y concurrencia.
function buildConfig() {
  // El driver de SQL Server requiere el puerto numérico; 8080 es el valor definido aquí.
  const port = Number(process.env.DB_PORT || 8080);
  return {
    server: process.env.DB_SERVER,
    port,
    database: process.env.DB_DATABASE,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    options: {
      encrypt: String(process.env.DB_ENCRYPT || 'false').toLowerCase() === 'true',
      trustServerCertificate: String(process.env.DB_TRUST_SERVER_CERTIFICATE || 'true').toLowerCase() === 'true',
      enableArithAbort: true,
    },
    pool: { max: 10, min: 0, idleTimeoutMillis: 30000 },
    connectionTimeout: 15000,
    requestTimeout: 30000,
  };
}

// Devuelve el pool activo o crea uno; si falla, permite que un intento posterior reintente.
function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig())
      .connect()
      .catch((error) => {
        poolPromise = undefined;
        throw error;
      });
  }
  return poolPromise;
}

module.exports = { sql, getPool, buildConfig };
