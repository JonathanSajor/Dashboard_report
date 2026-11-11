const SHIFT_DEFINITIONS = [
  { id: 'A', start: [7, 0], end: [15, 0] },
  { id: 'B', start: [15, 0], end: [22, 30] },
  { id: 'C', start: [22, 30], end: [7, 0] },
];

function formatLocalDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatLocalDateTime(date) {
  return `${formatLocalDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}:00`;
}

function getCompletedShiftClosures(after, through) {
  if (!(after instanceof Date) || Number.isNaN(after.getTime())
    || !(through instanceof Date) || Number.isNaN(through.getTime())
    || through <= after) {
    return [];
  }

  const closures = [];
  const day = new Date(after.getFullYear(), after.getMonth(), after.getDate() - 1);
  const lastDay = new Date(through.getFullYear(), through.getMonth(), through.getDate());

  while (day <= lastDay) {
    const cycleDate = formatLocalDate(day);
    for (const shift of SHIFT_DEFINITIONS) {
      const start = new Date(day.getFullYear(), day.getMonth(), day.getDate(), shift.start[0], shift.start[1]);
      const endDayOffset = shift.id === 'C' ? 1 : 0;
      const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + endDayOffset, shift.end[0], shift.end[1]);
      if (end > after && end <= through) {
        closures.push({ id: shift.id, cycleDate, start, end });
      }
    }
    day.setDate(day.getDate() + 1);
  }

  return closures.sort((left, right) => left.end - right.end);
}

module.exports = { formatLocalDate, formatLocalDateTime, getCompletedShiftClosures };
