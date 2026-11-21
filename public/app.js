const query = (selector, parent = document) => parent.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const currency = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
const options = { expense: ['餐饮', '交通', '日用', '居家', '购物', '娱乐', '医疗', '学习', '其他'], income: ['工资', '兼职', '奖金', '退款', '其他'] };
const categoryIcons = { 餐饮: 'coffee', 交通: 'train', 日用: 'bag', 居家: 'home', 购物: 'bag', 娱乐: 'film', 医疗: 'pill', 学习: 'book', 工资: 'wallet', 兼职: 'user', 奖金: 'gift', 退款: 'arrow-left', 其他: 'receipt' };
const state = { user: null, profileType: 'student', household: null, ledgerScope: 'personal', categories: options, demo: false, month: currentMonth(), trendMode: 'month', filter: 'all', search: '', records: [], dashboard: null, editing: null, kind: 'expense', recordRequest: 0, overviewRequest: 0 };
const profileLabels = { student: '学生账本', employee: '上班族账本', family: '家庭账本' };

function scoped(path) {
  return `${path}${path.includes('?') ? '&' : '?'}scope=${encodeURIComponent(state.ledgerScope)}`;
}

function currentMonth() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function today() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const money = (cents) => `¥${currency.format(Number(cents || 0) / 100)}`;

function icon(name, className = 'icon') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', className);
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

async function api(url, init = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...init });
  if (response.status === 204) return null;
  const isJson = (response.headers.get('content-type') || '').includes('application/json');
  const result = isJson ? await response.json() : await response.text();
  if (!response.ok) throw new Error(isJson && result.error ? result.error : '请求失败。');
  return result;
}

function toast(message, kind = 'success') {
  const element = document.createElement('div');
  element.className = 'toast';
  element.dataset.kind = kind;
  element.textContent = message;
  query('#toast-region').append(element);
  window.setTimeout(() => element.remove(), 3300);
}

function errorMessage(target, message = '') {
  target.textContent = message;
  target.hidden = !message;
}

function setAuthMode(registering) {
  const form = query('#auth-form');
  form.dataset.mode = registering ? 'register' : 'login';
  query('#name-field').hidden = !registering;
  query('#profile-field').hidden = !registering;
  query('#auth-title').textContent = registering ? '创建你的账本' : '欢迎回来';
  query('#auth-subtitle').textContent = registering ? '给自己的生活，留一本清楚的账' : '登录你的个人账本';
  query('#auth-submit').replaceChildren(registering ? '创建账户' : '登录', icon('chevron'));
  query('#auth-switch-label').textContent = registering ? '已经有账号？' : '还没有账号？';
  query('#auth-switch').textContent = registering ? '返回登录' : '创建账户';
  const password = query('[name="password"]', form);
  password.autocomplete = registering ? 'new-password' : 'current-password';
  password.placeholder = registering ? '至少 8 位，含字母和数字' : '输入你的密码';
  password.value = '';
  errorMessage(query('#auth-error'));
}

function showAuth() {
  state.user = null;
  clearWorkspaceData();
  query('#workspace').hidden = true;
  query('#auth-screen').hidden = false;
  query('#demo-divider').hidden = !state.demo;
  query('#demo-login').hidden = !state.demo;
  setAuthMode(false);
}

async function enterWorkspace(user, household = undefined) {
  state.user = user;
  state.profileType = user.profileType ?? 'student';
  state.ledgerScope = 'personal';
  if (household === undefined) {
    try {
      household = (await api('/api/household')).household;
    } catch {
      household = null;
    }
  }
  state.household = household;
  clearWorkspaceData();
  query('#auth-screen').hidden = true;
  query('#workspace').hidden = false;
  query('#overview-month').value = state.month;
  query('#analysis-month').value = state.month;
  query('#records-month').value = state.month;
  const date = new Date();
  const hour = date.getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  query('#welcome-title').firstChild.textContent = `${greeting}，${user.name} `;
  query('#account-name').textContent = user.name;
  query('#account-email').textContent = user.email;
  query('#account-profile').textContent = profileLabels[state.profileType] ?? profileLabels.student;
  query('#account-avatar').textContent = [...user.name][0];
  query('#welcome-caption').textContent = state.profileType === 'student'
    ? '记录生活费、奖学金与校园日常，慢慢找到自己的节奏。'
    : state.profileType === 'employee'
      ? '把工资、通勤和日常账单安排得清清楚楚。'
      : '看见每位家人的付出，也看见家庭收支全貌。';
  query('#household-ledger-tab').hidden = !state.household;
  all('.ledger-tab').forEach((button) => {
    const selected = button.dataset.scope === state.ledgerScope;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  query('#welcome-date').textContent = `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 把今天过好`;
  query('#today-label').textContent = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  try {
    state.categories = await api(scoped('/api/categories'));
  } catch {
    state.categories = options;
  }
  await refreshOverview();
}

function clearWorkspaceData() {
  state.dashboard = null;
  state.records = [];
  state.overviewRequest += 1;
  state.recordRequest += 1;
  query('#stat-expenses').textContent = '—';
  query('#stat-income').textContent = '—';
  query('#stat-balance').textContent = '—';
  query('#stat-balance').classList.remove('amount-expense', 'amount-income');
  query('#stat-expense-count').textContent = '0 笔记录';
  query('#chart-month-total').textContent = '';
  query('#budget-spent-small').textContent = '¥0';
  query('#budget-progress-small').style.width = '0%';
  query('#budget-caption-small').textContent = '记录收入后显示收支比例';
  query('#nav-count').textContent = '0';
  for (const selector of ['#trend-chart', '#category-list', '#recent-list', '#daily-analysis-chart', '#month-comparison', '#analysis-category-list', '#largest-expense']) {
    query(selector).replaceChildren();
  }
  for (const selector of ['#analysis-change-value', '#analysis-average-value', '#analysis-saving-value', '#analysis-days-value']) {
    query(selector).textContent = '—';
  }
  for (const selector of ['#analysis-change-note', '#analysis-average-note', '#analysis-saving-note', '#analysis-days-note', '#analysis-day-caption']) {
    query(selector).textContent = '';
  }
  all('.insight-card').forEach((card) => { card.dataset.state = 'neutral'; });
  query('#records-body').replaceChildren();
  query('.records-table').hidden = true;
  query('#record-count').textContent = '共 0 条记录';
  query('#records-empty').hidden = false;
  query('#overview-view').hidden = false;
  query('#analysis-view').hidden = true;
  query('#transactions-view').hidden = true;
  query('#breadcrumb-current').textContent = '总览';
  all('.nav-link').forEach((button) => button.classList.toggle('is-active', button.dataset.view === 'overview'));
}

async function refreshOverview() {
  const requestId = ++state.overviewRequest;
  try {
    const [dashboard] = await Promise.all([
      api(scoped(`/api/dashboard?month=${encodeURIComponent(state.month)}`)),
      loadRecords(),
    ]);
    if (requestId !== state.overviewRequest) return;
    state.dashboard = dashboard;
    query('#stat-expenses').textContent = money(dashboard.summary.expenses);
    query('#stat-income').textContent = money(dashboard.summary.income);
    const balance = query('#stat-balance');
    balance.textContent = `${dashboard.summary.balance < 0 ? '−' : ''}${money(Math.abs(dashboard.summary.balance))}`;
    balance.classList.toggle('amount-expense', dashboard.summary.balance < 0);
    balance.classList.toggle('amount-income', dashboard.summary.balance > 0);
    query('#stat-expense-count').textContent = `${dashboard.summary.count} 笔记录`;
    renderTrend(dashboard);
    renderCategories(dashboard.categories.slice(0, 6), dashboard.summary.expenses);
    renderRecent(dashboard.recent);
    renderBudget(dashboard.summary.expenses, dashboard.summary.income);
    renderAnalytics(dashboard);
  } catch (error) {
    if (error.message === '请先登录。') showAuth();
    else toast(error.message, 'error');
  }
}

function svgElement(name, attrs = {}) {
  const element = document.createElementNS('http://www.w3.org/2000/svg', name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));
  return element;
}

function shortMoney(cents) {
  const amount = cents / 100;
  if (amount >= 100000) return `${(amount / 100000).toFixed(0)}万`;
  if (amount >= 10000) return `${(amount / 10000).toFixed(0)}k`;
  if (amount >= 1000) return `${(amount / 1000).toFixed(1)}k`;
  return amount.toFixed(0);
}

function renderTrend(dashboard) {
  const root = query('#trend-chart');
  const isDaily = state.trendMode === 'day';
  const points = isDaily
    ? dashboard.daily.map((item) => ({ ...item, label: `${item.day}日` }))
    : dashboard.trend;
  query('#trend-period-caption').textContent = isDaily ? '所选月份每日收支' : '最近六个月的收支变化';
  query('#chart-month-total').textContent = isDaily ? dashboard.month : '近 6 个月';
  root.replaceChildren();
  if (!points.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '添加一笔记录，开始看见你的收支走势。';
    root.append(empty);
    return;
  }
  const svg = svgElement('svg', { class: 'trend-svg', viewBox: '0 0 640 162', role: 'img', 'aria-label': isDaily ? `${dashboard.month}每日收入和支出趋势图` : '最近六个月的收入和支出趋势图' });
  const maximum = Math.max(1, ...points.flatMap((item) => [item.expenses, item.income])) * 1.12;
  const left = 44;
  const right = 628;
  const top = 12;
  const bottom = 114;
  for (let index = 0; index < 4; index += 1) {
    const y = top + (bottom - top) * index / 3;
    svg.append(svgElement('line', { x1: left, y1: y, x2: right, y2: y, class: 'trend-grid-line' }));
    const label = svgElement('text', { x: left - 7, y: y + 3, 'text-anchor': 'end', class: 'trend-axis-label' });
    label.textContent = shortMoney(maximum * (1 - index / 3));
    svg.append(label);
  }
  const x = (index) => points.length === 1 ? (left + right) / 2 : left + index * (right - left) / (points.length - 1);
  const y = (amount) => bottom - Number(amount) / maximum * (bottom - top);
  for (const [key, kind] of [['expenses', 'expense'], ['income', 'income']]) {
    const coordinates = points.map((item, index) => `${x(index)},${y(item[key])}`).join(' ');
    svg.append(svgElement('polyline', { points: coordinates, class: `trend-line-${kind}` }));
    points.forEach((item, index) => {
      const point = svgElement('circle', { cx: x(index), cy: y(item[key]), r: 3.2, class: `trend-point-${kind}` });
      const title = svgElement('title');
      title.textContent = `${item.label} ${key === 'expenses' ? '支出' : '收入'} ${money(item[key])}`;
      point.append(title);
      svg.append(point);
    });
  }
  const labelInterval = isDaily && points.length > 12 ? 5 : 1;
  points.forEach((item, index) => {
    if (index % labelInterval !== 0 && index !== points.length - 1) return;
    const label = svgElement('text', { x: x(index), y: 143, 'text-anchor': 'middle', class: 'trend-axis-label' });
    label.textContent = item.label;
    svg.append(label);
  });
  root.append(svg);
}

function renderCategories(items, total) {
  const root = query('#category-list');
  root.replaceChildren();
  query('#category-caption').textContent = items.length ? `本月主要分类 · ${items.length} 项` : '本月主要支出分类';
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '还没有支出。新的一天，慢慢记起。';
    root.append(empty);
    return;
  }
  for (const [index, item] of items.entries()) {
    const row = document.createElement('div');
    row.className = 'category-row';
    const symbol = document.createElement('span');
    symbol.className = 'category-symbol';
    symbol.append(icon(categoryIcons[item.category] || 'receipt'));
    const details = document.createElement('span');
    details.className = 'category-details';
    const heading = document.createElement('span');
    heading.className = 'category-name-line';
    const name = document.createElement('span');
    name.className = 'category-name';
    name.textContent = item.category;
    const amount = document.createElement('span');
    amount.className = 'category-amount';
    amount.textContent = money(item.amount);
    const track = document.createElement('span');
    track.className = 'category-bar-track';
    track.setAttribute('role', 'img');
    const bar = document.createElement('span');
    bar.className = 'category-bar';
    const percent = total ? item.amount / total * 100 : 0;
    track.setAttribute('aria-label', `${item.category}，占支出 ${percent.toFixed(1)}%`);
    bar.style.width = `${Math.min(100, Math.max(3, percent))}%`;
    track.append(bar);
    heading.append(name, amount);
    details.append(heading, track);
    const share = document.createElement('span');
    share.className = 'category-share';
    share.textContent = index === 0 ? '主要' : `${percent.toFixed(0)}%`;
    row.append(symbol, details, share);
    root.append(row);
  }
}

function renderBudget(expenses, income) {
  const spent = Number(expenses || 0);
  query('#budget-spent-small').textContent = money(spent);
  const percentage = income > 0 ? spent / income * 100 : 0;
  query('#budget-progress-small').style.width = `${Math.min(100, percentage)}%`;
  query('#budget-caption-small').textContent = income > 0 ? `支出占收入 ${percentage.toFixed(0)}%` : '记录收入后显示收支比例';
}

function renderAnalytics(dashboard) {
  const { summary, previousSummary, daily, categories, largestExpense } = dashboard;
  const expenseDays = daily.filter((item) => item.expenses > 0).length;
  const expenseDelta = summary.expenses - previousSummary.expenses;
  const changeValue = query('#analysis-change-value');
  const changeCard = query('[data-metric="change"]');

  changeCard.dataset.state = expenseDelta < 0 ? 'positive' : expenseDelta > 0 ? 'negative' : 'neutral';
  if (previousSummary.expenses > 0) {
    const percentage = Math.abs(expenseDelta / previousSummary.expenses * 100);
    changeValue.textContent = expenseDelta === 0 ? '持平' : `${expenseDelta < 0 ? '−' : '+'}${percentage.toFixed(1)}%`;
    query('#analysis-change-note').textContent = `${expenseDelta < 0 ? '少花' : expenseDelta > 0 ? '多花' : '与上月相同'} ${money(Math.abs(expenseDelta))}`;
  } else if (summary.expenses > 0) {
    changeValue.textContent = '新基准';
    query('#analysis-change-note').textContent = '上月无支出记录，暂不计算环比';
    changeCard.dataset.state = 'neutral';
  } else {
    changeValue.textContent = '—';
    query('#analysis-change-note').textContent = '本月和上月暂无支出';
    changeCard.dataset.state = 'neutral';
  }

  query('#analysis-average-value').textContent = expenseDays ? money(Math.round(summary.expenses / expenseDays)) : '—';
  query('#analysis-average-note').textContent = expenseDays ? `按 ${expenseDays} 个有支出的日期计算` : '暂无支出记录';
  const savingCard = query('[data-metric="saving"]');
  const savingValue = query('#analysis-saving-value');
  if (summary.income > 0) {
    const savingRate = summary.balance / summary.income * 100;
    savingValue.textContent = `${savingRate.toFixed(1)}%`;
    savingCard.dataset.state = savingRate < 0 ? 'negative' : 'positive';
    query('#analysis-saving-note').textContent = `${summary.balance < 0 ? '超出收入' : '结余'} ${money(Math.abs(summary.balance))}`;
  } else {
    savingValue.textContent = '—';
    savingCard.dataset.state = 'neutral';
    query('#analysis-saving-note').textContent = '记录收入后计算结余率';
  }
  query('#analysis-days-value').textContent = `${expenseDays} 天`;
  query('#analysis-days-note').textContent = `本月共 ${daily.length} 天`;
  query('#analysis-day-caption').textContent = `${daily.reduce((total, item) => total + item.count, 0)} 笔流水 · 支出 ${money(summary.expenses)}`;
  renderDailyAnalysis(daily);
  renderMonthComparison(summary, previousSummary, dashboard.previousMonth);
  renderAnalyticsCategories(categories, summary.expenses);
  renderLargestExpense(largestExpense);
}

function renderDailyAnalysis(days) {
  const root = query('#daily-analysis-chart');
  root.replaceChildren();
  if (!days.some((item) => item.expenses > 0)) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '这个月还没有支出记录。';
    root.append(empty);
    return;
  }

  const svg = svgElement('svg', { class: 'daily-analysis-svg', viewBox: '0 0 720 208', role: 'img', 'aria-label': '本月逐日支出柱状图' });
  const maximum = Math.max(1, ...days.map((item) => item.expenses));
  const left = 46;
  const right = 708;
  const top = 15;
  const bottom = 164;
  const step = (right - left) / days.length;
  const barWidth = Math.min(14, step * 0.58);

  for (let index = 0; index < 4; index += 1) {
    const y = top + (bottom - top) * index / 3;
    svg.append(svgElement('line', { x1: left, y1: y, x2: right, y2: y, class: 'trend-grid-line' }));
    const label = svgElement('text', { x: left - 8, y: y + 3, 'text-anchor': 'end', class: 'trend-axis-label' });
    label.textContent = shortMoney(maximum * (1 - index / 3));
    svg.append(label);
  }

  days.forEach((item, index) => {
    const center = left + step * (index + 0.5);
    const height = item.expenses ? Math.max(2, item.expenses / maximum * (bottom - top)) : 0;
    if (height > 0) {
      const bar = svgElement('rect', {
        x: center - barWidth / 2,
        y: bottom - height,
        width: barWidth,
        height,
        rx: 2,
        class: 'daily-analysis-bar',
      });
      const title = svgElement('title');
      title.textContent = `${item.date} 支出 ${money(item.expenses)} · ${item.count} 笔流水`;
      bar.append(title);
      svg.append(bar);
    }
    if (index % 5 === 0 || index === days.length - 1) {
      const label = svgElement('text', { x: center, y: 188, 'text-anchor': 'middle', class: 'trend-axis-label' });
      label.textContent = String(item.day);
      svg.append(label);
    }
  });

  root.append(svg);
}

function renderMonthComparison(current, previous, previousMonth) {
  const root = query('#month-comparison');
  root.replaceChildren();
  const months = [
    { key: 'expenses', label: '支出' },
    { key: 'income', label: '收入' },
  ];
  const maximum = Math.max(1, ...months.flatMap(({ key }) => [current[key], previous[key]]));
  const previousLabel = `${Number(previousMonth.slice(5))} 月`;

  for (const { key, label } of months) {
    const row = document.createElement('section');
    row.className = 'comparison-item';
    const heading = document.createElement('div');
    heading.className = 'comparison-item-heading';
    const title = document.createElement('strong');
    title.textContent = label;
    heading.append(title);
    row.append(heading);

    for (const [period, amount, className] of [
      ['本月', current[key], 'current-period'],
      [previousLabel, previous[key], 'previous-period'],
    ]) {
      const line = document.createElement('div');
      line.className = 'comparison-line';
      const periodLabel = document.createElement('span');
      periodLabel.className = 'comparison-period-label';
      periodLabel.textContent = period;
      const track = document.createElement('span');
      track.className = 'comparison-track';
      const bar = document.createElement('span');
      bar.className = `comparison-bar ${className}`;
      bar.style.width = `${Math.max(0, amount / maximum * 100)}%`;
      track.append(bar);
      const value = document.createElement('strong');
      value.className = 'comparison-value';
      value.textContent = money(amount);
      line.append(periodLabel, track, value);
      row.append(line);
    }
    root.append(row);
  }
}

function renderAnalyticsCategories(items, total) {
  const root = query('#analysis-category-list');
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '这个月还没有支出分类。';
    root.append(empty);
    return;
  }

  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'analysis-category-row';
    const heading = document.createElement('div');
    heading.className = 'analysis-category-heading';
    const label = document.createElement('span');
    label.textContent = item.category;
    const value = document.createElement('strong');
    value.textContent = money(item.amount);
    heading.append(label, value);
    const track = document.createElement('span');
    track.className = 'category-bar-track';
    const bar = document.createElement('span');
    bar.className = 'category-bar';
    const share = total ? item.amount / total * 100 : 0;
    bar.style.width = `${Math.min(100, share)}%`;
    track.append(bar);
    const detail = document.createElement('span');
    detail.className = 'analysis-category-foot';
    detail.textContent = `${share.toFixed(1)}% · ${item.count} 笔`;
    row.append(heading, track, detail);
    root.append(row);
  }
}

function renderLargestExpense(item) {
  const root = query('#largest-expense');
  root.replaceChildren();
  if (!item) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '这个月还没有支出记录。';
    root.append(empty);
    return;
  }

  const category = document.createElement('span');
  category.className = 'largest-expense-category';
  category.append(icon(categoryIcons[item.category] || 'receipt'));
  const name = document.createElement('strong');
  name.textContent = item.category;
  category.append(name);
  const amount = document.createElement('strong');
  amount.className = 'largest-expense-amount';
  amount.textContent = `−${money(item.amount)}`;
  const note = document.createElement('p');
  note.className = 'largest-expense-note';
  note.textContent = item.project || '未填写项目';
  const date = document.createElement('span');
  date.className = 'largest-expense-date';
  date.textContent = item.occurredOn;
  root.append(category, amount, note, date);
}

function formatDate(value) {
  const [year, month, day] = value.split('-').map(Number);
  return dayFormat.format(new Date(year, month - 1, day));
}

function transactionRow(item, recent = false) {
  const row = document.createElement('article');
  row.className = `transaction-row${recent ? ' recent-row' : ''}`;
  row.dataset.kind = item.kind;
  const symbol = document.createElement('span');
  symbol.className = 'transaction-icon';
  symbol.append(icon(categoryIcons[item.category] || 'receipt'));
  const main = document.createElement('span');
  main.className = 'transaction-main';
  const category = document.createElement('span');
  category.className = 'transaction-title';
  category.textContent = item.category;
  const kind = document.createElement('span');
  kind.className = 'transaction-detail';
  kind.textContent = item.kind === 'expense' ? '支出' : '收入';
  main.append(category, kind);
  const description = document.createElement('span');
  description.className = 'transaction-sub';
  const note = document.createElement('span');
  note.className = 'transaction-note';
  note.textContent = item.project || '未填写项目';
  const date = document.createElement('span');
  date.className = 'transaction-date';
  date.textContent = formatDate(item.occurredOn);
  description.append(note);
  if (item.content) {
    const content = document.createElement('span');
    content.className = 'transaction-note';
    content.textContent = `内容：${item.content}`;
    description.append(content);
  }
  description.append(date);
  const amount = document.createElement('span');
  amount.className = `transaction-amount ${item.kind === 'income' ? 'amount-income' : 'amount-expense'}`;
  amount.textContent = `${item.kind === 'income' ? '+' : '−'}${money(item.amount)}`;
  row.append(symbol, main, description, amount);
  return row;
}

function actionButton(action, item) {
  const button = document.createElement('button');
  button.className = 'icon-button row-action';
  button.type = 'button';
  button.dataset.action = action;
  button.dataset.id = item.id;
  button.title = action === 'edit' ? '修改记录' : '删除记录';
  button.setAttribute('aria-label', `${action === 'edit' ? '修改' : '删除'} ${item.category} 记录`);
  button.append(icon(action === 'edit' ? 'receipt' : 'trash'));
  return button;
}

function renderRecent(items) {
  const root = query('#recent-list');
  root.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '还没有当月记录，记下第一笔生活吧。';
    root.append(empty);
  } else {
    items.slice(0, 5).forEach((item) => root.append(transactionRow(item, true)));
  }
}

async function loadRecords() {
  const requestId = ++state.recordRequest;
  const params = new URLSearchParams({ month: state.month });
  params.set('scope', state.ledgerScope);
  if (state.filter !== 'all') params.set('kind', state.filter);
  if (state.search) params.set('q', state.search);
  const result = await api(`/api/transactions?${params}`);
  if (requestId !== state.recordRequest) return result;
  state.records = result.transactions;
  query('#record-count').textContent = `共 ${state.records.length} 条记录`;
  query('#nav-count').textContent = `${state.records.length}`;
  const body = query('#records-body');
  body.replaceChildren();
  for (const item of state.records) {
    const row = document.createElement('tr');
    row.dataset.kind = item.kind;
    const categoryCell = document.createElement('td');
    const label = document.createElement('span');
    label.className = 'record-category';
    const dot = document.createElement('span');
    dot.className = 'record-category-dot';
    const name = document.createElement('span');
    name.textContent = item.category;
    label.append(dot, name);
    categoryCell.append(label);
    const projectCell = document.createElement('td');
    const description = document.createElement('span');
    description.className = 'record-content';
    description.textContent = item.project || item.note || '—';
    projectCell.append(description);
    if (item.content) {
      const contentText = document.createElement('small');
      contentText.textContent = `内容：${item.content}`;
      projectCell.append(document.createElement('br'), contentText);
    }
    if (state.ledgerScope === 'household' && item.createdBy) {
      const attribution = document.createElement('small');
      attribution.textContent = `记录人：${item.createdBy}`;
      projectCell.append(document.createElement('br'), attribution);
    }
    projectCell.title = [item.project, item.content].filter(Boolean).join(' · ');
    const date = document.createElement('td');
    const dateLabel = document.createElement('span');
    dateLabel.className = 'record-date';
    dateLabel.textContent = item.occurredOn;
    date.append(dateLabel);
    const placeAndTime = [item.detailTime, item.location].filter(Boolean).join(' · ');
    if (placeAndTime) {
      const details = document.createElement('small');
      details.textContent = placeAndTime;
      date.append(document.createElement('br'), details);
    }
    const amountCell = document.createElement('td');
    const amount = document.createElement('span');
    amount.className = `record-amount ${item.kind === 'income' ? 'amount-income' : 'amount-expense'}`;
    amount.textContent = `${item.kind === 'income' ? '+' : '−'}${money(item.amount)}`;
    amountCell.append(amount);
    const actionCell = document.createElement('td');
    const actions = document.createElement('span');
    actions.className = 'table-actions';
    actions.append(actionButton('edit', item), actionButton('delete', item));
    actionCell.append(actions);
    row.append(categoryCell, projectCell, date, amountCell, actionCell);
    body.append(row);
  }
  query('.records-table').hidden = !state.records.length;
  query('#records-empty').hidden = Boolean(state.records.length);
}

function fillEntryCategories(kind, selected = '') {
  const select = query('[name="category"]');
  select.replaceChildren();
  const categories = [...(state.categories[kind] ?? options[kind])];
  if (selected && !categories.includes(selected)) categories.push(selected);
  categories.forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
  if (options[kind].includes(selected)) select.value = selected;
}

function setEntryKind(kind, selected = '') {
  state.kind = kind;
  all('.entry-type').forEach((button) => button.classList.toggle('is-active', button.dataset.kind === kind));
  fillEntryCategories(kind, selected);
}

function openEntry(item = null) {
  state.editing = item?.id ?? null;
  const form = query('#entry-form');
  form.reset();
  setEntryKind(item?.kind ?? 'expense', item?.category ?? '');
  query('#entry-title').textContent = item ? '修改这笔记录' : '记下这一笔';
  query('#entry-submit').lastChild.textContent = item ? '保存修改' : '保存记录';
  query('[name="amount"]').value = item ? (item.amount / 100).toFixed(2) : '';
  query('[name="category"]').value = item?.category ?? state.categories[state.kind][0];
  query('[name="occurredOn"]').value = item?.occurredOn ?? today();
  query('[name="detailTime"]').value = item?.detailTime ?? '';
  query('[name="location"]').value = item?.location ?? (!item && state.profileType === 'student' ? '学校' : '');
  query('[name="content"]').value = item?.content ?? '';
  query('[name="project"]').value = item?.project ?? item?.note ?? '';
  errorMessage(query('#entry-error'));
  query('#entry-dialog').showModal();
  window.setTimeout(() => query('[name="amount"]').focus(), 40);
}

async function saveEntry(event) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = query('#entry-submit');
  submit.disabled = true;
  errorMessage(query('#entry-error'));
  const payload = Object.fromEntries(new FormData(form));
  payload.kind = state.kind;
  payload.amount = Number(payload.amount);
  const editing = state.editing;
  try {
    await api(scoped(editing ? `/api/transactions/${editing}` : '/api/transactions'), {
      method: editing ? 'PUT' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    query('#entry-dialog').close();
    toast(editing ? '记录已经更新。' : state.kind === 'expense' ? '支出已记下，辛苦啦。' : '收入已记录，做得不错。');
    await refreshOverview();
  } catch (error) {
    errorMessage(query('#entry-error'), error.message);
  } finally {
    submit.disabled = false;
  }
}

async function exportCsv() {
  try {
    const response = await fetch(scoped('/api/export.csv'), { credentials: 'same-origin' });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || '导出失败。');
    }
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = url;
    link.download = `分寸账本-${today()}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('账本已导出，记得妥善保管。');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function importCsv(file) {
  try {
    if (file.size > 2 * 1024 * 1024) throw new Error('CSV 文件不能超过 2 MB。');
    const result = await api(scoped('/api/import.csv'), {
      method: 'POST',
      headers: { 'Content-Type': 'text/csv; charset=utf-8' },
      body: await file.text(),
    });
    toast(`成功导入 ${result.imported} 笔记录。`);
    await refreshOverview();
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    query('#import-file').value = '';
  }
}

function downloadTemplate() {
  const content = `\uFEFFdate,time,type,category,amount,location,project,content\r\n${today()},12:30:00,expense,餐饮,26.50,学校,"午饭，外卖",土豆牛肉盖浇饭\r\n${today()},18:00:00,income,兼职,500.00,,兼职结算,设计稿\r\n`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = '分寸记账导入模板.csv';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function refreshRecords() {
  try {
    await loadRecords();
  } catch (error) {
    if (error.message === '请先登录。') showAuth();
    else toast(error.message, 'error');
  }
}

async function switchView(view) {
  const views = {
    overview: { element: query('#overview-view'), label: '总览' },
    analysis: { element: query('#analysis-view'), label: '数据分析' },
    transactions: { element: query('#transactions-view'), label: '收支明细' },
    household: { element: query('#household-view'), label: '家庭组' },
  };
  if (!views[view]) return;
  Object.entries(views).forEach(([key, item]) => { item.element.hidden = key !== view; });
  query('#breadcrumb-current').textContent = views[view].label;
  all('.nav-link').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  if (view === 'transactions') await refreshRecords();
  if (view === 'analysis' && !state.dashboard) await refreshOverview();
  if (view === 'household') {
    try {
      await refreshHousehold();
    } catch (error) {
      toast(error.message, 'error');
    }
  }
}

function setMonth(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
  state.month = value;
  query('#overview-month').value = value;
  query('#analysis-month').value = value;
  query('#records-month').value = value;
  refreshOverview();
}

async function switchLedgerScope(scope) {
  if (scope === 'household' && !state.household) return toast('请先创建或加入家庭组。', 'error');
  if (!['personal', 'household'].includes(scope) || state.ledgerScope === scope) return;
  state.ledgerScope = scope;
  all('.ledger-tab').forEach((button) => {
    const selected = button.dataset.scope === scope;
    button.classList.toggle('is-active', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  try {
    state.categories = await api(scoped('/api/categories'));
  } catch (error) {
    toast(error.message, 'error');
  }
  await refreshOverview();
}

async function refreshHousehold() {
  const result = await api('/api/household');
  state.household = result.household;
  const household = state.household;
  query('#household-empty').hidden = Boolean(household);
  query('#household-detail').hidden = !household;
  query('#household-ledger-tab').hidden = !household;
  if (!household) {
    if (state.ledgerScope === 'household') await switchLedgerScope('personal');
    return;
  }
  query('#household-name').textContent = household.name;
  query('#household-member-count').textContent = `${household.members.length} 位成员`;
  query('#household-invite-code').textContent = household.inviteCode;
  query('#household-leave').hidden = household.role !== 'member';
  query('#household-refresh-invite').hidden = household.role !== 'owner';
  const members = query('#household-members');
  members.replaceChildren();
  for (const member of household.members) {
    const item = document.createElement('li');
    const avatar = document.createElement('span');
    avatar.className = 'avatar';
    avatar.textContent = [...member.name][0];
    const details = document.createElement('span');
    details.className = 'household-member-info';
    const name = document.createElement('strong');
    name.textContent = member.name;
    const profile = document.createElement('small');
    profile.textContent = profileLabels[member.profileType] ?? profileLabels.student;
    details.append(name, profile);
    const role = document.createElement('span');
    role.className = `member-role${member.role === 'owner' ? ' is-owner' : ''}`;
    role.textContent = member.role === 'owner' ? '创建者' : '成员';
    item.append(avatar, details, role);
    if (household.role === 'owner' && member.role === 'member') {
      const remove = document.createElement('button');
      remove.className = 'icon-button member-remove';
      remove.type = 'button';
      remove.dataset.userId = member.id;
      remove.title = `移除${member.name}`;
      remove.setAttribute('aria-label', `移除家庭成员 ${member.name}`);
      remove.append(icon('trash'));
      item.append(remove);
    }
    members.append(item);
  }
}

async function submitHouseholdForm(event, endpoint) {
  event.preventDefault();
  const form = event.currentTarget;
  if (!form.reportValidity()) return;
  const submit = query('button[type="submit"]', form);
  submit.disabled = true;
  try {
    const body = Object.fromEntries(new FormData(form));
    if (body.inviteCode) body.inviteCode = body.inviteCode.toUpperCase();
    await api(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    form.reset();
    await refreshHousehold();
    toast(endpoint.endsWith('/join') ? '已加入家庭组。' : '家庭组已创建。');
  } catch (error) {
    toast(error.message, 'error');
  } finally {
    submit.disabled = false;
  }
}

function bindEvents() {
  query('#auth-switch').addEventListener('click', () => setAuthMode(query('#auth-form').dataset.mode !== 'register'));
  query('#auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    const submit = query('#auth-submit');
    submit.disabled = true;
    errorMessage(query('#auth-error'));
    try {
      const endpoint = form.dataset.mode === 'register' ? '/api/auth/register' : '/api/auth/login';
      const result = await api(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      await enterWorkspace(result.user);
    } catch (error) {
      errorMessage(query('#auth-error'), error.message);
    } finally {
      submit.disabled = false;
    }
  });

  query('#demo-login').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const result = await api('/api/auth/demo', { method: 'POST' });
      await enterWorkspace(result.user);
    } catch (error) {
      errorMessage(query('#auth-error'), error.message);
    } finally {
      event.currentTarget.disabled = false;
    }
  });

  query('#logout-button').addEventListener('click', async () => {
    try {
      await api('/api/auth/logout', { method: 'POST' });
      showAuth();
      toast('已安全退出登录。');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  all('.ledger-tab').forEach((button) => button.addEventListener('click', () => switchLedgerScope(button.dataset.scope)));
  query('#household-create-form').addEventListener('submit', (event) => submitHouseholdForm(event, '/api/household'));
  query('#household-join-form').addEventListener('submit', (event) => submitHouseholdForm(event, '/api/household/join'));
  query('#household-join-form [name="inviteCode"]').addEventListener('input', (event) => {
    event.currentTarget.value = event.currentTarget.value.toUpperCase().replace(/[^A-F0-9]/g, '').slice(0, 10);
  });
  query('#household-copy-invite').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(state.household.inviteCode);
      toast('邀请码已复制。');
    } catch {
      toast('复制失败，请手动选中邀请码。', 'error');
    }
  });
  query('#household-refresh-invite').addEventListener('click', async () => {
    if (!window.confirm('更换后，当前邀请码会立即失效。确定继续吗？')) return;
    try {
      const result = await api('/api/household/invite-code', { method: 'POST' });
      state.household = result.household;
      await refreshHousehold();
      toast('邀请码已更换。');
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  query('#household-members').addEventListener('click', async (event) => {
    const button = event.target.closest('.member-remove');
    if (!button) return;
    const member = state.household.members.find((item) => String(item.id) === button.dataset.userId);
    if (!member || !window.confirm(`确定将 ${member.name} 移出家庭组吗？其记录仍保留在家庭账本中。`)) return;
    try {
      const result = await api(`/api/household/members/${encodeURIComponent(member.id)}`, { method: 'DELETE' });
      state.household = result.household;
      await refreshHousehold();
      toast(`${member.name} 已移出家庭组。`);
    } catch (error) {
      toast(error.message, 'error');
    }
  });
  query('#household-leave').addEventListener('click', async () => {
    if (!window.confirm(`确定退出“${state.household.name}”吗？家庭账本记录会保留给其他成员。`)) return;
    try {
      await api('/api/household/leave', { method: 'DELETE' });
      if (state.ledgerScope === 'household') await switchLedgerScope('personal');
      await refreshHousehold();
      toast('已退出家庭组。');
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  query('#quick-add').addEventListener('click', () => openEntry());
  query('[data-empty-add]').addEventListener('click', () => openEntry());
  all('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => query('#entry-dialog').close()));
  all('.entry-type').forEach((button) => button.addEventListener('click', () => setEntryKind(button.dataset.kind)));
  all('[data-trend-mode]').forEach((button) => button.addEventListener('click', () => {
    state.trendMode = button.dataset.trendMode;
    all('[data-trend-mode]').forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('is-active', selected);
      tab.setAttribute('aria-pressed', String(selected));
    });
    if (state.dashboard) renderTrend(state.dashboard);
  }));
  query('#entry-form').addEventListener('submit', saveEntry);
  query('#entry-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  all('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  query('#overview-month').addEventListener('change', (event) => setMonth(event.currentTarget.value));
  query('#analysis-month').addEventListener('change', (event) => setMonth(event.currentTarget.value));
  query('#records-month').addEventListener('change', (event) => setMonth(event.currentTarget.value));
  all('.filter-tab').forEach((button) => button.addEventListener('click', () => {
    state.filter = button.dataset.filter;
    all('.filter-tab').forEach((tab) => tab.classList.toggle('is-selected', tab === button));
    refreshRecords();
  }));

  let searchTimer;
  query('#record-search').addEventListener('input', (event) => {
    state.search = event.currentTarget.value.trim();
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(refreshRecords, 180);
  });
  query('#records-body').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;
    const item = state.records.find((record) => String(record.id) === button.dataset.id);
    if (!item) return toast('这条记录已更新，请刷新后重试。', 'error');
    if (button.dataset.action === 'edit') return openEntry(item);
    if (!window.confirm(`确定删除 ${item.category} · ${money(item.amount)} 这笔记录吗？此操作无法撤销。`)) return;
    try {
      await api(scoped(`/api/transactions/${item.id}`), { method: 'DELETE' });
      toast('记录已删除。');
      await refreshOverview();
    } catch (error) {
      toast(error.message, 'error');
    }
  });

  query('#export-button').addEventListener('click', exportCsv);
  query('#import-button').addEventListener('click', () => query('#import-file').click());
  query('#import-file').addEventListener('change', (event) => {
    const [file] = event.currentTarget.files;
    if (file) importCsv(file);
  });
  query('#template-download').addEventListener('click', downloadTemplate);
  window.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f' && !query('#transactions-view').hidden) {
      event.preventDefault();
      query('#record-search').focus();
    }
  });
}

async function start() {
  bindEvents();
  try {
    const config = await api('/api/config');
    state.demo = Boolean(config.demoMode);
    try {
      const session = await api('/api/session');
      await enterWorkspace(session.user, session.household);
    } catch {
      showAuth();
    }
  } catch {
    showAuth();
    errorMessage(query('#auth-error'), '暂时无法连接记账服务，请确认服务器正在运行。');
  }
}

start();
