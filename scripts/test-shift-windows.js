const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { getCompletedShiftClosures } = require('../src/shift-windows');
const ExcelJS = require('exceljs');
const { writeProductionWorkbook } = require('../src/production-excel');

function localDate(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute);
}

test('genera cada cierre al cruzar el horario local del turno', () => {
  const closures = getCompletedShiftClosures(
    localDate(2026, 11, 9, 14, 59),
    localDate(2026, 11, 10, 7, 0),
  );

  assert.deepEqual(closures.map(({ id, cycleDate }) => [id, cycleDate]), [
    ['A', '2026-11-09'],
    ['B', '2026-11-09'],
    ['C', '2026-11-09'],
  ]);
  assert.equal(closures[2].start.getDate(), 9);
  assert.equal(closures[2].end.getDate(), 10);
});

test('no incluye turnos cuyo cierre todavía no ocurre', () => {
  const closures = getCompletedShiftClosures(
    localDate(2026, 11, 9, 15, 0),
    localDate(2026, 11, 9, 22, 29),
  );

  assert.deepEqual(closures, []);
});

test('recupera cierres ocurridos mientras la aplicación estuvo detenida', () => {
  const closures = getCompletedShiftClosures(
    localDate(2026, 11, 8, 22, 30),
    localDate(2026, 11, 10, 7, 0),
  );

  assert.deepEqual(closures.map(({ id, cycleDate }) => `${cycleDate}-${id}`), [
    '2026-11-08-C',
    '2026-11-09-A',
    '2026-11-09-B',
    '2026-11-09-C',
  ]);
});

test('crea el Excel con hojas de turno y producción diaria', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'production-report-'));
  const outputPath = path.join(directory, 'report.xlsx');
  const closure = {
    id: 'A',
    cycleDate: '2026-11-09',
    start: localDate(2026, 11, 9, 7, 0),
    end: localDate(2026, 11, 9, 15, 0),
  };
  const rows = [{
    id: 'PVC03',
    name: 'PVC03',
    shiftKm: 125.5,
    shiftTon: 1.25,
    dailyKm: 125.5,
    dailyTon: 1.25,
    shiftRows: 4,
    dailyRows: 4,
  }];

  try {
    await writeProductionWorkbook(outputPath, closure, rows);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(outputPath);

    assert.deepEqual(workbook.worksheets.map((sheet) => sheet.name), ['Turno A', 'Acumulado diario']);
    assert.equal(workbook.getWorksheet('Turno A').getRow(6).getCell(3).value, 125.5);
    assert.equal(workbook.getWorksheet('Acumulado diario').getRow(6).getCell(4).value, 1.25);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
