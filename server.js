require('dotenv').config();

// Carga el framework HTTP, utilidades de rutas y la configuración compartida.
const express = require('express');
const path = require('path');
const { SHIFTS, publicDir, isDemoMode } = require('./src/config');
const { getMachineCodes, getProductionReport } = require('./src/reportes');
const { startProductionReportScheduler } = require('./src/report-scheduler');

// Crea el servidor web y conserva en memoria los nombres asociados a cada ID.
const app = express();
const port = Number(process.env.PORT || 8080);
let machineNamesById;

// Evita exponer la tecnología del servidor y limita el tamaño de JSON entrante.
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
// Sirve archivos estáticos del dashboard y permite resolver index.html por defecto.
app.use(express.static(publicDir, { extensions: ['html'] }));

// Comprueba que una fecha sea real y tenga exactamente el formato YYYY-MM-DD.
function isIsoDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

// Registra detalles útiles del error de SQL sin incluir datos sensibles.
function logDatabaseError(label, error) {
  console.error(label, {
    message: error.message,
    code: error.code,
    number: error.number ?? error.originalError?.info?.number,
    state: error.state ?? error.originalError?.info?.state,
  });
}

// Entrega al navegador las máquinas, turnos y parámetros operativos del dashboard.
app.get('/api/config', async (_req, res) => {
  try {
    // Consulta máquinas disponibles y guarda sus nombres para el reporte posterior.
    const maquinas = await getMachineCodes();
    machineNamesById = new Map(maquinas.map((machine) => [machine.id, machine.name]));
    res.json({
      maquinas,
      shifts: SHIFTS,
      mode: isDemoMode() ? 'demo' : 'database',
      autoRefreshSeconds: Math.max(15, Number(process.env.AUTO_REFRESH_SECONDS || 60)),
    });
  } catch (error) {
    // Devuelve una explicación accionable si la vista o la conexión no están disponibles.
    logDatabaseError('[config/maquinas]', error);
    res.status(error.status || 500).json({
      error: 'No fue posible cargar las máquinas desde dbo.vw_get_Production_Report. Verifica la conexión y las columnas DB_ID_MACHINE y DB_MACHINE del archivo .env.',
    });
  }
});

// Permite verificar que el proceso responde y conocer el modo de datos activo.
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, mode: isDemoMode() ? 'demo' : 'database' });
});

// Valida filtros, consulta las métricas y forma la respuesta consumida por la interfaz.
app.get('/api/reportes', async (req, res) => {
  // Normaliza los parámetros para tratar de forma uniforme valores únicos y repetidos.
  const { inicio, fin } = req.query;
  const turno = String(req.query.turno || '').trim().toUpperCase();
  let maquinas = req.query.maquinas;
  if (typeof maquinas === 'string') maquinas = [maquinas];
  if (!Array.isArray(maquinas)) maquinas = [];
  maquinas = [...new Set(maquinas.map((machine) => String(machine).trim()).filter(Boolean))];

  // Rechaza fechas incorrectas, intervalos vacíos, turnos desconocidos o lista vacía.
  if (!isIsoDate(inicio) || !isIsoDate(fin)) {
    return res.status(400).json({ error: 'Indica una fecha inicial y final válidas en formato YYYY-MM-DD.' });
  }
  if (fin <= inicio) {
    return res.status(400).json({ error: 'La fecha final debe ser posterior a la fecha inicial.' });
  }
  if (!SHIFTS.some((shift) => shift.id === turno)) {
    return res.status(400).json({ error: 'No se recibió un turno actual válido: A, B o C.' });
  }
  if (!maquinas.length) {
    return res.status(400).json({ error: 'Selecciona al menos una máquina.' });
  }

  try {
    // Carga nombres de máquina bajo demanda si /api/config todavía no se consultó.
    if (!machineNamesById) {
      const availableMachines = await getMachineCodes();
      machineNamesById = new Map(availableMachines.map((machine) => [machine.id, machine.name]));
    }
    const result = await getProductionReport({ inicio, fin, turno, maquinas, machineNamesById });
    // Incluye el intervalo exclusivo, totales y hora de actualización para la UI.
    res.json({
      inicio,
      fin,
      turno,
      turnos: SHIFTS.map((shift) => shift.id),
      intervalo: { inicio: `${inicio} 07:00:00`, finExclusivo: `${fin} 07:00:00` },
      modo: result.mode,
      dias: result.dias,
      maquinas: result.maquinas,
      totalMaquinas: result.maquinas.length,
      registrosProduccion: result.registrosProduccion ?? 0,
      maquinasConProduccion: result.maquinasConProduccion ?? 0,
      actualizado: new Date().toISOString(),
    });
  } catch (error) {
    // Distingue errores esperados de configuración de los fallos generales de consulta.
    logDatabaseError('[reportes]', error);
    res.status(error.status || 500).json({
      error: error.status ? error.message : 'No fue posible consultar el reporte. Revisa la conexión y las columnas configuradas.',
    });
  }
});

// Para cualquier ruta de navegación, devuelve la aplicación de una sola página.
app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Inicia Express y deja visibles la dirección local y la fuente de datos seleccionada.
app.listen(port, () => {
  console.log(`Reporte de Producción disponible en http://localhost:${port}`);
  console.log(`Modo: ${isDemoMode() ? 'DEMO (datos ficticios)' : 'SQL Server'}`);
  startProductionReportScheduler();
});
