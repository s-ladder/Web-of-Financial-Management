const query = (selector, parent = document) => parent.querySelector(selector);
const all = (selector) => [...document.querySelectorAll(selector)];
const currency = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: '2-digit', day: '2-digit', weekday: 'short' });
const options = { expense: ['餐饮', '交通', '日用', '居家', '购物', '娱乐', '医疗', '学习', '其他'], income: ['工资', '兼职', '奖金', '退款', '其他'] };
const categoryIcons = { 餐饮: 'coffee', 交通: 'train', 日用: 'bag', 居家: 'home', 购物: 'bag', 娱乐: 'film', 医疗: 'pill', 学习: 'book', 工资: 'wallet', 兼职: 'user', 奖金: 'gift', 退款: 'arrow-left', 其他: 'receipt' };
const state = { user: null, demo: false, month: currentMonth(), filter: 'all', search: '', records: [], editing: null, kind: 'expense', recordRequest: 0, overviewRequest: 0 };

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
  query('#workspace').hidden = true;
  query('#auth-screen').hidden = false;
  query('#demo-divider').hidden = !state.demo;
  query('#demo-login').hidden = !state.demo;
  setAuthMode(false);
}

function enterWorkspace(user) {
  state.user = user;
  query('#auth-screen').hidden = true;
  query('#workspace').hidden = false;
  query('#overview-month').value = state.month;
  query('#records-month').value = state.month;
  const date = new Date();
  const hour = date.getHours();
  const greeting = hour < 6 ? '夜深了' : hour < 12 ? '早上好' : hour < 18 ? '下午好' : '晚上好';
  query('#welcome-title').firstChild.textContent = `${greeting}，${user.name} `;
  query('#account-name').textContent = user.name;
  query('#account-email').textContent = user.email;
  query('#account-avatar').textContent = [...user.name][0];
  query('#welcome-date').textContent = `${date.getFullYear()} 年 ${date.getMonth() + 1} 月 ${date.getDate()} 日 · 把今天过好`;
  query('#today-label').textContent = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  return refreshOverview();
}

async function refreshOverview() {
  const requestId = ++state.overviewRequest;
  try {
    const [dashboard] = await Promise.all([
      api(`/api/dashboard?month=${encodeURIComponent(state.month)}`),
      loadRecords(),
    ]);
    if (requestId !== state.overviewRequest) return;
    query('#stat-expenses').textContent = money(dashboard.summary.expenses);
    query('#stat-income').textContent = money(dashboard.summary.income);
    const balance = query('#stat-balance');
    balance.textContent = `${dashboard.summary.balance < 0 ? '−' : ''}${money(Math.abs(dashboard.summary.balance))}`;
    balance.classList.toggle('amount-expense', dashboard.summary.balance < 0);
    balance.classList.toggle('amount-income', dashboard.summary.balance > 0);
    query('#stat-expense-count').textContent = `${dashboard.summary.count} 笔记录`;
    query('#chart-month-total').textContent = `${dashboard.month.slice(0, 4)} 年`;
    renderTrend(dashboard.trend);
    renderCategories(dashboard.categories, dashboard.summary.expenses);
    renderRecent(dashboard.recent);
    renderBudget(dashboard.summary.expenses, dashboard.summary.income);
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

function renderTrend(months) {
  const root = query('#trend-chart');
  root.replaceChildren();
  if (!months.length) {
    const empty = document.createElement('p');
    empty.className = 'chart-empty';
    empty.textContent = '添加一笔记录，开始看见你的收支走势。';
    root.append(empty);
    return;
  }
  const svg = svgElement('svg', { class: 'trend-svg', viewBox: '0 0 640 162', role: 'img', 'aria-label': '最近六个月的收入和支出趋势图' });
  const maximum = Math.max(1, ...months.flatMap((item) => [item.expenses, item.income])) * 1.12;
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
  const x = (index) => months.length === 1 ? (left + right) / 2 : left + index * (right - left) / (months.length - 1);
  const y = (amount) => bottom - Number(amount) / maximum * (bottom - top);
  for (const [key, kind] of [['expenses', 'expense'], ['income', 'income']]) {
    const points = months.map((item, index) => `${x(index)},${y(item[key])}`).join(' ');
    svg.append(svgElement('polyline', { points, class: `trend-line-${kind}` }));
    months.forEach((item, index) => {
      const point = svgElement('circle', { cx: x(index), cy: y(item[key]), r: 3.2, class: `trend-point-${kind}` });
      const title = svgElement('title');
      title.textContent = `${item.label} ${key === 'expenses' ? '支出' : '收入'} ${money(item[key])}`;
      point.append(title);
      svg.append(point);
    });
  }
  months.forEach((item, index) => {
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
  note.textContent = item.note || '—';
  const date = document.createElement('span');
  date.className = 'transaction-date';
  date.textContent = formatDate(item.occurredOn);
  description.append(note, date);
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
    const note = document.createElement('td');
    note.textContent = item.note || '—';
    note.title = item.note || '';
    const date = document.createElement('td');
    date.textContent = item.occurredOn;
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
    row.append(categoryCell, note, date, amountCell, actionCell);
    body.append(row);
  }
  query('.records-table').hidden = !state.records.length;
  query('#records-empty').hidden = Boolean(state.records.length);
}

function fillEntryCategories(kind, selected = '') {
  const select = query('[name="category"]');
  select.replaceChildren();
  options[kind].forEach((value) => {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    select.append(option);
  });
  if (options[kind].includes(selected)) select.value = selected;
}

function setEntryKind(kind) {
  state.kind = kind;
  all('.entry-type').forEach((button) => button.classList.toggle('is-active', button.dataset.kind === kind));
  fillEntryCategories(kind);
}

function openEntry(item = null) {
  state.editing = item?.id ?? null;
  const form = query('#entry-form');
  form.reset();
  setEntryKind(item?.kind ?? 'expense');
  query('#entry-title').textContent = item ? '修改这笔记录' : '记下这一笔';
  query('#entry-submit').lastChild.textContent = item ? '保存修改' : '保存记录';
  query('[name="amount"]').value = item ? (item.amount / 100).toFixed(2) : '';
  query('[name="category"]').value = item?.category ?? options[state.kind][0];
  query('[name="occurredOn"]').value = item?.occurredOn ?? today();
  query('[name="note"]').value = item?.note ?? '';
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
    await api(editing ? `/api/transactions/${editing}` : '/api/transactions', {
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
    const response = await fetch('/api/export.csv', { credentials: 'same-origin' });
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
    const result = await api('/api/import.csv', {
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
  const content = `\uFEFFdate,type,category,amount,note\r\n${today()},expense,餐饮,26.50,学校食堂午餐\r\n${today()},income,兼职,500.00,设计稿结算\r\n`;
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
  const showingRecords = view === 'transactions';
  query('#overview-view').hidden = showingRecords;
  query('#transactions-view').hidden = !showingRecords;
  query('#breadcrumb-current').textContent = showingRecords ? '收支明细' : '总览';
  all('.nav-link').forEach((button) => button.classList.toggle('is-active', button.dataset.view === view));
  if (showingRecords) await refreshRecords();
}

function setMonth(value) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return;
  state.month = value;
  query('#overview-month').value = value;
  query('#records-month').value = value;
  refreshOverview();
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

  query('#quick-add').addEventListener('click', () => openEntry());
  query('[data-empty-add]').addEventListener('click', () => openEntry());
  all('[data-close-dialog]').forEach((button) => button.addEventListener('click', () => query('#entry-dialog').close()));
  all('.entry-type').forEach((button) => button.addEventListener('click', () => setEntryKind(button.dataset.kind)));
  query('#entry-form').addEventListener('submit', saveEntry);
  query('#entry-dialog').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) event.currentTarget.close();
  });

  all('[data-view]').forEach((button) => button.addEventListener('click', () => switchView(button.dataset.view)));
  query('#overview-month').addEventListener('change', (event) => setMonth(event.currentTarget.value));
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
      await api(`/api/transactions/${item.id}`, { method: 'DELETE' });
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
      await enterWorkspace(session.user);
    } catch {
      showAuth();
    }
  } catch {
    showAuth();
    errorMessage(query('#auth-error'), '暂时无法连接记账服务，请确认服务器正在运行。');
  }
}

start();
