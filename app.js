/* ===== Налоги·BY — app.js =====
 * Параметры приведены по НК РБ на 2026 год (Закон № 127-З от 30.12.2025,
 * данные nalog.gov.by). Все ставки вынесены в объект P — при изменении
 * законодательства правится только он.
 */
const P = {
  fsznRate: 0.01,            // взнос работника в ФСЗН, 1%
  ndflRate: 0.13,            // подоходный налог, базовая ставка 13%
  stdDeduction: 216,         // стандартный вычет, руб./мес
  stdThreshold: 1308,        // предел дохода для стандартного вычета, руб./мес
  childDeduction: 63,        // вычет на ребёнка, руб./мес
  childDeductionBig: 120,    // повышенный вычет на ребёнка, руб./мес
  brackets: [                // прогрессивная шкала сверхдоходов (годовой доход)
    { upTo: 350000,   rate: 0.13 },
    { upTo: 600000,   rate: 0.25 },
    { upTo: Infinity, rate: 0.30 }
  ],
  dividendBrackets: [        // шкала для дивидендов (без 30%)
    { upTo: 350000,   rate: 0.13 },
    { upTo: Infinity, rate: 0.25 }
  ],
  npd: {
    base: 0.10, high: 0.20,          // обычные ставки
    pensionBase: 0.04, pensionHigh: 0.08, // фактические ставки для пенсионеров
    orgLimitYear: 60000,             // годовой лимит доходов от бел. организаций/ИП
    minMonth: 45,                    // минимальный платёж с 01.07.2026
    minMonthPension: 18              // минимальный платёж для пенсионеров
  }
};

/* ---------- Чистые функции расчёта ---------- */

// Возвращает полную раскладку по зарплате gross -> net
function netOf(gross, kids, bigKids) {
  gross = Math.max(0, +gross || 0);
  const fszn = gross * P.fsznRate;
  const childDed = kids * (bigKids ? P.childDeductionBig : P.childDeduction);
  const stdApplied = gross <= P.stdThreshold;
  const stdDed = stdApplied ? P.stdDeduction : 0;
  const deductions = stdDed + childDed;
  const base = Math.max(0, gross - fszn - deductions);
  const ndfl = base * P.ndflRate;
  const net = gross - fszn - ndfl;
  return { gross, fszn, stdDed, childDed, deductions, base, ndfl, net };
}

// Обратный расчёт: ищем gross, при котором net ≈ target.
// Функция net(gross) немонотонна у порога вычета (1308 руб.) — берём первое
// подходящее значение сканированием с последующим уточнением.
function grossFromNet(target, kids, bigKids) {
  target = Math.max(0, +target || 0);
  if (target === 0) return { gross: 0, detail: netOf(0, kids, bigKids), exact: true };
  let candidate = null;
  const LIMIT = 1000000;
  for (let g = 0; g <= LIMIT; g += 1) {
    if (netOf(g, kids, bigKids).net >= target - 0.005) { candidate = g; break; }
  }
  if (candidate === null) return { gross: null, detail: null, exact: false };
  let best = candidate;
  for (let g = Math.max(0, candidate - 1); g <= candidate + 0.001; g += 0.01) {
    if (netOf(g, kids, bigKids).net >= target - 0.005) { best = Math.round(g * 100) / 100; break; }
  }
  const detail = netOf(best, kids, bigKids);
  return { gross: best, detail, exact: Math.abs(detail.net - target) <= 0.01 };
}

// Налог на сверхдоходы по годовому доходу
function superTax(annual, isDividend) {
  annual = Math.max(0, +annual || 0);
  const brackets = isDividend ? P.dividendBrackets : P.brackets;
  const rows = [];
  let prev = 0, total = 0;
  for (const b of brackets) {
    const slice = Math.min(Math.max(annual - prev, 0), b.upTo - prev);
    if (slice > 0) {
      const tax = slice * b.rate;
      total += tax;
      const label = b.upTo === Infinity
        ? `свыше ${fmt0(prev)} руб. — ${(b.rate * 100).toFixed(0)}%`
        : `${fmt0(prev)}–${fmt0(b.upTo)} руб. — ${(b.rate * 100).toFixed(0)}%`;
      rows.push({ label, slice, tax });
    }
    prev = b.upTo;
    if (annual <= prev) break;
  }
  const withheld = annual * P.ndflRate; // наниматель удерживал 13% в течение года
  return { total, rows, withheld, extra: Math.max(0, total - withheld), exceeded: annual > 350000 };
}

// НПД: monthly — доход за месяц; src: 'phys' | 'org'; pension — получатель пенсии
function calcNPD(monthly, src, pension) {
  monthly = Math.max(0, +monthly || 0);
  const rBase = pension ? P.npd.pensionBase : P.npd.base;
  const rHigh = pension ? P.npd.pensionHigh : P.npd.high;
  const minPay = pension ? P.npd.minMonthPension : P.npd.minMonth;
  const annual = monthly * 12;
  const res = { monthly, annual, rBase, rHigh, minPay, src, pension };

  if (src === 'phys' || annual <= P.npd.orgLimitYear) {
    res.taxCalc = monthly * rBase;
    res.rateNow = rBase;
    res.rateLater = null;
    res.crossMonth = null;
  } else {
    // часть года по 10%, после превышения 60 000 — по 20%
    res.crossMonth = Math.min(12, Math.ceil(P.npd.orgLimitYear / Math.max(monthly, 0.01)));
    res.taxBefore = monthly * rBase;
    res.taxAfter = monthly * rHigh;
    res.rateNow = rBase;
    res.rateLater = rHigh;
    // «устойчивый» месяц после превышения порога:
    res.taxCalc = res.taxAfter;
    // годовой налог (точный): часть в пределах лимита по базовой ставке + остаток по повышенной
    const basePart = Math.min(annual, P.npd.orgLimitYear);
    const highPart = Math.max(0, annual - P.npd.orgLimitYear);
    res.yearTax = basePart * rBase + highPart * rHigh;
    // с учётом минимального платежа (ориентировочно, по месяцам)
    res.yearTaxWithMin = Math.max(res.yearTax, minPay * 12);
  }
  res.toPay = Math.max(res.taxCalc, minPay);
  res.minApplies = res.taxCalc < minPay;
  res.yearToPay = res.yearTaxWithMin !== undefined
    ? res.yearTaxWithMin
    : Math.max(res.taxCalc, minPay) * 12;
  return res;
}

/* ---------- Форматирование ---------- */
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}
function fmt0(n) {
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 0 }).format(Math.round(n));
}

/* ---------- DOM ---------- */
function init() {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => document.querySelectorAll(s);

  // --- Табы ---
  $$('.tab').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $$('[data-goto]').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      const g = a.dataset.goto;
      if (g === 'super') {
        const gross = parseFloat($('#salary-amount').value) || 0;
        $('#super-amount').value = Math.round(gross * 12);
        renderSuper();
      }
      switchTab(g);
    });
  });
  function switchTab(name) {
    $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    $$('.tab-panel').forEach((p) => p.classList.toggle('active', p.id === 'panel-' + name));
    updateURL();
  }

  // --- Зарплата ---
  let dir = 'g2n';
  let kids = 0;
  $$('#salary-direction .dir-btn').forEach((b) => {
    b.addEventListener('click', () => {
      dir = b.dataset.dir;
      $$('#salary-direction .dir-btn').forEach((x) => x.classList.toggle('active', x === b));
      $('#salary-amount-label').textContent = dir === 'g2n'
        ? 'Начисленная зарплата (gross), BYN'
        : 'Желаемая сумма на руки (net), BYN';
      renderSalary();
    });
  });
  $$('#kids-stepper .step-btn').forEach((b) => {
    b.addEventListener('click', () => {
      kids = Math.max(0, Math.min(10, kids + parseInt(b.dataset.d, 10)));
      $('#kids-val').textContent = kids;
      renderSalary();
    });
  });
  $('#salary-amount').addEventListener('input', debounce(renderSalary, 120));
  $('#kids-big').addEventListener('change', renderSalary);
  $$('#salary-chips .chip').forEach((c) => {
    c.addEventListener('click', () => { $('#salary-amount').value = c.dataset.v; renderSalary(); });
  });

  function renderSalary() {
    const amount = parseFloat($('#salary-amount').value) || 0;
    const bigKids = $('#kids-big').checked;
    const rows = [];
    let mainVal, mainLabel, sub;

    if (dir === 'g2n') {
      const d = netOf(amount, kids, bigKids);
      mainVal = fmt(d.net) + ' руб.';
      mainLabel = 'На руки (net)';
      sub = `в год: ${fmt0(d.net * 12)} руб. · эффективная ставка ${amount > 0 ? fmt((amount - d.net) / amount * 100) : '0,00'}%`;
      rows.push(['Взносы в ФСЗН (1%)', '−' + fmt(d.fszn), 'minus']);
      if (d.stdDed > 0) rows.push(['Стандартный вычет (доход ≤ 1 308 руб.)', '−' + fmt(d.stdDed), '']);
      if (d.childDed > 0) rows.push([`Вычет на детей (${kids} × ${bigKids ? 120 : 63} руб.)`, '−' + fmt(d.childDed), '']);
      rows.push(['Налоговая база', fmt(d.base), '']);
      rows.push(['Подоходный налог (13%)', '−' + fmt(d.ndfl), 'minus']);
      rows.push(['Итого на руки', fmt(d.net), 'total plus']);
      $('#salary-superincome-warn').classList.toggle('hidden', amount * 12 <= 350000);
      $('#salary-note').textContent = '';
    } else {
      const r = grossFromNet(amount, kids, bigKids);
      mainLabel = 'Начислить (gross)';
      if (!r.gross) {
        mainVal = '> 1 млн руб.';
        sub = 'введите меньшую сумму';
        rows.length = 0;
      } else {
        const d = r.detail;
        mainVal = fmt(r.gross) + ' руб.';
        sub = r.exact
          ? `на руки выйдет ровно ${fmt(d.net)} руб.`
          : `на руки выйдет ${fmt(d.net)} руб. (точное значение недостижимо из-за порога вычета)`;
        rows.push(['Зарплата gross', fmt(r.gross), '']);
        rows.push(['Взносы в ФСЗН (1%)', '−' + fmt(d.fszn), 'minus']);
        if (d.stdDed > 0) rows.push(['Стандартный вычет', '−' + fmt(d.stdDed), '']);
        if (d.childDed > 0) rows.push([`Вычет на детей (${kids} × ${bigKids ? 120 : 63} руб.)`, '−' + fmt(d.childDed), '']);
        rows.push(['Подоходный налог (13%)', '−' + fmt(d.ndfl), 'minus']);
        rows.push(['Итого на руки', fmt(d.net), 'total plus']);
        $('#salary-superincome-warn').classList.toggle('hidden', r.gross * 12 <= 350000);
      }
      $('#salary-note').textContent = 'Подбор gross выполняется с точностью до копейки; у порога стандартного вычета (1 308 руб.) некоторые значения net недостижимы — показываем ближайшее.';
    }
    $('#salary-main-label').textContent = mainLabel;
    $('#salary-net').textContent = mainVal;
    $('#salary-net-year').textContent = sub || '';
    fillTable($('#salary-breakdown'), rows);
    updateURL();
  }

  // --- НПД ---
  $('#npd-amount').addEventListener('input', debounce(renderNPD, 120));
  $('#npd-pension').addEventListener('change', renderNPD);
  $$('input[name="npd-src"]').forEach((r) => r.addEventListener('change', renderNPD));

  function renderNPD() {
    const monthly = parseFloat($('#npd-amount').value) || 0;
    const src = document.querySelector('input[name="npd-src"]:checked').value;
    const pension = $('#npd-pension').checked;
    const r = calcNPD(monthly, src, pension);
    const rows = [];

    if (r.rateLater !== null) {
      rows.push([`Пока годовой доход ≤ 60 000 руб. (≈ до ${r.crossMonth}-го месяца) — ${fmt0(r.rBase * 100)}%`, fmt(r.taxBefore), '']);
      rows.push([`После превышения — ${fmt0(r.rHigh * 100)}%`, fmt(r.taxAfter), '']);
      rows.push(['Годовой налог (ориентировочно)', fmt(r.yearToPay), 'total']);
      $('#npd-sub').textContent = `показан месяц после превышения лимита 60 000 руб./год`;
    } else {
      rows.push([`Расчётный налог (${fmt0(r.rBase * 100)}% от ${fmt0(monthly)} руб.)`, fmt(r.taxCalc), '']);
      rows.push(['Годовой налог (ориентировочно)', fmt(r.yearToPay), 'total']);
      $('#npd-sub').textContent = `доход за год: ${fmt0(r.annual)} руб. · ставка ${fmt0(r.rBase * 100)}%`;
    }
    if (r.minApplies) {
      rows.push([`Минимальный платёж с 01.07.2026`, fmt(r.minPay), 'minus']);
      $('#npd-min-warn').classList.remove('hidden');
    } else {
      $('#npd-min-warn').classList.add('hidden');
    }
    $('#npd-tax').textContent = fmt(r.toPay) + ' руб.';
    fillTable($('#npd-breakdown'), rows);
    updateURL();
  }

  // --- Сверхдоходы ---
  $('#super-amount').addEventListener('input', debounce(renderSuper, 120));
  $('#super-dividend').addEventListener('change', renderSuper);
  $$('#super-chips .chip').forEach((c) => {
    c.addEventListener('click', () => { $('#super-amount').value = c.dataset.v; renderSuper(); });
  });

  function renderSuper() {
    const annual = parseFloat($('#super-amount').value) || 0;
    const isDiv = $('#super-dividend').checked;
    const r = superTax(annual, isDiv);
    const rows = [];
    r.rows.forEach((x) => rows.push([`${x.label} (база ${fmt0(x.slice)} руб.)`, fmt(x.tax), '']));
    rows.push(['Удержано нанимателем в течение года (13%)', fmt(r.withheld), 'muted-row']);
    rows.push(['Итого налог за год', fmt(r.total), 'total']);
    $('#super-total').textContent = fmt(r.total) + ' руб.';
    $('#super-sub').textContent = `эффективная ставка ${annual > 0 ? fmt(r.total / annual * 100) : '0,00'}% · доход ${fmt0(annual)} руб./год`;

    const w = $('#super-doplate-warn');
    if (r.exceeded) {
      w.innerHTML = `📌 Превышение порога 350 000 руб. Есть основание для декларации: подать <b>до 31 марта 2027 г.</b>, доплатить <b>${fmt(r.extra)} руб.</b> до <b>1 июня 2027 г.</b>. Вычеты (ст. 208–212 НК) к сумме превышения не применяются.`;
      w.classList.remove('hidden');
    } else {
      w.innerHTML = '✅ Годовой доход не превышает 350 000 руб. — применяется только ставка 13%, декларация по сверхдоходам не требуется.';
      w.classList.remove('hidden');
      w.style.background = 'var(--accent-soft)';
      w.style.borderColor = 'var(--accent)';
    }
    if (r.exceeded) { w.style.background = ''; w.style.borderColor = ''; }
    fillTable($('#super-breakdown'), rows);
    updateURL();
  }

  // --- Таблицы ---
  function fillTable(el, rows) {
    el.innerHTML = rows.map(([label, val, cls]) => {
      const trCls = (cls || '').split(' ').filter((c) => c === 'total' || c === 'muted-row').join(' ');
      const tdCls = (cls || '').split(' ').filter((c) => c === 'minus' || c === 'plus').join(' ');
      return `<tr class="${trCls}"><td>${label}</td><td class="${tdCls}">${val}</td></tr>`;
    }).join('');
  }

  // --- Копирование ---
  function setupCopy(btnId, getText) {
    const btn = $(btnId);
    if (!btn) return;
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(getText());
        toast('Скопировано в буфер обмена');
      } catch (e) { toast('Не удалось скопировать'); }
    });
  }
  setupCopy('#copy-salary', () => {
    const rows = [...$('#salary-breakdown').querySelectorAll('tr')]
      .map((tr) => `${tr.cells[0].textContent}: ${tr.cells[1].textContent}`).join('\n');
    return `Расчёт зарплаты (Налоги·BY, 2026)\n${rows}\n${location.href}`;
  });
  setupCopy('#copy-npd', () => {
    const rows = [...$('#npd-breakdown').querySelectorAll('tr')]
      .map((tr) => `${tr.cells[0].textContent}: ${tr.cells[1].textContent}`).join('\n');
    return `Расчёт НПД (Налоги·BY, 2026)\nК уплате: ${$('#npd-tax').textContent}\n${rows}\n${location.href}`;
  });
  setupCopy('#copy-super', () => {
    const rows = [...$('#super-breakdown').querySelectorAll('tr')]
      .map((tr) => `${tr.cells[0].textContent}: ${tr.cells[1].textContent}`).join('\n');
    return `Расчёт налога на сверхдоходы (Налоги·BY, 2026)\nИтого: ${$('#super-total').textContent}\n${rows}\n${location.href}`;
  });

  function toast(msg) {
    let t = $('#toast');
    if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 1800);
  }

  // --- URL-параметры (шаринг расчёта) ---
  function updateURL() {
    try {
      const tab = $('.tab.active').dataset.tab;
      const params = new URLSearchParams();
      params.set('tab', tab);
      if (tab === 'salary') {
        params.set(dir === 'g2n' ? 'gross' : 'net', $('#salary-amount').value);
        if (kids) params.set('kids', kids);
        if ($('#kids-big').checked) params.set('bigkids', '1');
      } else if (tab === 'npd') {
        params.set('m', $('#npd-amount').value);
      } else if (tab === 'super') {
        params.set('y', $('#super-amount').value);
      }
      history.replaceState(null, '', '?' + params.toString());
    } catch (e) { /* file:// и т.п. */ }
  }
  function readURL() {
    try {
      const q = new URLSearchParams(location.search);
      if (q.get('gross')) { $('#salary-amount').value = q.get('gross'); }
      if (q.get('net')) {
        dir = 'n2g';
        $$('#salary-direction .dir-btn').forEach((x) => x.classList.toggle('active', x.dataset.dir === 'n2g'));
        $('#salary-amount-label').textContent = 'Желаемая сумма на руки (net), BYN';
        $('#salary-amount').value = q.get('net');
      }
      if (q.get('kids')) { kids = Math.min(10, parseInt(q.get('kids'), 10) || 0); $('#kids-val').textContent = kids; }
      if (q.get('bigkids')) $('#kids-big').checked = true;
      if (q.get('m')) $('#npd-amount').value = q.get('m');
      if (q.get('y')) $('#super-amount').value = q.get('y');
      const tab = q.get('tab');
      if (tab && ['salary', 'npd', 'super'].includes(tab)) switchTab(tab);
    } catch (e) { /* noop */ }
  }

  function debounce(fn, ms) {
    let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
  }

  readURL();
  renderSalary();
  renderNPD();
  renderSuper();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { P, netOf, grossFromNet, superTax, calcNPD };
}
