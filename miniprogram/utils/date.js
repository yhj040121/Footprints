// 日期工具：date 字符串一律 'YYYY-MM-DD'（契约 §0.4，东八区以本地时区近似，真机均为东八区用户场景）
function pad2(n) {
  return n < 10 ? '0' + n : '' + n;
}

// Date → 'YYYY-MM-DD'
function formatDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

// 'YYYY-MM-DD' → Date（本地时区零点）
function parseDate(str) {
  const parts = (str || '').split('-');
  return new Date(+parts[0], (+parts[1] || 1) - 1, +(parts[2] || 1));
}

function today() {
  return formatDate(new Date());
}

// 是否未来日期（FR-03：不可选未来）
function isFuture(str) {
  return str > today();
}

// 'YYYY-MM-DD' → 'YYYY/MM/DD'（时间线左侧日期）
function displayDate(str) {
  return (str || '').replace(/-/g, '/');
}

// 'YYYY-MM-DD' → 'M月D日'
function displayDateCn(str) {
  const p = (str || '').split('-');
  return (+p[1]) + '月' + (+p[2]) + '日';
}

// 'YYYY-MM' → { first: 'YYYY-MM-01', last: 'YYYY-MM-<月末>' }
function monthRange(yearMonth) {
  const p = yearMonth.split('-');
  const y = +p[0];
  const m = +p[1];
  const last = new Date(y, m, 0).getDate();
  return { first: yearMonth + '-01', last: yearMonth + '-' + pad2(last) };
}

// 月历格子：返回 42 格（6 行 × 7 列，周日起），每格 { date, day, inMonth }
function calendarGrid(year, month) {
  const firstDay = new Date(year, month - 1, 1).getDay(); // 0=周日
  const cells = [];
  const start = new Date(year, month - 1, 1 - firstDay);
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    cells.push({
      date: formatDate(d),
      day: d.getDate(),
      inMonth: d.getMonth() === month - 1
    });
  }
  return cells;
}

// 'YYYY-MM' 偏移 n 个月 → 'YYYY-MM'
function addMonths(yearMonth, n) {
  const p = yearMonth.split('-');
  const d = new Date(+p[0], (+p[1]) - 1 + n, 1);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
}

// 同一天的记录按 createdAt 排序用：安全取时间戳
function tsOf(record) {
  const t = record && record.createdAt;
  if (!t) return 0;
  if (typeof t === 'number') return t;
  if (t.$date) return t.$date;
  return new Date(t).getTime() || 0;
}

module.exports = {
  pad2,
  formatDate,
  parseDate,
  today,
  isFuture,
  displayDate,
  displayDateCn,
  monthRange,
  calendarGrid,
  addMonths,
  tsOf
};
