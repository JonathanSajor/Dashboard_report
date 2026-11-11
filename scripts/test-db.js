require('dotenv').config();

// Reutiliza el driver, la configuración y las reglas de nombres SQL de la aplicación.
const { sql, buildConfig } = require('../src/database');
const { quoteTableName, quoteIdentifier, columns } = require('../src/config');

// Recorre errores anidados del driver y devuelve únicamente campos de diagnóstico útiles.
function safeError(error) {
  const seen = new Set();
  const details = [];
  let current = error;
  for (let depth = 0; current && depth < 4 && !seen.has(current); depth += 1) {
    seen.add(current);
    const info = current.info || current.originalError?.info;
    details.push({
      name: current.name,
      code: current.code,
      number: current.number ?? info?.number,
      state: current.state ?? info?.state,
      class: current.class ?? info?.class,
      message: current.message,
    });
    current = current.originalError || current.cause;
  }
  if (Array.isArray(error?.precedingErrors)) {
    for (const item of error.precedingErrors) {
      details.push({ code: item.code, number: item.number, state: item.state, message: item.message });
    }
  }
  return details;
}

// Verifica credenciales, conexión, tabla, columnas y actividad reciente sin alterar datos.
async function main() {
  // Comprueba variables obligatorias antes de intentar abrir una conexión.
  const required = ['DB_SERVER', 'DB_DATABASE', 'DB_USER', 'DB_PASSWORD'];
  const missing = required.filter((key) => !String(process.env[key] || '').trim());
  if (missing.length) {
    console.error(`Faltan variables en .env: ${missing.join(', ')}`);
    process.exitCode = 2;
    return;
  }

  // Muestra el destino de conexión sin imprimir la contraseña.
  const config = buildConfig();
  console.log('Probando conexión (la contraseña se omite):');
  console.log(JSON.stringify({
    server: config.server,
    port: config.port,
    database: config.database,
    user: config.user,
    encrypt: config.options.encrypt,
    trustServerCertificate: config.options.trustServerCertificate,
  }, null, 2));

  let pool;
  try {
    // Abre una conexión independiente para esta prueba diagnóstica.
    pool = await new sql.ConnectionPool(config).connect();
    console.log('\n[OK] Autenticación y conexión con SQL Server correctas.');

    // Consulta la identidad efectiva de SQL Server para detectar destinos equivocados.
    const identityResult = await pool.request().query(`
      SELECT @@SERVERNAME AS serverName, DB_NAME() AS databaseName,
             ORIGINAL_LOGIN() AS originalLogin, SUSER_SNAME() AS currentLogin;
    `);
    console.log('Destino real de la conexión:');
    console.log(JSON.stringify(identityResult.recordset[0], null, 2));

    // Delimita identificadores configurados después de validarlos.
    const productionTable = quoteTableName(process.env.DB_TABLE || 'dbo.vw_get_Production_Report');
    const machineCol = quoteIdentifier(columns.machine);
    const dateCol = quoteIdentifier(columns.date);
    const idCol = quoteIdentifier(columns.id);
    const shiftCol = quoteIdentifier(columns.shift);
    const kmCol = quoteIdentifier(columns.km);
    const tonCol = quoteIdentifier(columns.ton);

    // TOP (0) comprueba acceso a la fuente sin descargar ni modificar registros.
    await pool.request().query(`SELECT TOP (0) * FROM ${productionTable};`);
    console.log(`[OK] Fuente de producción ${process.env.DB_TABLE || 'dbo.vw_get_Production_Report'}: accesible.`);

    const productionColumnCheck = await pool.request().query(`
      SELECT TOP (0) ${idCol}, ${machineCol}, ${dateCol}, ${shiftCol}, ${kmCol}, ${tonCol}
      FROM ${productionTable};
    `);
    void productionColumnCheck;
    console.log('[OK] Columnas de ID, máquina, fecha, turno, KM y TON verificadas.');

    // Resume la actividad de la última semana para diagnosticar reportes vacíos.
    const recentResult = await pool.request().query(`
      SELECT
        COUNT_BIG(*) AS productionRowsLast7Days,
        MAX(${dateCol}) AS lastProductionDate,
        COUNT(DISTINCT ${idCol}) AS distinctMachines,
        COUNT(DISTINCT ${shiftCol}) AS distinctShifts
      FROM ${productionTable}
      WHERE ${dateCol} >= DATEADD(DAY, -7, SYSDATETIME());
    `);
    console.log('\nResumen de actividad de los últimos 7 días (para detectar por qué podría aparecer vacío):');
    console.log(JSON.stringify(recentResult.recordset[0], null, 2));
    console.log('\nDiagnóstico completado. Revisa distinctMachines y distinctShifts para confirmar que la vista contiene datos y turnos.');
  } catch (error) {
    // Conserva detalles técnicos útiles sin mostrar secretos de conexión.
    console.error('\n[ERROR] La prueba de base de datos falló.');
    console.error(JSON.stringify(safeError(error), null, 2));
    console.error('\nNo compartas la contraseña. Revisa el estado del error en SQL Server Management > Management > SQL Server Logs.');
    process.exitCode = 1;
  } finally {
    // Cierra la conexión aun cuando alguna consulta o comprobación haya fallado.
    if (pool) await pool.close().catch(() => {});
  }
}

// Captura errores inesperados que ocurran fuera del bloque principal de diagnóstico.
main().catch((error) => {
  console.error('Fallo inesperado del diagnóstico:', error.message);
  process.exitCode = 1;
});
