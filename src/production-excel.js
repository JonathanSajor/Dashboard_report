const fs = require('fs/promises');
const path = require('path');
const ExcelJS = require('exceljs');
const {
  PRODUCTION_DECIMAL_TYPE,
  columns,
  quoteIdentifier,
  quoteTableName,
  isDemoMode,
} = require('./config');
const { sql, getPool } = require('./database');
const { getMachineCodes } = require('./reportes');
const { formatLocalDateTime } = require('./shift-windows');
const machineTargets = require('../config/machine-targets.json');
const productionNumberFormat = '#,##0.##############';

function reportFileName(closure) {
  return `produccion_${closure.cycleDate}_turno-${closure.id}.xlsx`;
}

function matchTargetMachines(availableMachines) {
  const normalizedMachines = availableMachines.map((machine) => ({
    ...machine,
    normalizedId: String(machine.id).trim().toUpperCase(),
    normalizedName: String(machine.name).trim().toUpperCase(),
  }));
  const matched = Object.keys(machineTargets).map((targetCode) => {
    const normalizedCode = targetCode.trim().toUpperCase();
    const machine = normalizedMachines.find((candidate) =>
      candidate.normalizedId === normalizedCode || candidate.normalizedName === normalizedCode);
    if (!machine) {
      throw new Error(`La máquina configurada "${targetCode}" no aparece en la fuente de producción.`);
    }
    return { targetCode, id: machine.id, name: machine.name };
  });

  const ids = new Set(matched.map((machine) => machine.id.trim().toUpperCase()));
  if (ids.size !== matched.length) {
    throw new Error('Dos claves de machine-targets.json coinciden con el mismo ID de máquina.');
  }
  return matched;
}

async function getShiftProduction(closure) {
  if (isDemoMode()) {
    throw new Error('Los reportes automáticos requieren conexión a SQL Server; no se generarán con datos DEMO.');
  }

  const machines = matchTargetMachines(await getMachineCodes());
  const request = (await getPool()).request();
  request.input('dayStart', sql.VarChar(19), `${closure.cycleDate} 07:00:00`);
  request.input('shiftStart', sql.VarChar(19), formatLocalDateTime(closure.start));
  request.input('shiftEnd', sql.VarChar(19), formatLocalDateTime(closure.end));
  request.input('shift', sql.NVarChar(1), closure.id);
  const machineParams = machines.map((machine, index) => {
    const key = `machine${index}`;
    request.input(key, sql.NVarChar(100), machine.id);
    return `@${key}`;
  });

  const table = quoteTableName(process.env.DB_TABLE || 'dbo.vw_get_Production_Report');
  const idCol = quoteIdentifier(columns.id);
  const nameCol = quoteIdentifier(columns.machine);
  const dateCol = quoteIdentifier(columns.date);
  const shiftCol = quoteIdentifier(columns.shift);
  const kmCol = quoteIdentifier(columns.km);
  const tonCol = quoteIdentifier(columns.ton);
  const result = await request.query(`
    SELECT
      LTRIM(RTRIM(CONVERT(nvarchar(100), ${idCol}))) AS machineId,
      MAX(LTRIM(RTRIM(CONVERT(nvarchar(100), ${nameCol})))) AS machineName,
      SUM(CASE
        WHEN ${dateCol} >= CONVERT(datetime2, @shiftStart, 126)
          AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
          AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(10), ${shiftCol})))) = @shift
        THEN COALESCE(TRY_CONVERT(${PRODUCTION_DECIMAL_TYPE}, ${kmCol}), 0) ELSE 0
      END) AS shiftKm,
      SUM(CASE
        WHEN ${dateCol} >= CONVERT(datetime2, @shiftStart, 126)
          AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
          AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(10), ${shiftCol})))) = @shift
        THEN COALESCE(TRY_CONVERT(${PRODUCTION_DECIMAL_TYPE}, ${tonCol}), 0) ELSE 0
      END) AS shiftTon,
      SUM(CASE
        WHEN ${dateCol} >= CONVERT(datetime2, @dayStart, 126)
          AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
        THEN COALESCE(TRY_CONVERT(${PRODUCTION_DECIMAL_TYPE}, ${kmCol}), 0) ELSE 0
      END) AS dailyKm,
      SUM(CASE
        WHEN ${dateCol} >= CONVERT(datetime2, @dayStart, 126)
          AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
        THEN COALESCE(TRY_CONVERT(${PRODUCTION_DECIMAL_TYPE}, ${tonCol}), 0) ELSE 0
      END) AS dailyTon,
      SUM(CASE
        WHEN ${dateCol} >= CONVERT(datetime2, @shiftStart, 126)
          AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
          AND UPPER(LTRIM(RTRIM(CONVERT(nvarchar(10), ${shiftCol})))) = @shift
        THEN CONVERT(bigint, 1) ELSE CONVERT(bigint, 0)
      END) AS shiftRows,
      SUM(CASE
        WHEN ${dateCol} >= CONVERT(datetime2, @dayStart, 126)
          AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
        THEN CONVERT(bigint, 1) ELSE CONVERT(bigint, 0)
      END) AS dailyRows
    FROM ${table}
    WHERE ${dateCol} >= CONVERT(datetime2, @dayStart, 126)
      AND ${dateCol} < CONVERT(datetime2, @shiftEnd, 126)
      AND LTRIM(RTRIM(CONVERT(nvarchar(100), ${idCol}))) IN (${machineParams.join(', ')})
    GROUP BY LTRIM(RTRIM(CONVERT(nvarchar(100), ${idCol})));
  `);
  const totalsById = new Map(result.recordset.map((row) => [String(row.machineId).trim().toUpperCase(), row]));
  return machines.map((machine) => {
    const totals = totalsById.get(machine.id.trim().toUpperCase());
    return {
      id: machine.id,
      name: machine.name,
      shiftKm: Number(totals?.shiftKm || 0),
      shiftTon: Number(totals?.shiftTon || 0),
      dailyKm: Number(totals?.dailyKm || 0),
      dailyTon: Number(totals?.dailyTon || 0),
      shiftRows: Number(totals?.shiftRows || 0),
      dailyRows: Number(totals?.dailyRows || 0),
    };
  });
}

function addProductionSheet(workbook, name, title, closure, rows, kmKey, tonKey, countKey) {
  const sheet = workbook.addWorksheet(name);
  sheet.columns = [
    { header: 'ID máquina', key: 'id', width: 18 },
    { header: 'Máquina', key: 'name', width: 24 },
    { header: 'KM producidos', key: 'km', width: 18 },
    { header: 'TON producidas', key: 'ton', width: 18 },
    { header: 'Registros', key: 'count', width: 14 },
  ];
  sheet.mergeCells('A1:E1');
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { bold: true, size: 15, color: { argb: 'FFFFFFFF' } };
  sheet.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
  sheet.mergeCells('A2:E2');
  sheet.getCell('A2').value = `Periodo: ${formatLocalDateTime(closure.start)} a ${formatLocalDateTime(closure.end)}`;
  sheet.mergeCells('A3:E3');
  sheet.getCell('A3').value = `Ciclo productivo iniciado: ${closure.cycleDate} 07:00`;
  sheet.addRow([]);
  sheet.mergeCells('A4:E4');
  sheet.getCell('A4').value = `Generado: ${formatLocalDateTime(new Date())}`;
  sheet.addRow(sheet.columns.map((column) => column.header));
  const header = sheet.getRow(5);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
  sheet.autoFilter = { from: 'A5', to: 'E5' };
  sheet.views = [{ state: 'frozen', ySplit: 5 }];

  for (const row of rows) {
    sheet.addRow({
      id: row.id,
      name: row.name,
      km: row[kmKey],
      ton: row[tonKey],
      count: row[countKey],
    });
  }

  const totalRow = sheet.addRow({
    name: 'TOTAL',
    km: rows.reduce((sum, row) => sum + row[kmKey], 0),
    ton: rows.reduce((sum, row) => sum + row[tonKey], 0),
    count: rows.reduce((sum, row) => sum + row[countKey], 0),
  });
  totalRow.font = { bold: true };
  for (const row of sheet.getRows(6, rows.length + 1) || []) {
    row.getCell(3).numFmt = productionNumberFormat;
    row.getCell(4).numFmt = productionNumberFormat;
  }
  return sheet;
}

async function writeProductionWorkbook(outputPath, closure, rows) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Reporte de Producción';
  workbook.created = new Date();
  addProductionSheet(
    workbook,
    `Turno ${closure.id}`,
    `Producción del turno ${closure.id}`,
    closure,
    rows,
    'shiftKm',
    'shiftTon',
    'shiftRows',
  );
  addProductionSheet(
    workbook,
    'Acumulado diario',
    'Producción diaria acumulada',
    closure,
    rows,
    'dailyKm',
    'dailyTon',
    'dailyRows',
  );

  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await workbook.xlsx.writeFile(temporaryPath);
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    try {
      await fs.unlink(temporaryPath);
    } catch (cleanupError) {
      if (cleanupError.code !== 'ENOENT') {
        throw new AggregateError([error, cleanupError], 'Falló la creación del Excel y no se pudo limpiar el archivo temporal.');
      }
    }
    throw error;
  }
}

module.exports = { reportFileName, getShiftProduction, writeProductionWorkbook };
