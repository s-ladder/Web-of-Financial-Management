import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createApp } from '../server/app.js';

async function launch(t, options = {}) {
  const app = await createApp({ databasePath: ':memory:', demoMode: false, ...options });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  let cookie = '';
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await new Promise((resolve) => server.close(resolve));
    app.locals.database.close();
  };
  t.after(close);
  return {
    cookie: () => cookie,
    setCookie(value) { cookie = value; },
    close,
    async request(url, { cookie: suppliedCookie, body, ...init } = {}) {
      const headers = new Headers(init.headers);
      if ((typeof body === 'object' && body !== null) && !headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json');
        body = JSON.stringify(body);
      }
      const sessionCookie = suppliedCookie ?? cookie;
      if (sessionCookie) headers.set('Cookie', sessionCookie);
      const response = await fetch(`http://127.0.0.1:${server.address().port}${url}`, { ...init, headers, body });
      const setCookie = response.headers.get('set-cookie');
      if (setCookie?.startsWith('fencun_session=')) cookie = setCookie.split(';', 1)[0];
      const contentType = response.headers.get('content-type') || '';
      const payload = contentType.includes('application/json')
        ? await response.json()
        : url === '/api/export.csv' ? Buffer.from(await response.arrayBuffer()) : await response.text();
      return { response, payload };
    },
  };
}

function localDate() {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

async function register(server, name, email, profileType = 'student') {
  const result = await server.request('/api/auth/register', {
    method: 'POST',
    body: { name, email, password: 'Fencun2026!', profileType },
  });
  assert.equal(result.response.status, 201);
  return server.cookie();
}

test('authentication is required and user records stay isolated', async (t) => {
  const server = await launch(t);
  assert.equal((await server.request('/api/transactions')).response.status, 401);

  const alice = await register(server, '小林', 'alice@example.com');
  const created = await server.request('/api/transactions', {
    method: 'POST',
    body: { kind: 'expense', amount: 18.45, category: '餐饮', project: '午饭，外卖', content: '土豆牛肉盖浇饭', occurredOn: localDate() },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.payload.location, '学校');
  assert.equal(created.payload.detailTime, '');
  assert.equal(created.payload.project, '午饭，外卖');
  assert.equal(created.payload.content, '土豆牛肉盖浇饭');
  const itemId = created.payload.id;

  const bob = await register(server, '小周', 'bob@example.com');
  const ownRecords = await server.request(`/api/transactions?month=${localDate().slice(0, 7)}`);
  assert.deepEqual(ownRecords.payload.transactions, []);
  assert.equal((await server.request(`/api/transactions/${itemId}`, { method: 'DELETE' })).response.status, 404);
  assert.equal((await server.request(`/api/transactions/${itemId}`, {
    method: 'PUT',
    cookie: bob,
    body: { kind: 'income', amount: 20, category: '兼职', note: '不能修改他人记录', occurredOn: localDate() },
  })).response.status, 404);

  const aliceDashboard = await server.request(`/api/dashboard?month=${localDate().slice(0, 7)}`, { cookie: alice });
  assert.equal(aliceDashboard.payload.summary.expenses, 1845);
  assert.equal(aliceDashboard.payload.summary.income, 0);
  assert.equal(aliceDashboard.payload.categories[0].category, '餐饮');
  const bobDashboard = await server.request(`/api/dashboard?month=${localDate().slice(0, 7)}`, { cookie: bob });
  assert.equal(bobDashboard.payload.summary.count, 0);

  const updated = await server.request(`/api/transactions/${itemId}`, {
    method: 'PUT',
    cookie: alice,
    body: { kind: 'income', amount: 20.5, category: '兼职', note: '设计稿', occurredOn: localDate() },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.payload.location, '学校');
  assert.equal(updated.payload.project, '设计稿');
  assert.equal(updated.payload.content, '土豆牛肉盖浇饭');
  const updatedDashboard = await server.request(`/api/dashboard?month=${localDate().slice(0, 7)}`, { cookie: alice });
  assert.equal(updatedDashboard.payload.summary.expenses, 0);
  assert.equal(updatedDashboard.payload.summary.income, 2050);
  assert.equal((await server.request(`/api/transactions/${itemId}`, { method: 'DELETE', cookie: alice })).response.status, 204);
});

test('dashboard analytics compare months and aggregate daily data per user', async (t) => {
  const server = await launch(t);
  const alice = await register(server, '小林', 'analytics@example.com');
  const entries = [
    { kind: 'expense', amount: 12.5, category: '餐饮', note: '上月午餐', occurredOn: '2026-03-22' },
    { kind: 'expense', amount: 30, category: '餐饮', note: '午餐', occurredOn: '2026-04-02' },
    { kind: 'income', amount: 200, category: '兼职', note: '结算', occurredOn: '2026-04-02' },
    { kind: 'expense', amount: 85, category: '购物', note: '书包', occurredOn: '2026-04-18' },
    { kind: 'income', amount: 100, category: '奖金', note: '奖学金', occurredOn: '2026-04-30' },
  ];
  for (const entry of entries) {
    const result = await server.request('/api/transactions', { method: 'POST', cookie: alice, body: entry });
    assert.equal(result.response.status, 201);
  }

  const bob = await register(server, '小周', 'other-analytics@example.com');
  await server.request('/api/transactions', {
    method: 'POST',
    cookie: bob,
    body: { kind: 'expense', amount: 2000, category: '居家', occurredOn: '2026-04-18' },
  });

  const result = await server.request('/api/dashboard?month=2026-04', { cookie: alice });
  assert.equal(result.response.status, 200);
  assert.equal(result.payload.summary.expenses, 11_500);
  assert.equal(result.payload.summary.income, 30_000);
  assert.equal(result.payload.previousMonth, '2026-03');
  assert.deepEqual(result.payload.previousSummary, { expenses: 1_250, income: 0, balance: -1_250 });
  assert.equal(result.payload.daily.length, 30);
  assert.deepEqual(result.payload.daily[1], {
    date: '2026-04-02', day: 2, expenses: 3_000, income: 20_000, count: 2,
  });
  assert.deepEqual(result.payload.largestExpense, {
    id: result.payload.largestExpense.id,
    category: '购物',
    project: '书包',
    note: '书包',
    amount: 8_500,
    occurredOn: '2026-04-18',
  });
});

test('CSV import remains backward compatible and round-trips all optional details', async (t) => {
  const server = await launch(t);
  await register(server, '小林', 'csv@example.com');
  const date = localDate();
  const invalidCsv = [
    'date,type,category,amount,note',
    `${date},expense,餐饮,1.25,这一笔不能写入`,
    '2026-02-30,expense,交通,4.00,日期无效',
  ].join('\r\n');
  const rejected = await server.request('/api/import.csv', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    body: invalidCsv,
  });
  assert.equal(rejected.response.status, 400);
  assert.equal((await server.request(`/api/transactions?month=${date.slice(0, 7)}`)).payload.transactions.length, 0);

  const csv = `\uFEFFdate,type,category,amount,note\r\n${date},expense,餐饮,18.45,"午餐, 加豆浆"\r\n`;
  const imported = await server.request('/api/import.csv', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    body: csv,
  });
  assert.equal(imported.response.status, 201);
  assert.equal(imported.payload.imported, 1);
  const detailedImport = await server.request('/api/import.csv', {
    method: 'POST',
    headers: { 'Content-Type': 'text/csv; charset=utf-8' },
    body: `date,time,type,category,amount,location,project,content\r\n${date},12:30:45,expense,学习,9.50,图书馆,学习资料,参考书\r\n${date},18:00:00,income,兼职,500.00,,兼职结算,设计稿结算`,
  });
  assert.equal(detailedImport.response.status, 201);
  assert.equal(detailedImport.payload.imported, 2);
  const records = await server.request(`/api/transactions?month=${date.slice(0, 7)}`);
  assert.equal(records.payload.transactions[0].location, '');
  assert.equal(records.payload.transactions[0].content, '设计稿结算');
  assert.equal(records.payload.transactions[0].project, '兼职结算');
  assert.equal(records.payload.transactions[1].detailTime, '12:30:45');
  assert.equal(records.payload.transactions[1].location, '图书馆');
  assert.equal(records.payload.transactions[1].content, '参考书');
  assert.equal(records.payload.transactions[1].project, '学习资料');
  assert.equal(records.payload.transactions[2].location, '学校');
  assert.equal(records.payload.transactions[2].content, '');
  assert.equal(records.payload.transactions[2].project, '午餐, 加豆浆');
  const searchByLocation = await server.request(
    `/api/transactions?month=${date.slice(0, 7)}&q=${encodeURIComponent('图书馆')}`,
  );
  assert.equal(searchByLocation.payload.transactions.length, 1);
  assert.equal(searchByLocation.payload.transactions[0].content, '参考书');
  const searchByProject = await server.request(
    `/api/transactions?month=${date.slice(0, 7)}&q=${encodeURIComponent('学习资料')}`,
  );
  assert.equal(searchByProject.payload.transactions.length, 1);
  const formulaNote = await server.request('/api/transactions', {
    method: 'POST',
    body: { kind: 'expense', amount: 1, category: '其他', content: '=cmd()', note: '=1+1', occurredOn: date },
  });
  assert.equal(formulaNote.response.status, 201);

  const exported = await server.request('/api/export.csv');
  assert.deepEqual(exported.payload.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.match(exported.payload.toString('utf8'), /^\uFEFFdate,time,type,category,amount,location,project,content/);
  assert.match(exported.payload.toString('utf8'), /"18\.45","学校","午餐, 加豆浆",""/);
  assert.match(exported.payload.toString('utf8'), /"12:30:45","expense","学习","9\.50","图书馆","学习资料","参考书"/);
  assert.match(exported.payload.toString('utf8'), /"1\.00","学校","'=1\+1","'=cmd\(\)"/);
});

test('amounts, dates, duplicate emails, and failed login are validated', async (t) => {
  const server = await launch(t);
  assert.equal((await server.request('/api/auth/register', {
    method: 'POST',
    body: { name: 'x', email: 'bad@example.com', password: 'Fencun2026!' },
  })).response.status, 400);

  await register(server, '小林', 'same@example.com');
  assert.equal((await server.request('/api/auth/register', {
    method: 'POST',
    body: { name: '小周', email: 'SAME@example.com', password: 'Fencun2026!', profileType: 'student' },
  })).response.status, 409);
  assert.equal((await server.request('/api/auth/login', {
    method: 'POST',
    body: { email: 'same@example.com', password: 'incorrect' },
  })).response.status, 401);
  assert.equal((await server.request('/api/transactions', {
    method: 'POST',
    body: { kind: 'expense', amount: 0, category: '餐饮', occurredOn: '2026-02-30' },
  })).response.status, 400);
  assert.equal((await server.request('/api/transactions', {
    method: 'POST',
    body: { kind: 'expense', amount: 1, category: '未知分类', occurredOn: localDate() },
  })).response.status, 400);
  assert.equal((await server.request('/api/transactions', {
    method: 'POST',
    body: { kind: 'expense', amount: 1, category: '餐饮', occurredOn: localDate(), detailTime: '24:00:00' },
  })).response.status, 400);
});

test('sessions survive an application restart without storing bearer tokens', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fencun-test-'));
  const databasePath = path.join(directory, 'ledger.sqlite');
  let first;
  let second;
  t.after(async () => {
    await Promise.all([first?.close(), second?.close()]);
    rmSync(directory, { recursive: true, force: true });
  });
  first = await launch(t, { databasePath });
  await register(first, '小林', 'persist@example.com');
  const cookie = first.cookie();
  assert.match(cookie, /^fencun_session=[A-Za-z0-9_-]+$/);
  second = await launch(t, { databasePath });
  const session = await second.request('/api/session', { cookie });
  assert.equal(session.response.status, 200);
  assert.equal(session.payload.user.email, 'persist@example.com');
});

test('production mode never exposes the demo account', async (t) => {
  const server = await launch(t, { demoMode: false });
  assert.deepEqual((await server.request('/api/config')).payload, { demoMode: false });
  assert.equal((await server.request('/api/auth/demo', { method: 'POST' })).response.status, 404);
});

test('HTML and frontend assets are revalidated instead of kept stale', async (t) => {
  const server = await launch(t);
  for (const asset of ['/', '/styles.css', '/app.js']) {
    const result = await server.request(asset);
    assert.equal(result.response.status, 200);
    assert.equal(result.response.headers.get('cache-control'), 'no-cache, must-revalidate');
  }
  const image = await server.request('/images/welcome-landscape.jpg');
  assert.equal(image.response.status, 200);
  assert.match(image.response.headers.get('cache-control'), /max-age=3600/);
});

test('identity profiles provide relevant categories and persist in sessions', async (t) => {
  const server = await launch(t);
  const student = await register(server, '小林', 'student@example.com');
  const studentSession = await server.request('/api/session', { cookie: student });
  assert.equal(studentSession.payload.user.profileType, 'student');
  const studentCategories = await server.request('/api/categories', { cookie: student });
  assert.ok(studentCategories.payload.income.includes('生活费'));
  assert.ok(studentCategories.payload.expense.includes('学习'));

  const employee = await register(server, '小周', 'employee@example.com', 'employee');
  const employeeCategories = await server.request('/api/categories', { cookie: employee });
  assert.ok(employeeCategories.payload.income.includes('工资'));
  assert.ok(employeeCategories.payload.expense.includes('居家'));
  assert.ok(!employeeCategories.payload.income.includes('生活费'));

  const invalidProfile = await server.request('/api/auth/register', {
    method: 'POST',
    body: { name: '小郑', email: 'invalid-profile@example.com', password: 'Fencun2026!', profileType: 'admin' },
  });
  assert.equal(invalidProfile.response.status, 400);
});

test('household membership shares summaries without mixing personal ledgers', async (t) => {
  const server = await launch(t);
  const owner = await register(server, '小林', 'household-owner@example.com', 'family');
  const outsider = await register(server, '小郑', 'household-outsider@example.com');
  const stranger = await register(server, '小吴', 'household-stranger@example.com');

  const created = await server.request('/api/household', {
    method: 'POST', cookie: owner, body: { name: '林家账本' },
  });
  assert.equal(created.response.status, 201);
  assert.match(created.payload.household.inviteCode, /^[A-F0-9]{10}$/);
  assert.equal(created.payload.household.members.length, 1);

  const joined = await server.request('/api/household/join', {
    method: 'POST', cookie: outsider, body: { inviteCode: created.payload.household.inviteCode.toLowerCase() },
  });
  assert.equal(joined.response.status, 200);
  assert.equal(joined.payload.household.members.length, 2);
  assert.equal(joined.payload.household.members[0].role, 'owner');

  const currentDate = localDate();
  await server.request('/api/transactions', {
    method: 'POST', cookie: owner,
    body: { kind: 'expense', amount: 300, category: '餐饮', note: '仅个人午餐', occurredOn: currentDate },
  });
  await server.request(`/api/transactions?scope=household`, {
    method: 'POST', cookie: owner,
    body: { kind: 'expense', amount: 1200, category: '居家', note: '家庭采购', occurredOn: currentDate },
  });
  await server.request('/api/transactions?scope=household', {
    method: 'POST', cookie: outsider,
    body: { kind: 'income', amount: 8000, category: '工资', note: '家庭收入', occurredOn: currentDate },
  });

  const familyDashboard = await server.request(`/api/dashboard?scope=household&month=${currentDate.slice(0, 7)}`, { cookie: outsider });
  assert.equal(familyDashboard.payload.summary.expenses, 120_000);
  assert.equal(familyDashboard.payload.summary.income, 800_000);
  assert.equal(familyDashboard.payload.summary.count, 2);
  const personalDashboard = await server.request(`/api/dashboard?month=${currentDate.slice(0, 7)}`, { cookie: owner });
  assert.equal(personalDashboard.payload.summary.expenses, 30_000);
  assert.equal(personalDashboard.payload.summary.income, 0);

  const sharedRecords = await server.request(`/api/transactions?scope=household&month=${currentDate.slice(0, 7)}`, { cookie: outsider });
  assert.equal(sharedRecords.payload.transactions.length, 2);
  assert.ok(sharedRecords.payload.transactions.some((item) => item.createdBy === '小林'));
  assert.ok(sharedRecords.payload.transactions.some((item) => item.createdBy === '小郑'));

  const denied = await server.request(`/api/dashboard?scope=household&month=${currentDate.slice(0, 7)}`, { cookie: stranger });
  assert.equal(denied.response.status, 404);
  assert.equal((await server.request('/api/household/leave', { method: 'DELETE', cookie: outsider })).response.status, 204);
  assert.equal((await server.request('/api/transactions?scope=household', { cookie: outsider })).response.status, 404);

  const rotated = await server.request('/api/household/invite-code', { method: 'POST', cookie: owner });
  assert.notEqual(rotated.payload.household.inviteCode, created.payload.household.inviteCode);
  assert.equal((await server.request('/api/household/join', {
    method: 'POST', cookie: stranger, body: { inviteCode: created.payload.household.inviteCode },
  })).response.status, 404);
  const strangerJoined = await server.request('/api/household/join', {
    method: 'POST', cookie: stranger, body: { inviteCode: rotated.payload.household.inviteCode },
  });
  assert.equal(strangerJoined.response.status, 200);
  const strangerId = strangerJoined.payload.household.members.find((member) => member.name === '小吴').id;
  assert.equal((await server.request(`/api/household/members/${strangerId}`, { method: 'DELETE', cookie: owner })).response.status, 200);
  assert.equal((await server.request('/api/transactions?scope=household', { cookie: stranger })).response.status, 404);
});

test('existing SQLite ledgers gain profile and household fields without losing records', async (t) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fencun-migration-'));
  const databasePath = path.join(directory, 'ledger.sqlite');
  const legacy = new DatabaseSync(databasePath);
  legacy.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      occurred_on TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO users (id, name, email, password_hash, password_salt)
      VALUES (1, '旧账户', 'legacy@example.com', 'hash', 'salt');
    INSERT INTO transactions (id, user_id, kind, amount, category, note, occurred_on)
      VALUES (1, 1, 'expense', 1250, '餐饮', '保留的旧记录', '2026-11-14');
  `);
  legacy.close();
  const app = await createApp({ databasePath, demoMode: false });
  t.after(async () => {
    app.locals.database.close();
    rmSync(directory, { recursive: true, force: true });
  });

  const user = await app.locals.database.get('SELECT profile_type AS "profileType" FROM users WHERE id = ?', 1);
  const transaction = await app.locals.database.get(
    'SELECT household_id AS "householdId", note FROM transactions WHERE id = ?', 1,
  );
  assert.equal(user.profileType, 'student');
  assert.equal(transaction.householdId, null);
  assert.equal(transaction.note, '保留的旧记录');
  const addedFields = await app.locals.database.get(
    'SELECT project, detail_time AS "detailTime", location, content FROM transactions WHERE id = ?', 1,
  );
  assert.deepEqual({ ...addedFields }, { project: '保留的旧记录', detailTime: null, location: null, content: null });
});
