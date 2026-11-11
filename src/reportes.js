const { columns, quoteIdentifier, quoteTableName, databaseIsConfigured, isDemoMode } = require('./config');
const { sql, getPool } = require('./database');
const machineTargets = require('../config/machine-targets.json');

// Datos de ejemplo para probar la interfaz; se usan solamente en modo DEMO.
const demoSnapshot = {
  PVC03: { totalKm: 650.79, totalTon: 3.08, shifts: { A: { km: 259.65, ton: 1.28 }, B: { km: 251.70, ton: 1.12 }, C: { km: 139.44, ton: 0.68 } } },
  PVC04: { totalKm: 447.19, totalTon: 4.78, shifts: { A: { km: 270.09, ton: 2.86 }, B: { km: 31.67, ton: 0.38 }, C: { km: 145.43, ton: 1.54 } } },
  PVC05: { totalKm: 606.56, totalTon: 2.32, shifts: { A: { km: 342.43, ton: 1.26 }, B: { km: 79.22, ton: 0.38 }, C: { km: 184.91, ton: 0.68 } } },
  PVC06: { totalKm: 0, totalTon: 0, shifts: { A: { km: 0, ton: 0 }, B: { km: 0, ton: 0 }, C: { km: 0, ton: 0 } } },
  PVC07: { totalKm: 0, totalTon: 0, shifts: { A: { km: 0, ton: 0 }, B: { km: 0, ton: 0 }, C: { km: 0, ton: 0 } } },
  PVC08: { totalKm: 446.62, totalTon: 2.19, shifts: { A: { km: 219.41, ton: 1.01 }, B: { km: 109.83, ton: 0.63 }, C: { km: 117.38, ton: 0.55 } } },
};

// Redondea un valor a dos decimales y conserva null cuando el dato no es numérico.
function round(value) {
  if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return null;
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

// Busca las metas por nombre visible o por ID; si no existen, deja las metas vacías.
function targetFor(machineName, machineId) {
  const keys = [machineName, machineId].map((value) => String(value || '').trim().toUpperCase());
  const target = keys.map((key) => machineTargets[key]).find(Boolean);
  return target || { dailyKm: null, dailyTon: null };
}

// Empaqueta el real, la meta y su diferencia para una métrica individual.
function metric(actual, target) {
  const roundedActual = round(actual);
  const roundedTarget = round(target);
  return {
    actual: roundedActual,
    target: roundedTarget,
    gap: roundedActual !== null && roundedTarget !== null ? round(roundedActual - roundedTarget) : null,
  };
}

// Convierte las producciones del ciclo, hora y turno seleccionados en indicadores.
function makeMachineMetrics(machineId, machineName, totals, turno) {
  const target = targetFor(machineName, machineId);
  const dailyKm = totals?.dailyKm ?? 0;
  const dailyTon = totals?.dailyTon ?? 0;
  return {
    // Conserva identificación, conteo de registros y fecha de la última producción.
    machineId: String(machineId),
    machineName,
    registrosProduccion: Number(totals?.rows || 0),
    ultimaProduccion: totals?.lastProductionDate || null,
    turno,
    metrics: {
      // Las metas se derivan de la meta diaria; los reales usan sus ventanas de tiempo.
      dailyKm: metric(dailyKm, target.dailyKm),
      dailyTon: metric(dailyTon, target.dailyTon),
      hourlyKm: metric(totals?.hourlyKm ?? 0, target.dailyKm === null ? null : target.dailyKm / 24),
      hourlyTon: metric(totals?.hourlyTon ?? 0, target.dailyTon === null ? null : target.dailyTon / 24),
      // La meta de turno representa un tercio de la meta diaria.
      shiftKm: metric(totals?.shiftKm ?? 0, target.dailyKm === null ? null : target.dailyKm / 3),
      shiftTon: metric(totals?.shiftTon ?? 0, target.dailyTon === null ? null : target.dailyTon / 3),
    },
  };
}

// Cuenta días calendario entre fechas ISO, con mínimo de un día para evitar división por cero.
function daysBetween(inicio, fin) {
  const start = Date.parse(`${inicio}T00:00:00Z`);
  const end = Date.parse(`${fin}T00:00:00Z`);
  return Math.max(1, Math.round((end - start) / 86400000));
}

// Devuelve las máquinas del origen de datos actual, usando ID y nombre para la interfaz.
async function getMachineCodes() {
  // El catálogo de demostración permite usar la aplicación sin SQL Server.
  if (isDemoMode()) return Object.keys(demoSnapshot).map((machineCode) => ({ id: machineCode, name: machineCode }));

  // Evita intentar consultar la base si faltan las variables de conexión obligatorias.
  if (!databaseIsConfigured()) {
    const error = new Error('La conexión a SQL Server no está configurada. Completa las variables DB_* del archivo .env.');
    error.status = 503;
    throw error;
  }

  const table = quoteTableName(process.env.DB_TABLE || 'dbo.vw_get_Production_Report');
  const idCol = quoteIdentifier(columns.id);
  const machineCol = quoteIdentifier(columns.machine);
  // Agrupa por ID estable y obtiene un nombre visible por máquina desde la vista.
  const result = await (await getPool()).request().query(`
    SELECT
      LTRIM(RTRIM(CONVERT(nvarchar(100), ${idCol}))) AS machineId,
      MAX(LTRIM(RTRIM(CONVERT(nvarchar(100), ${machineCol})))) AS machineName
    FROM ${table}
    WHERE ${idCol} IS NOT NULL
      AND ${machineCol} IS NOT NULL
      AND LTRIM(RTRIM(CONVERT(nvarchar(100), ${machineCol}))) <> ''
    GROUP BY LTRIM(RTRIM(CONVERT(nvarchar(100), ${idCol})))
    ORDER BY machineName, machineId;
  `);

  return result.recordset
    // Normaliza los resultados del driver y descarta filas incompletas.
    .map((row) => ({
      id: String(row.machineId || '').trim(),
      name: String(row.machineName || '').trim(),
    }))
    .filter((machine) => machine.id && machine.name);
}

// Obtiene la producción filtrada y calcula indicadores para cada máquina seleccionada.
async function getProductionReport({ inicio, fin, turno, maquinas, machineNamesById = new Map() }) {
  // Cuenta los días del rango para estadísticas y devuelve vacío si no hay máquinas.
  const days = daysBetween(inicio, fin);
  if (!Array.isArray(maquinas) || maquinas.length === 0) {
    return { mode: isDemoMode() ? 'demo' : 'database', dias: days, registrosProduccion: 0, maquinas: [] };
  }

  if (isDemoMode()) {
    // Replica la estructura de respuesta de SQL a partir de valores ficticios.
    const now = new Date();
    const minutesNow = now.getHours() * 60 + now.getMinutes() + now.getSeconds() / 60;
    const elapsedDayMinutes = minutesNow >= 7 * 60 ? minutesNow - 7 * 60 : minutesNow + 17 * 60;
    const shiftWindows = {
      A: { start: 7 * 60, duration: 8 * 60 },
      B: { start: 15 * 60, duration: 7.5 * 60 },
      C: { start: 22.5 * 60, duration: 8.5 * 60 },
    };
    const shiftWindow = shiftWindows[turno];
    const elapsedShiftMinutes = turno === 'C' && minutesNow < shiftWindow.start
      ? minutesNow + 24 * 60 - shiftWindow.start
      : minutesNow - shiftWindow.start;
    const hourProgress = (now.getMinutes() + now.getSeconds() / 60) / 60;
    const dayProgress = Math.min(1, Math.max(0, elapsedDayMinutes / (24 * 60)));
    const shiftProgress = Math.min(1, Math.max(0, elapsedShiftMinutes / shiftWindow.duration));
    const demoMachines = maquinas.map((machineId) => {
      const machineName = machineNamesById.get(String(machineId)) || String(machineId);
      const dailyData = demoSnapshot[machineName];
      const totals = dailyData ? {
        dailyKm: dailyData.totalKm * dayProgress,
        dailyTon: dailyData.totalTon * dayProgress,
        hourlyKm: (dailyData.totalKm / 24) * hourProgress,
        hourlyTon: (dailyData.totalTon / 24) * hourProgress,
        shiftKm: dailyData.shifts[turno].km * shiftProgress,
        shiftTon: dailyData.shifts[turno].ton * shiftProgress,
        rows: (dailyData.totalKm || dailyData.totalTon) ? 3 * days : 0,
      } : { shifts: {}, rows: 0 };
      return makeMachineMetrics(machineId, machineName, totals, turno);
    });
    // Devuelve estadísticas globales además del detalle que se muestra por máquina.
    return {
      mode: 'demo',
      dias: days,
      registrosProduccion: demoMachines.reduce((sum, row) => sum + row.registrosProduccion, 0),
      maquinasConProduccion: demoMachines.filter((row) => row.registrosProduccion > 0).length,
      maquinas: demoMachines,
    };
  }

  if (!databaseIsConfigured()) {
    const error = new Error('La conexión a SQL Server no está configurada. Completa el archivo .env o activa DEMO_MODE=true.');
    error.status = 503;
    throw error;
  }

  const productionTable = quoteTableName(process.env.DB_TABLE || 'dbo.vw_get_Production_Report');
  const idCol = quoteIdentifier(columns.id);
  const dateCol = quoteIdentifier(columns.date);
  const shiftCol = quoteIdentifier(columns.shift);
  const kmCol = quoteIdentifier(columns.km);
  const tonCol = quoteIdentifier(columns.ton);

  // Vincula fechas, turno y máquinas como parámetros en lugar de insertar valores del usuario.
  const request = (await getPool()).request();
  request.input('fechaInicio', sql.Date, inicio);
  request.input('fechaFin', sql.Date, fin);
  request.input('turnoSeleccionado', sql.NVarChar(1), turno);
  const machineParams = maquinas.map((machineId, index) => {
    const key = `maquina${index}`;
    request.input(key, sql.NVarChar(100), machineId);
    return `@${key}`;
  });

  // Limita la consulta al intervalo seleccionado y calcula las ventanas del último
  // ciclo productivo: día completo, hora actual del ciclo y turno seleccionado.
  const query = `
    WITH Ventanas AS (
      SELECT
        DATEADD(HOUR, 7, DATEADD(DAY, -1, CAST(@fechaFin AS datetime2))) AS diaInicio,
        DATEADD(HOUR, 7, CAST(@fechaFin AS datetime2)) AS diaFin,
        DATEADD(
          HOUR,
          DATEPART(HOUR, SYSDATETIME()),
          CAST(
            CASE
              WHEN DATEPART(HOUR, SYSDATETIME()) < 7 THEN @fechaFin
              ELSE DATEADD(DAY, -1, @fechaFin)
            END AS datetime2
          )
        ) AS horaInicio,
        DATEADD(
          MINUTE,
          CASE @turnoSeleccionado
            WHEN 'A' THEN 420
            WHEN 'B' THEN 900
            ELSE 1350
          END,
          DATEADD(DAY, -1, CAST(@fechaFin AS datetime2))
        ) AS turnoInicio,
        CASE @turnoSeleccionado
          WHEN 'A' THEN DATEADD(HOUR, 15, DATEADD(DAY, -1, CAST(@fechaFin AS datetime2)))
          WHEN 'B' THEN DATEADD(MINUTE, 1350, DATEADD(DAY, -1, CAST(@fechaFin AS datetime2)))
          ELSE DATEADD(HOUR, 7, CAST(@fechaFin AS datetime2))
        END AS turnoFin
    ),
    Produccion AS (
      SELECT
        LTRIM(RTRIM(CONVERT(nvarchar(100), p.${idCol}))) AS machineId,
        TRY_CONVERT(decimal(18, 4), p.${kmCol}) AS km,
        TRY_CONVERT(decimal(18, 4), p.${tonCol}) AS ton,
        p.${dateCol} AS productionTimestamp,
        UPPER(LTRIM(RTRIM(CONVERT(nvarchar(10), p.${shiftCol})))) AS turno
      FROM ${productionTable} AS p
      WHERE p.${dateCol} >= DATEADD(HOUR, 7, CAST(@fechaInicio AS datetime2))
        AND p.${dateCol} < CASE
          WHEN DATEADD(HOUR, 7, CAST(@fechaFin AS datetime2)) > SYSDATETIME()
            THEN SYSDATETIME()
          ELSE DATEADD(HOUR, 7, CAST(@fechaFin AS datetime2))
        END
        AND LTRIM(RTRIM(CONVERT(nvarchar(100), p.${idCol}))) IN (${machineParams.join(', ')})
    )
    SELECT
      p.machineId,
      SUM(CASE
        WHEN p.productionTimestamp >= v.diaInicio AND p.productionTimestamp < v.diaFin
        THEN COALESCE(p.km, 0) ELSE 0
      END) AS dailyKm,
      SUM(CASE
        WHEN p.productionTimestamp >= v.diaInicio AND p.productionTimestamp < v.diaFin
        THEN COALESCE(p.ton, 0) ELSE 0
      END) AS dailyTon,
      SUM(CASE
        WHEN p.productionTimestamp >= v.horaInicio
          AND p.productionTimestamp < DATEADD(HOUR, 1, v.horaInicio)
        THEN COALESCE(p.km, 0) ELSE 0
      END) AS hourlyKm,
      SUM(CASE
        WHEN p.productionTimestamp >= v.horaInicio
          AND p.productionTimestamp < DATEADD(HOUR, 1, v.horaInicio)
        THEN COALESCE(p.ton, 0) ELSE 0
      END) AS hourlyTon,
      SUM(CASE
        WHEN p.turno = @turnoSeleccionado
          AND p.productionTimestamp >= v.turnoInicio
          AND p.productionTimestamp < v.turnoFin
        THEN COALESCE(p.km, 0) ELSE 0
      END) AS shiftKm,
      SUM(CASE
        WHEN p.turno = @turnoSeleccionado
          AND p.productionTimestamp >= v.turnoInicio
          AND p.productionTimestamp < v.turnoFin
        THEN COALESCE(p.ton, 0) ELSE 0
      END) AS shiftTon,
      COUNT_BIG(*) AS [productionRowCount],
      MAX(p.productionTimestamp) AS lastProductionDate
    FROM Produccion AS p
    CROSS JOIN Ventanas AS v
    WHERE p.machineId IS NOT NULL AND p.machineId <> ''
    GROUP BY p.machineId;
  `;

  // Ejecuta la agregación en SQL Server y organiza sus resultados por ID de máquina.
  const result = await request.query(query);
  const totalsByMachine = new Map(result.recordset.map((row) => [String(row.machineId || '').trim(), {
    dailyKm: Number(row.dailyKm || 0),
    dailyTon: Number(row.dailyTon || 0),
    hourlyKm: Number(row.hourlyKm || 0),
    hourlyTon: Number(row.hourlyTon || 0),
    shiftKm: Number(row.shiftKm || 0),
    shiftTon: Number(row.shiftTon || 0),
    rows: Number(row.productionRowCount || 0),
    lastProductionDate: row.lastProductionDate || null,
  }]));
  // Incluye también máquinas seleccionadas sin registros, con sus valores reales en cero.
  const reportMachines = maquinas.map((machineId) => {
    const id = String(machineId).trim();
    const machineName = machineNamesById.get(id) || id;
    return makeMachineMetrics(id, machineName, totalsByMachine.get(id), days, turno);
  });
  const recordsFound = reportMachines.reduce((sum, row) => sum + row.registrosProduccion, 0);

  // Devuelve indicadores por máquina y conteos agregados para el estado de la interfaz.
  return {
    mode: 'database',
    dias: days,
    registrosProduccion: recordsFound,
    maquinasConProduccion: reportMachines.filter((row) => row.registrosProduccion > 0).length,
    maquinas: reportMachines,
  };
}

module.exports = { getMachineCodes, getProductionReport };
