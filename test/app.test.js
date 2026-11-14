import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

async function register(server, name, email) {
  const result = await server.request('/api/auth/register', {
    method: 'POST',
    body: { name, email, password: 'Fencun2026!' },
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
    body: { kind: 'expense', amount: 18.45, category: '餐饮', note: '校园午饭', occurredOn: localDate() },
  });
  assert.equal(created.response.status, 201);
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
  const updatedDashboard = await server.request(`/api/dashboard?month=${localDate().slice(0, 7)}`, { cookie: alice });
  assert.equal(updatedDashboard.payload.summary.expenses, 0);
  assert.equal(updatedDashboard.payload.summary.income, 2050);
  assert.equal((await server.request(`/api/transactions/${itemId}`, { method: 'DELETE', cookie: alice })).response.status, 204);
});

test('CSV import validates every row before writing and export round-trips notes', async (t) => {
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
  const formulaNote = await server.request('/api/transactions', {
    method: 'POST',
    body: { kind: 'expense', amount: 1, category: '其他', note: '=1+1', occurredOn: date },
  });
  assert.equal(formulaNote.response.status, 201);

  const exported = await server.request('/api/export.csv');
  assert.deepEqual(exported.payload.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.match(exported.payload.toString('utf8'), /^\uFEFFdate,type,category,amount,note/);
  assert.match(exported.payload.toString('utf8'), /"18\.45","午餐, 加豆浆"/);
  assert.match(exported.payload.toString('utf8'), /"1\.00","'=1\+1"/);
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
    body: { name: '小周', email: 'SAME@example.com', password: 'Fencun2026!' },
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
