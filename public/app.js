// Encierra la lógica del dashboard para no crear variables globales en el navegador.
(() => {
  // Atajo para localizar los elementos HTML que la interfaz actualiza.
  const $ = (selector) => document.querySelector(selector);
  const dateInitial = $('#fecha-inicial');
  const dateFinal = $('#fecha-final');
  const machinePicker = $('#machine-picker');
  const machineSummary = $('#machine-summary');
  const machineOptions = $('#machine-options');
  const selectedSummary = $('#selected-summary');
  const autoRefresh = $('#auto-refresh');
  const searchButton = $('#search-button');
  const summaryHead = $('#summary-head');
  const summaryBody = $('#summary-body');
  const reportStatus = $('#report-status');
  const currentShiftLabel = $('#current-shift');
  const periodLabel = $('#period-label');
  const rowCount = $('#row-count');
  const lastUpdated = $('#last-updated');
  const toast = $('#toast');

  // Indicadores que se dibujan en filas, en el mismo orden que aparecen en la tabla.
  const metrics = [
    { key: 'dailyKm', label: 'Producción del día (Km)', unit: 'Km' },
    { key: 'dailyTon', label: 'Producción del día (Ton)', unit: 'Ton' },
    { key: 'hourlyKm', label: 'Producción de la hora (Km)', unit: 'Km' },
    { key: 'hourlyTon', label: 'Producción de la hora (Ton)', unit: 'Ton' },
    { key: 'shiftKm', label: 'Producción del turno (Km)', unit: 'Km' },
    { key: 'shiftTon', label: 'Producción del turno (Ton)', unit: 'Ton' },
  ];

  // Estado de la interfaz: catálogo, frecuencia de actualización y control de peticiones.
  let machines = [];
  let refreshSeconds = 60;
  let intervalId = null;
  let isLoading = false;
  let followsCurrentProductionDay = true;
  let toastTimeout = null;

  // Formato regional para presentar resultados numéricos con dos decimales.
  const numberFormat = new Intl.NumberFormat('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  // Convierte una fecha local a ISO sin desplazarla por la zona horaria del navegador.
  function localIsoDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // Suma días calendario a una fecha YYYY-MM-DD manteniendo el cálculo en hora local.
  function shiftDate(dateString, days) {
    const [year, month, day] = dateString.split('-').map(Number);
    const date = new Date(year, month - 1, day, 12, 0, 0);
    date.setDate(date.getDate() + days);
    return localIsoDate(date);
  }

  // Obtiene la fecha inicial del ciclo productivo vigente, que cambia a las 07:00.
  function currentProductionStartDate(now = new Date()) {
    const today = localIsoDate(now);
    return (now.getHours() * 60 + now.getMinutes() < 7 * 60)
      ? shiftDate(today, -1)
      : today;
  }

  // Presenta una fecha ISO con el formato regional día/mes/año.
  function formatDate(dateString) {
    if (!dateString) return '—';
    const [year, month, day] = dateString.split('-').map(Number);
    return new Intl.DateTimeFormat('es-MX', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(year, month - 1, day, 12));
  }

  // Determina el turno correspondiente a la hora local del navegador.
  function currentShift() {
    const now = new Date();
    const minutes = now.getHours() * 60 + now.getMinutes();
    if (minutes >= 7 * 60 && minutes < 15 * 60) return 'A';
    if (minutes >= 15 * 60 && minutes < 22 * 60 + 30) return 'B';
    return 'C';
  }

  // Actualiza el rótulo del turno y su rango horario visible.
  function updateCurrentShiftLabel(shift = currentShift()) {
    const hours = { A: '07:00–14:59', B: '15:00–22:29', C: '22:30–06:59' };
    currentShiftLabel.textContent = `Turno actual: ${shift} · ${hours[shift]}`;
  }

  // Formatea un número o muestra una raya cuando el valor no está disponible.
  function fmt(value) {
    if (value === null || value === undefined || value === '' || !Number.isFinite(Number(value))) return '—';
    return numberFormat.format(Number(value));
  }

  // Cambia el estado visual del reporte y crea su indicador circular accesible.
  function setStatus(text, type = '') {
    reportStatus.className = `status-pill ${type}`.trim();
    reportStatus.replaceChildren();
    const dot = document.createElement('span');
    dot.className = 'status-dot';
    reportStatus.append(dot, document.createTextNode(text));
  }

  // Muestra un aviso temporal; el parámetro determina si se presenta como error.
  function showToast(message, isError = false) {
    toast.textContent = message;
    toast.className = `toast${isError ? ' error' : ''}`;
    toast.hidden = false;
    clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => { toast.hidden = true; }, 6500);
  }

  // Obtiene los IDs de las casillas de máquina actualmente marcadas.
  function chosenMachines() {
    return [...machineOptions.querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  }

  // Devuelve los objetos completos del catálogo que corresponden a la selección actual.
  function selectedMachineRecords() {
    const selectedIds = new Set(chosenMachines());
    return machines.filter((machine) => selectedIds.has(machine.id));
  }

  // Actualiza el resumen del selector según cuántas máquinas están seleccionadas.
  function updateMachineLabels() {
    const selected = selectedMachineRecords();
    if (!selected.length) {
      machineSummary.textContent = 'Ninguna máquina seleccionada';
      selectedSummary.textContent = 'Selecciona al menos una máquina';
    } else if (selected.length === machines.length) {
      machineSummary.textContent = 'Todas las máquinas';
      selectedSummary.textContent = `${selected.length} máquinas seleccionadas`;
    } else if (selected.length <= 2) {
      const names = selected.map((machine) => machine.name);
      machineSummary.textContent = names.join(', ');
      selectedSummary.textContent = `Máquinas seleccionadas: ${names.join(', ')}`;
    } else {
      machineSummary.textContent = `${selected.length} máquinas seleccionadas`;
      selectedSummary.textContent = `Máquinas seleccionadas: ${selected.map((machine) => machine.name).join(', ')}`;
    }
  }

  // Construye una casilla por máquina y deja todas seleccionadas inicialmente.
  function makeMachineOptions() {
    machineOptions.innerHTML = '';
    machines.forEach((machine, index) => {
      const label = document.createElement('label');
      label.className = 'machine-option';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.value = machine.id;
      input.checked = true;
      input.id = `machine-${index}`;
      input.addEventListener('change', updateMachineLabels);
      const text = document.createElement('span');
      text.textContent = machine.name;
      label.append(input, text);
      machineOptions.append(label);
    });
    updateMachineLabels();
  }

  // Crea una celda de tabla segura usando texto, evitando insertar HTML del servidor.
  function makeCell(text, className = '', tagName = 'td') {
    const cell = document.createElement(tagName);
    if (className) cell.className = className;
    cell.textContent = text;
    return cell;
  }

  // Dibuja cabeceras agrupadas por máquina y filas para cada indicador.
  function renderTable(machineRows, selectedMachines) {
    summaryHead.innerHTML = '';
    summaryBody.innerHTML = '';

    // La primera fila agrupa cada máquina bajo las columnas Real, Meta y Diferencia.
    const machineHeader = document.createElement('tr');
    machineHeader.append(makeCell('Indicador', '', 'th'), makeCell('Unidad', '', 'th'));
    machineHeader.children[0].rowSpan = 2;
    machineHeader.children[1].rowSpan = 2;
    selectedMachines.forEach((machine) => {
      const header = makeCell(`${machine.name}`, 'machine-group', 'th');
      header.colSpan = 3;
      header.scope = 'colgroup';
      machineHeader.append(header);
    });

    // Segunda fila: títulos de las tres mediciones de cada máquina.
    const subHeader = document.createElement('tr');
    selectedMachines.forEach(() => {
      ['Real', 'Meta', 'Dif.'].forEach((label) => {
        subHeader.append(makeCell(label, 'numeric sub-header', 'th'));
      });
    });
    summaryHead.append(machineHeader, subHeader);

    if (!machineRows.length) {
      const row = document.createElement('tr');
      const cell = makeCell('No hay máquinas seleccionadas.', 'empty-state');
      cell.colSpan = 2 + selectedMachines.length * 3;
      row.append(cell);
      summaryBody.append(row);
      return;
    }

    // Índice por ID para asociar rápidamente los resultados con las columnas.
    const byId = new Map(machineRows.map((row) => [String(row.machineId), row]));
    metrics.forEach((metricDef) => {
      const row = document.createElement('tr');
      row.append(makeCell(metricDef.label, 'metric-name'), makeCell(metricDef.unit, 'unit-cell'));
      selectedMachines.forEach((selectedMachine) => {
        const machine = byId.get(String(selectedMachine.id));
        const values = machine?.metrics?.[metricDef.key] || { actual: null, target: null, gap: null };
        row.append(makeCell(fmt(values.actual), 'numeric value-cell'));
        row.append(makeCell(fmt(values.target), 'numeric value-cell target-cell'));
        let gapClass = 'numeric gap-cell';
        if (values.gap !== null && values.gap !== undefined && values.gap !== '') {
          gapClass += Number(values.gap) < 0 ? ' gap-negative' : ' gap-positive';
        }
        row.append(makeCell(fmt(values.gap), gapClass));
      });
      summaryBody.append(row);
    });
  }

  // Actualiza periodo, turno, recuentos, hora y estado de conexión mostrados.
  function updateMeta(data) {
    const cycleStart = shiftDate(data.fin, -1);
    periodLabel.textContent = `Seleccionado: ${formatDate(data.inicio)} 07:00 — ${formatDate(data.fin)} 06:59 · Indicadores: ${formatDate(cycleStart)} 07:00 — ${formatDate(data.fin)} 06:59`;
    updateCurrentShiftLabel(data.turno);
    const records = Number(data.registrosProduccion || 0);
    const machinesWithData = Number(data.maquinasConProduccion || 0);
    rowCount.textContent = `${data.totalMaquinas} máquinas · ${records} registros · ${machinesWithData} con producción`;
    const updated = data.actualizado ? new Date(data.actualizado) : new Date();
    lastUpdated.textContent = `Última actualización: ${new Intl.DateTimeFormat('es-MX', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(updated)}`;
    if (data.modo === 'demo') {
      setStatus('Modo DEMO · datos de ejemplo', '');
    } else if (records === 0) {
      setStatus('SQL Server conectado · 0 registros en el periodo', 'warning');
    } else {
      setStatus(`SQL Server · ${records} registros`, 'success');
    }
  }

  // Sustituye el cuerpo de la tabla por un mensaje, respetando su ancho actual.
  function showEmptyError(message, selected) {
    summaryBody.innerHTML = '';
    const row = document.createElement('tr');
    const cell = makeCell(message, 'empty-state');
    cell.colSpan = 2 + selected.length * 3;
    row.append(cell);
    summaryBody.append(row);
  }

  // Valida filtros en el navegador y solicita al servidor el reporte correspondiente.
  async function loadReport({ silent = false } = {}) {
    // Evita solicitudes simultáneas y recopila el estado de filtros actual.
    if (isLoading) return;
    const inicio = dateInitial.value;
    const fin = dateFinal.value;
    const turno = currentShift();
    const selected = chosenMachines();
    const selectedRecords = selectedMachineRecords();
    updateCurrentShiftLabel(turno);

    // Valida fechas y máquinas antes de iniciar la petición HTTP.
    if (!inicio || !fin) {
      showToast('Selecciona la fecha inicial y la fecha final.', true);
      return;
    }
    if (fin <= inicio) {
      showToast('La fecha final debe ser posterior a la inicial. Por ejemplo, del 23/10 al 24/10.', true);
      return;
    }
    if (!selected.length) {
      showToast('Selecciona al menos una máquina.', true);
      return;
    }

    // Bloquea el botón y marca carga; en actualización automática conserva el estado discreto.
    isLoading = true;
    searchButton.disabled = true;
    searchButton.textContent = 'Consultando…';
    if (!silent) setStatus('Consultando reporte…', 'loading');

    try {
      // Codifica todos los filtros, incluidas las máquinas repetidas como parámetros separados.
      const params = new URLSearchParams({ inicio, fin, turno });
      selected.forEach((machineCode) => params.append('maquinas', machineCode));
      const response = await fetch(`/api/reportes?${params.toString()}`, { headers: { Accept: 'application/json' } });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'No se pudo consultar el reporte.');
      renderTable(payload.maquinas || [], selectedRecords);
      updateMeta(payload);
    } catch (error) {
      // Informa del fallo tanto en el indicador como dentro de la tabla.
      setStatus('Error al consultar', 'error');
      if (!silent) showToast(error.message || 'No fue posible cargar el reporte.', true);
      showEmptyError(error.message || 'No fue posible cargar el reporte.', selected);
    } finally {
      // Restaura controles aunque la solicitud haya fallado.
      isLoading = false;
      searchButton.disabled = false;
      searchButton.innerHTML = '<span class="button-icon">⌕</span> Buscar';
    }
  }

  // Reinicia el temporizador automático según la preferencia del usuario.
  function restartAutoRefresh() {
    clearInterval(intervalId);
    intervalId = null;
    if (autoRefresh.checked) {
      intervalId = setInterval(() => {
        updateAutomaticDateRange();
        loadReport({ silent: true });
      }, refreshSeconds * 1000);
    }
  }

  // Avanza el rango un ciclo cuando se usan las fechas predeterminadas del dashboard.
  function updateAutomaticDateRange() {
    if (!followsCurrentProductionDay) return;

    const productionStartDate = currentProductionStartDate();
    if (dateInitial.value === productionStartDate) return;

    dateInitial.value = productionStartDate;
    dateFinal.value = shiftDate(productionStartDate, 1);
    dateFinal.min = dateFinal.value;
  }

  // Inicializa fechas y carga la configuración del catálogo desde la API.
  async function initialize() {
    // Antes de las 07:00, el turno C pertenece al ciclo que inició el día anterior.
    const productionStartDate = currentProductionStartDate();
    dateInitial.value = productionStartDate;
    dateFinal.value = shiftDate(productionStartDate, 1);
    dateFinal.min = shiftDate(productionStartDate, 1);
    try {
      // Obtiene máquinas y frecuencia de actualización antes de consultar el reporte inicial.
      const response = await fetch('/api/config', { headers: { Accept: 'application/json' } });
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || 'No fue posible cargar la configuración.');
      machines = config.maquinas || [];
      refreshSeconds = Math.max(15, Number(config.autoRefreshSeconds || 60));
      makeMachineOptions();
      if (!machines.length) throw new Error('No se encontraron máquinas en la vista dbo.vw_get_Production_Report.');
      await loadReport();
    } catch (error) {
      // Hace visible un fallo de servidor o un catálogo vacío y muestra su causa.
      setStatus('Servidor no disponible', 'error');
      showToast(error.message || 'No se pudo cargar la lista de máquinas.', true);
      machineSummary.textContent = 'No se pudieron cargar las máquinas';
      selectedSummary.textContent = 'Verifica la vista de producción y la conexión';
      showEmptyError(error.message || 'No se pudo cargar la lista de máquinas.', []);
    }
  }

  // Los botones de selección masiva cambian todas las casillas y sincronizan sus etiquetas.
  $('#select-all-machines').addEventListener('click', () => {
    machineOptions.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = true; });
    updateMachineLabels();
  });
  $('#clear-all-machines').addEventListener('click', () => {
    machineOptions.querySelectorAll('input[type="checkbox"]').forEach((input) => { input.checked = false; });
    updateMachineLabels();
  });
  // El botón principal ejecuta una consulta manual.
  searchButton.addEventListener('click', () => loadReport());
  // Al cambiar la fecha inicial, fuerza que la final sea al menos el día siguiente.
  dateInitial.addEventListener('change', () => {
    followsCurrentProductionDay = false;
    const earliestFinal = shiftDate(dateInitial.value, 1);
    dateFinal.min = earliestFinal;
    if (!dateFinal.value || dateFinal.value < earliestFinal) dateFinal.value = earliestFinal;
  });
  // Una fecha final elegida manualmente también fija el rango para no sobrescribirlo.
  dateFinal.addEventListener('change', () => { followsCurrentProductionDay = false; });
  // Activa o desactiva el ciclo periódico de consultas.
  autoRefresh.addEventListener('change', restartAutoRefresh);
  // Cierra el menú desplegable de máquinas al hacer clic fuera de él.
  document.addEventListener('click', (event) => {
    if (!machinePicker.contains(event.target)) machinePicker.open = false;
  });
  // Limpia el temporizador cuando el usuario abandona o recarga la página.
  window.addEventListener('beforeunload', () => clearInterval(intervalId));

  // Arranca el dashboard y configura las consultas automáticas al terminar la carga.
  initialize().then(restartAutoRefresh);
})();
