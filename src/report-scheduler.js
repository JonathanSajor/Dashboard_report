const fs = require('fs/promises');
const path = require('path');
const { isDemoMode } = require('./config');
const { getCompletedShiftClosures } = require('./shift-windows');
const { reportFileName, getShiftProduction, writeProductionWorkbook } = require('./production-excel');

const reportsDirectory = path.join(__dirname, '..', 'reportes-generados');
const statePath = path.join(reportsDirectory, '.scheduler-state.json');
const checkIntervalMs = 15 * 1000;

async function writeState(state) {
  const temporaryPath = `${statePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryPath, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(temporaryPath, statePath);
}

async function readOrInitializeState(now) {
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const lastProcessedAt = new Date(state.lastProcessedAt);
    if (Number.isNaN(lastProcessedAt.getTime())) {
      throw new Error(`La fecha lastProcessedAt de ${statePath} no es válida.`);
    }
    return { lastProcessedAt };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const initialState = { lastProcessedAt: now.toISOString() };
    await writeState(initialState);
    console.log('[reportes] Punto inicial guardado; los cierres futuros y los posteriores a reinicios se procesarán automáticamente.');
    return { lastProcessedAt: now };
  }
}

async function processCompletedShifts() {
  const now = new Date();
  await fs.mkdir(reportsDirectory, { recursive: true });
  let state = await readOrInitializeState(now);
  const closures = getCompletedShiftClosures(state.lastProcessedAt, now);

  for (const closure of closures) {
    const outputPath = path.join(reportsDirectory, reportFileName(closure));
    try {
      await fs.access(outputPath);
      console.log(`[reportes] El archivo ya existe; se evita duplicarlo: ${outputPath}`);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const rows = await getShiftProduction(closure);
      await writeProductionWorkbook(outputPath, closure, rows);
      console.log(`[reportes] Excel generado: ${outputPath}`);
    }
    state = { lastProcessedAt: closure.end.toISOString() };
    await writeState(state);
  }
}

function startProductionReportScheduler() {
  if (isDemoMode()) {
    console.log('[reportes] Generación automática desactivada en modo DEMO.');
    return;
  }

  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await processCompletedShifts();
    } catch (error) {
      console.error('[reportes] No fue posible procesar cierres de turno; se reintentará:', error);
    } finally {
      running = false;
    }
  };

  void tick();
  const timer = setInterval(tick, checkIntervalMs);
  timer.unref();
}

module.exports = { startProductionReportScheduler, processCompletedShifts };
