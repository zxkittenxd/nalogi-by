/* Тесты расчётов — node test.js */
const { netOf, grossFromNet, superTax, calcNPD } = require('./app.js');

let pass = 0, fail = 0;
function eq(name, actual, expected, tol = 0.011) {
  const ok = Math.abs(actual - expected) <= tol;
  if (ok) { pass++; console.log(`  ✓ ${name}: ${actual}`); }
  else { fail++; console.error(`  ✗ ${name}: получено ${actual}, ожидалось ${expected}`); }
}

console.log('--- Зарплата gross → net ---');
// 2000: ФСЗН 20, вычет не положен (2000 > 1308), база 1980, ндфл 257.40, net 1722.60
let d = netOf(2000, 0, false);
eq('gross 2000 → ФСЗН', d.fszn, 20);
eq('gross 2000 → вычет 0', d.stdDed, 0);
eq('gross 2000 → НДФЛ', d.ndfl, 257.40);
eq('gross 2000 → net', d.net, 1722.60);

// 1000: ФСЗН 10, ≤1308 → вычет 216, база 774, ндфл 100.62, net 889.38
d = netOf(1000, 0, false);
eq('gross 1000 → вычет 216', d.stdDed, 216);
eq('gross 1000 → НДФЛ', d.ndfl, 100.62);
eq('gross 1000 → net', d.net, 889.38);

// 1300 + 2 ребёнка (63×2): ФСЗН 13, вычеты 216+126=342, база 945, ндфл 122.85, net 1164.15
d = netOf(1300, 2, false);
eq('gross 1300, 2 детей → НДФЛ', d.ndfl, 122.85);
eq('gross 1300, 2 детей → net', d.net, 1164.15);

// 1300 + 1 ребёнок, одинокий родитель (120): вычеты 216+120=336, база 951, ндфл 123.63, net 1163.37
d = netOf(1300, 1, true);
eq('gross 1300, 1 ребёнок (120) → net', d.net, 1163.37);

// Нулевая зарплата
d = netOf(0, 0, false);
eq('gross 0 → net 0', d.net, 0);

// Порог: 1308 → вычет есть; 1309 → уже нет
eq('1308 → вычет', netOf(1308, 0, false).stdDed, 216);
eq('1309 → вычет 0', netOf(1309, 0, false).stdDed, 0);

console.log('--- Зарплата net → gross (обратный) ---');
let r = grossFromNet(1722.60, 0, false);
eq('net 1722.60 → gross', r.gross, 2000, 0.02);
r = grossFromNet(889.38, 0, false);
eq('net 889.38 → gross', r.gross, 1000, 0.02);
r = grossFromNet(1164.15, 2, false);
eq('net 1164.15 (2 детей) → gross', r.gross, 1300, 0.02);
r = grossFromNet(3000, 0, false);
// net X → gross: X = g - 0.01g - 0.13*0.99g = g*(1 - 0.01 - 0.1287) = g*0.8613 → g = 3000/0.8613
eq('net 3000 → gross ≈', r.gross, 3000 / 0.8613, 0.05);
eq('net 3000 → проверка net(gross)', netOf(r.gross, 0, false).net, 3000, 0.02);

console.log('--- Сверхдоходы ---');
// 700 000: 13%×350k = 45 500; 25%×250k = 62 500; 30%×100k = 30 000; итого 138 000; удержано 91 000; доплата 47 000
let s = superTax(700000, false);
eq('700k → всего налога', s.total, 138000);
eq('700k → удержано 13%', s.withheld, 91000);
eq('700k → доплата', s.extra, 47000);
eq('700k → строк 3', s.rows.length, 3, 0);

// 300 000: только 13% → 39 000, доплата 0, exceeded=false
s = superTax(300000, false);
eq('300k → налог', s.total, 39000);
eq('300k → доплата 0', s.extra, 0);
eq('300k → не превышен', s.exceeded ? 1 : 0, 0, 0);

// 500 000: 45 500 + 25%×150k = 37 500 → 83 000
s = superTax(500000, false);
eq('500k → налог', s.total, 83000);

// Дивиденды 700 000: 13%×350k + 25%×350k = 45 500 + 87 500 = 133 000 (без 30%)
s = superTax(700000, true);
eq('700k дивиденды → налог', s.total, 133000);

console.log('--- НПД ---');
// Физлица, 1500/мес: 10% → 150, минимум не применяется
let n = calcNPD(1500, 'phys', false);
eq('НПД 1500 физлица → 150', n.toPay, 150);
eq('НПД 1500 → годовой', n.yearToPay, 1800);

// 300/мес: расчётный 30 < 45 → платит 45 (минимум с 01.07.2026)
n = calcNPD(300, 'phys', false);
eq('НПД 300 → минимум 45', n.toPay, 45);
eq('НПД 300 → minApplies', n.minApplies ? 1 : 0, 1, 0);

// 0/мес → всё равно 45
n = calcNPD(0, 'phys', false);
eq('НПД 0 → минимум 45', n.toPay, 45);

// Пенсионер 1000/мес физлица: 4% → 40 ≥ 18 → 40
n = calcNPD(1000, 'phys', true);
eq('НПД пенсионер 1000 → 40 (4%)', n.toPay, 40);

// Пенсионер 300/мес: 4% → 12 < 18 → минимум 18
n = calcNPD(300, 'phys', true);
eq('НПД пенсионер 300 → минимум 18', n.toPay, 18);

// Орги 6000/мес (72k/год > 60k): до порога 10% = 600, после 20% = 1200; crossMonth = ceil(60000/6000) = 10
n = calcNPD(6000, 'org', false);
eq('НПД орг 6000 → до порога', n.taxBefore, 600);
eq('НПД орг 6000 → после порога', n.taxAfter, 1200);
eq('НПД орг 6000 → месяц превышения', n.crossMonth, 10, 0);
eq('НПД орг 6000 → годовой (60k×10% + 12k×20%)', n.yearTax, 6000 + 2400);

// Орги 4000/мес (48k/год ≤ 60k): всегда 10% → 400
n = calcNPD(4000, 'org', false);
eq('НПД орг 4000 → 400 (10%)', n.toPay, 400);
eq('НПД орг 4000 → без превышения', n.rateLater === null ? 0 : 1, 0, 0);

console.log(`\nИТОГ: ${pass} пройдено, ${fail} провалено`);
process.exit(fail ? 1 : 0);
