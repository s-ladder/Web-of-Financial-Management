import express from 'express';
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { allCategories, categoriesForProfile, createDatabase, profileTypes } from './database.js';

const scrypt = promisify(scryptCallback);
const currentFile = fileURLToPath(import.meta.url);
const projectRoot = path.dirname(path.dirname(currentFile));
const publicDirectory = path.join(projectRoot, 'public');
const sessionCookie = 'fencun_session';
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const passwordPolicy = /^(?=.*[A-Za-z])(?=.*\d).{8,72}$/;

function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

function publicUser(row) {
  return { id: Number(row.id), name: row.name, email: row.email, profileType: row.profileType ?? 'student' };
}

function cookieValue(header, name) {
  for (const part of (header ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim();
  }
  return '';
}

function monthKey(value) {
  if (typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return value;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function monthRange(month) {
  const [year, index] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, index - 1, 1));
  const previous = new Date(Date.UTC(year, index - 6, 1));
  return {
    first: `${previous.getUTCFullYear()}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}`,
    last: month,
    labels: Array.from({ length: 6 }, (_, offset) => {
      const date = new Date(first);
      date.setUTCMonth(date.getUTCMonth() - (5 - offset));
      const key = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
      return { key, label: `${date.getUTCMonth() + 1}月` };
    }),
  };
}

function safeTransaction(input) {
  if (!input || !['expense', 'income'].includes(input.kind)) return { error: '请选择收入或支出。' };
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 100000000) return { error: '金额需大于 0 且不超过 1 亿元。' };
  const amountCents = Math.round(amount * 100);
  if (amountCents < 1) return { error: '金额至少为 0.01 元。' };

  const categoryList = allCategories()[input.kind];
  if (!categoryList.includes(input.category)) return { error: '请选择有效的分类。' };
  if (typeof input.occurredOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.occurredOn)) {
    return { error: '请选择有效日期。' };
  }
  const parsedDate = new Date(`${input.occurredOn}T00:00:00Z`);
  if (Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== input.occurredOn) {
    return { error: '请选择有效日期。' };
  }
  const projectValue = Object.hasOwn(input, 'project') ? input.project : input.note;
  const project = typeof projectValue === 'string' ? projectValue.trim() : '';
  const detailTime = typeof input.detailTime === 'string' ? input.detailTime.trim() : '';
  const location = typeof input.location === 'string' ? input.location.trim() : '';
  const content = typeof input.content === 'string' ? input.content.trim() : '';
  if (project.length > 120) return { error: '项目不能超过 120 个字。' };
  if (detailTime && !/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(detailTime)) {
    return { error: '具体时间请使用 24 小时制时分秒。' };
  }
  if (location.length > 80) return { error: '地点不能超过 80 个字。' };
  if (content.length > 120) return { error: '内容不能超过 120 个字。' };

  return {
    value: {
      kind: input.kind,
      amount: amountCents,
      category: input.category,
      project,
      note: project,
      occurredOn: input.occurredOn,
      detailTime: detailTime && detailTime.length === 5 ? `${detailTime}:00` : detailTime,
      location,
      content,
    },
  };
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  if (quoted) throw new Error('CSV 中有未闭合的引号。');
  row.push(field);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

function amountFromCsv(value) {
  const cleaned = value.trim().replace(/[￥¥,\s]/g, '');
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(cleaned)) return NaN;
  return Number(cleaned);
}

export async function createApp({
  databasePath = process.env.DATABASE_PATH || path.join(projectRoot, 'data', 'ledger.sqlite'),
  databaseUrl = process.env.DATABASE_URL,
  demoMode = process.env.NODE_ENV !== 'production' && process.env.DISABLE_DEMO !== 'true',
} = {}) {
  const app = express();
  const db = await createDatabase(databasePath, { seedDemo: demoMode, databaseUrl });
  const loginAttempts = new Map();
  const authLimiterWindow = 15 * 60 * 1000;

  app.locals.database = db;
  app.disable('x-powered-by');
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    });
    next();
  });
  app.use(express.json({ limit: '64kb' }));

  async function setSession(res, userId) {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = Date.now() + sessionDuration;
    const tokenHash = hashSessionToken(token);
    await db.run('DELETE FROM sessions WHERE expires_at <= ?', Date.now());
    await db.run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', tokenHash, userId, expiresAt);
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${sessionCookie}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${sessionDuration / 1000}${secure}`);
  }

  async function clearSession(req, res) {
    const token = cookieValue(req.headers.cookie, sessionCookie);
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', hashSessionToken(token));
    res.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
  }

  async function requireUser(req, res, next) {
    const token = cookieValue(req.headers.cookie, sessionCookie);
    const session = await db.get('SELECT user_id AS "userId", expires_at AS "expiresAt" FROM sessions WHERE token_hash = ?', hashSessionToken(token));
    if (!session || session.expiresAt <= Date.now()) {
      if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', hashSessionToken(token));
      return res.status(401).json({ error: '请先登录。' });
    }
    const row = await db.get('SELECT id, name, email, profile_type AS "profileType" FROM users WHERE id = ?', session.userId);
    if (!row) {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', hashSessionToken(token));
      return res.status(401).json({ error: '登录已失效，请重新登录。' });
    }
    req.user = publicUser(row);
    return next();
  }

  async function requireLedger(req, res, next) {
    if (req.query.scope === 'household') {
      const membership = await db.get('SELECT household_id AS "householdId" FROM household_members WHERE user_id = ?', req.user.id);
      if (!membership) return res.status(404).json({ error: '你还没有加入家庭组。' });
      req.ledger = { condition: 'household_id = ?', value: Number(membership.householdId), householdId: Number(membership.householdId) };
    } else {
      req.ledger = { condition: 'user_id = ? AND household_id IS NULL', value: req.user.id, householdId: null };
    }
    return next();
  }

  async function householdDetails(userId) {
    const household = await db.get(`
      SELECT h.id, h.name, h.invite_code AS "inviteCode", hm.role
      FROM household_members hm JOIN households h ON h.id = hm.household_id
      WHERE hm.user_id = ?
    `, userId);
    if (!household) return null;
    const members = await db.all(`
      SELECT u.id, u.name, u.profile_type AS "profileType", hm.role, hm.joined_at AS "joinedAt"
      FROM household_members hm JOIN users u ON u.id = hm.user_id
      WHERE hm.household_id = ? ORDER BY CASE hm.role WHEN 'owner' THEN 0 ELSE 1 END, hm.joined_at
    `, household.id);
    return {
      ...household,
      id: Number(household.id),
      members: members.map((member) => ({ ...member, id: Number(member.id) })),
    };
  }

  function rateLimitAuth(req, res, next) {
    const ip = req.ip || 'unknown';
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.until > Date.now() && attempt.count >= 10) {
      return res.status(429).json({ error: '尝试次数过多，请 15 分钟后再试。' });
    }
    if (!attempt || attempt.until <= Date.now()) loginAttempts.set(ip, { count: 0, until: Date.now() + authLimiterWindow });
    return next();
  }

  function recordFailedAuth(req) {
    const ip = req.ip || 'unknown';
    const attempt = loginAttempts.get(ip) ?? { count: 0, until: Date.now() + authLimiterWindow };
    attempt.count += 1;
    loginAttempts.set(ip, attempt);
  }

  app.get('/api/config', (_req, res) => res.json({ demoMode }));

  app.get('/api/session', async (req, res) => {
    const token = cookieValue(req.headers.cookie, sessionCookie);
    const session = await db.get('SELECT user_id AS "userId", expires_at AS "expiresAt" FROM sessions WHERE token_hash = ?', hashSessionToken(token));
    if (!session || session.expiresAt <= Date.now()) return res.status(401).json({ error: '请先登录。' });
    const user = await db.get('SELECT id, name, email, profile_type AS "profileType" FROM users WHERE id = ?', session.userId);
    if (!user) return res.status(401).json({ error: '请先登录。' });
    return res.json({ user: publicUser(user), household: await householdDetails(Number(user.id)), demoMode });
  });

  app.post('/api/auth/register', rateLimitAuth, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const profileType = typeof req.body?.profileType === 'string' && profileTypes[req.body.profileType] ? req.body.profileType : '';
    if (name.length < 2 || name.length > 32) return res.status(400).json({ error: '昵称需为 2 到 32 个字。' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return res.status(400).json({ error: '请输入有效邮箱。' });
    if (!passwordPolicy.test(password)) return res.status(400).json({ error: '密码需为 8 到 72 位，并包含字母和数字。' });
    if (!profileType) return res.status(400).json({ error: '请选择适合你的记账身份。' });

    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)).toString('hex');
    try {
      const result = await db.run('INSERT INTO users (name, email, password_hash, password_salt, profile_type) VALUES (?, ?, ?, ?, ?)',
        name, email, passwordHash, salt, profileType);
      const user = { id: Number(result.lastInsertRowid), name, email, profileType };
      await setSession(res, user.id);
      loginAttempts.delete(req.ip || 'unknown');
      return res.status(201).json({ user });
    } catch (error) {
      if (error.code === '23505' || error.message.includes('UNIQUE constraint failed: users.email')) {
        return res.status(409).json({ error: '该邮箱已注册。' });
      }
      return res.status(500).json({ error: '暂时无法创建账户，请稍后再试。' });
    }
  });

  app.post('/api/auth/login', rateLimitAuth, async (req, res) => {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const row = await db.get('SELECT id, name, email, profile_type AS "profileType", password_hash, password_salt FROM users WHERE email = ?', email);
    const salt = row?.password_salt ?? '0'.repeat(32);
    const storedHash = row?.password_hash ?? '0'.repeat(128);
    const attemptedHash = (await scrypt(password.slice(0, 72), salt, 64)).toString('hex');
    const valid = timingSafeEqual(Buffer.from(attemptedHash, 'hex'), Buffer.from(storedHash, 'hex'));
    if (!row || !valid) {
      recordFailedAuth(req);
      return res.status(401).json({ error: '邮箱或密码不正确。' });
    }
    loginAttempts.delete(req.ip || 'unknown');
    await setSession(res, row.id);
    return res.json({ user: publicUser(row) });
  });

  app.post('/api/auth/demo', async (req, res) => {
    if (!demoMode) return res.status(404).json({ error: '找不到演示账户。' });
    const user = await db.get('SELECT id, name, email, profile_type AS "profileType" FROM users WHERE email = ?', 'demo@fencun.local');
    if (!user) return res.status(404).json({ error: '找不到演示账户。' });
    await setSession(res, user.id);
    return res.json({ user: publicUser(user) });
  });

  app.post('/api/auth/logout', async (req, res) => {
    await clearSession(req, res);
    return res.status(204).end();
  });

  app.get('/api/categories', requireUser, requireLedger, (req, res) => res.json(categoriesForProfile(req.ledger.householdId ? 'family' : req.user.profileType)));

  app.get('/api/household', requireUser, async (req, res) => res.json({ household: await householdDetails(req.user.id) }));

  app.post('/api/household', requireUser, async (req, res) => {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
    if (name.length < 2 || name.length > 40) return res.status(400).json({ error: '家庭组名称需为 2 到 40 个字。' });
    if (await db.get('SELECT household_id FROM household_members WHERE user_id = ?', req.user.id)) {
      return res.status(409).json({ error: '你已经属于一个家庭组。' });
    }
    try {
      await db.transaction(async (transaction) => {
        const inviteCode = randomBytes(5).toString('hex').toUpperCase();
        const created = await transaction.run(
          'INSERT INTO households (name, invite_code, created_by) VALUES (?, ?, ?)', name, inviteCode, req.user.id,
        );
        const householdId = Number(created.lastInsertRowid);
        await transaction.run(
          'INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)', householdId, req.user.id, 'owner',
        );
      });
      return res.status(201).json({ household: await householdDetails(req.user.id) });
    } catch {
      return res.status(500).json({ error: '家庭组暂时无法创建，请稍后再试。' });
    }
  });

  app.post('/api/household/join', requireUser, async (req, res) => {
    const inviteCode = typeof req.body?.inviteCode === 'string' ? req.body.inviteCode.trim().toUpperCase() : '';
    if (!/^[A-F0-9]{10}$/.test(inviteCode)) return res.status(400).json({ error: '请输入 10 位家庭邀请码。' });
    const existing = await db.get('SELECT household_id FROM household_members WHERE user_id = ?', req.user.id);
    if (existing) return res.status(409).json({ error: '你已经属于一个家庭组。' });
    const household = await db.get('SELECT id FROM households WHERE invite_code = ?', inviteCode);
    if (!household) return res.status(404).json({ error: '邀请码无效，请向家庭组创建者确认。' });
    try {
      await db.transaction(async (transaction) => {
        await transaction.run(
          'INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)', Number(household.id), req.user.id, 'member',
        );
      });
      return res.status(200).json({ household: await householdDetails(req.user.id) });
    } catch {
      return res.status(409).json({ error: '加入家庭组失败，请刷新页面后重试。' });
    }
  });

  app.delete('/api/household/leave', requireUser, async (req, res) => {
    const membership = await db.get('SELECT household_id AS "householdId", role FROM household_members WHERE user_id = ?', req.user.id);
    if (!membership) return res.status(404).json({ error: '你当前没有加入家庭组。' });
    if (membership.role === 'owner') return res.status(409).json({ error: '创建者不能直接退出，以免家庭账本失去管理员。' });
    await db.run('DELETE FROM household_members WHERE household_id = ? AND user_id = ?', membership.householdId, req.user.id);
    return res.status(204).end();
  });

  app.post('/api/household/invite-code', requireUser, async (req, res) => {
    const membership = await db.get('SELECT household_id AS "householdId", role FROM household_members WHERE user_id = ?', req.user.id);
    if (!membership) return res.status(404).json({ error: '你当前没有加入家庭组。' });
    if (membership.role !== 'owner') return res.status(403).json({ error: '只有家庭组创建者可以更换邀请码。' });
    const inviteCode = randomBytes(5).toString('hex').toUpperCase();
    await db.run('UPDATE households SET invite_code = ? WHERE id = ?', inviteCode, membership.householdId);
    return res.json({ household: await householdDetails(req.user.id) });
  });

  app.delete('/api/household/members/:userId', requireUser, async (req, res) => {
    const membership = await db.get('SELECT household_id AS "householdId", role FROM household_members WHERE user_id = ?', req.user.id);
    if (!membership) return res.status(404).json({ error: '你当前没有加入家庭组。' });
    if (membership.role !== 'owner') return res.status(403).json({ error: '只有家庭组创建者可以移除成员。' });
    const memberId = Number(req.params.userId);
    if (!Number.isSafeInteger(memberId) || memberId < 1 || memberId === req.user.id) {
      return res.status(400).json({ error: '请选择有效的家庭成员。' });
    }
    const removed = await db.run(
      "DELETE FROM household_members WHERE household_id = ? AND user_id = ? AND role = 'member'",
      membership.householdId, memberId,
    );
    if (!removed.changes) return res.status(404).json({ error: '找不到可移除的家庭成员。' });
    return res.json({ household: await householdDetails(req.user.id) });
  });

  app.get('/api/dashboard', requireUser, requireLedger, async (req, res) => {
    const { condition: ledgerCondition, value: ledgerValue } = req.ledger;
    const month = monthKey(req.query.month);
    const [year, monthNumber] = month.split('-').map(Number);
    const previousDate = new Date(Date.UTC(year, monthNumber - 2, 1));
    const nextDate = new Date(Date.UTC(year, monthNumber, 1));
    const previousMonth = `${previousDate.getUTCFullYear()}-${String(previousDate.getUTCMonth() + 1).padStart(2, '0')}`;
    const monthStart = `${month}-01`;
    const nextMonthStart = `${nextDate.getUTCFullYear()}-${String(nextDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const daysInMonth = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
    const summary = await db.get(`
      SELECT
        COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0) AS expenses,
        COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END), 0) AS income,
        COUNT(*) AS count
      FROM transactions WHERE ${ledgerCondition} AND substr(occurred_on, 1, 7) = ?
    `, ledgerValue, month);
    const previousSummary = await db.get(`
      SELECT
        COALESCE(SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END), 0) AS expenses,
        COALESCE(SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END), 0) AS income
      FROM transactions WHERE ${ledgerCondition} AND occurred_on >= ? AND occurred_on < ?
    `, ledgerValue, `${previousMonth}-01`, monthStart);
    const categories = await db.all(`
      SELECT category, SUM(amount) AS amount, COUNT(*) AS count
      FROM transactions WHERE ${ledgerCondition} AND kind = 'expense' AND substr(occurred_on, 1, 7) = ?
      GROUP BY category ORDER BY amount DESC
    `, ledgerValue, month);
    const dailyRows = await db.all(`
      SELECT occurred_on AS date,
        SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END) AS expenses,
        SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END) AS income,
        COUNT(*) AS count
      FROM transactions
      WHERE ${ledgerCondition} AND occurred_on >= ? AND occurred_on < ?
      GROUP BY occurred_on ORDER BY occurred_on
    `, ledgerValue, monthStart, nextMonthStart);
    const dailyByDate = new Map(dailyRows.map((row) => [row.date, row]));
    const largestExpense = await db.get(`
      SELECT id, category, COALESCE(NULLIF(project, ''), note, '') AS project,
        COALESCE(NULLIF(project, ''), note, '') AS note, amount, occurred_on AS "occurredOn"
      FROM transactions
      WHERE ${ledgerCondition} AND kind = 'expense' AND occurred_on >= ? AND occurred_on < ?
      ORDER BY amount DESC, occurred_on DESC, id DESC LIMIT 1
    `, ledgerValue, monthStart, nextMonthStart);
    const range = monthRange(month);
    const trendRows = await db.all(`
      SELECT substr(occurred_on, 1, 7) AS month,
        SUM(CASE WHEN kind = 'expense' THEN amount ELSE 0 END) AS expenses,
        SUM(CASE WHEN kind = 'income' THEN amount ELSE 0 END) AS income
      FROM transactions
      WHERE ${ledgerCondition} AND substr(occurred_on, 1, 7) BETWEEN ? AND ?
      GROUP BY substr(occurred_on, 1, 7)
    `, ledgerValue, range.first, range.last);
    const trendByMonth = new Map(trendRows.map((row) => [row.month, row]));
    const recent = await db.all(`
      SELECT id, kind, amount, category, COALESCE(NULLIF(project, ''), note, '') AS project,
        COALESCE(NULLIF(project, ''), note, '') AS note, occurred_on AS "occurredOn",
        (SELECT name FROM users WHERE users.id = transactions.user_id) AS "createdBy"
      FROM transactions WHERE ${ledgerCondition} AND substr(occurred_on, 1, 7) = ?
      ORDER BY occurred_on DESC, id DESC LIMIT 7
    `, ledgerValue, month);

    return res.json({
      month,
      summary: {
        expenses: Number(summary.expenses),
        income: Number(summary.income),
        balance: Number(summary.income) - Number(summary.expenses),
        count: Number(summary.count),
      },
      previousMonth,
      previousSummary: {
        expenses: Number(previousSummary.expenses),
        income: Number(previousSummary.income),
        balance: Number(previousSummary.income) - Number(previousSummary.expenses),
      },
      categories: categories.map((row) => ({ ...row, amount: Number(row.amount), count: Number(row.count) })),
      daily: Array.from({ length: daysInMonth }, (_item, index) => {
        const date = `${month}-${String(index + 1).padStart(2, '0')}`;
        const row = dailyByDate.get(date);
        return {
          date,
          day: index + 1,
          expenses: Number(row?.expenses ?? 0),
          income: Number(row?.income ?? 0),
          count: Number(row?.count ?? 0),
        };
      }),
      largestExpense: largestExpense ? {
        ...largestExpense,
        id: Number(largestExpense.id),
        amount: Number(largestExpense.amount),
      } : null,
      trend: range.labels.map(({ key, label }) => {
        const row = trendByMonth.get(key);
        return { month: key, label, expenses: Number(row?.expenses ?? 0), income: Number(row?.income ?? 0) };
      }),
      recent: recent.map((row) => ({ ...row, id: Number(row.id), amount: Number(row.amount) })),
    });
  });

  app.get('/api/transactions', requireUser, requireLedger, async (req, res) => {
    const month = monthKey(req.query.month);
    const kind = ['expense', 'income'].includes(req.query.kind) ? req.query.kind : null;
    const query = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const conditions = [req.ledger.condition, "substr(occurred_on, 1, 7) = ?"];
    const params = [req.ledger.value, month];
    if (kind) {
      conditions.push('kind = ?');
      params.push(kind);
    }
    if (query) {
      conditions.push('(lower(category) LIKE lower(?) OR lower(project) LIKE lower(?) OR lower(detail_time) LIKE lower(?) OR lower(location) LIKE lower(?) OR lower(content) LIKE lower(?))');
      params.push(...Array.from({ length: 5 }, () => `%${query}%`));
    }
    const rows = await db.all(`
      SELECT id, kind, amount, category, project, project AS note, occurred_on AS "occurredOn",
        detail_time AS "detailTime", location, content,
        (SELECT name FROM users WHERE users.id = transactions.user_id) AS "createdBy"
      FROM transactions WHERE ${conditions.join(' AND ')}
      ORDER BY occurred_on DESC, id DESC LIMIT 1000
    `, ...params);
    return res.json({ month, transactions: rows.map((row) => ({
      ...row,
      id: Number(row.id),
      amount: Number(row.amount),
      detailTime: row.detailTime ?? '',
      location: row.location ?? '',
      content: row.content ?? '',
      project: row.project ?? row.note ?? '',
    })) });
  });

  app.post('/api/transactions', requireUser, requireLedger, async (req, res) => {
    const validated = safeTransaction(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const item = validated.value;
    const input = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.hasOwn(input, 'location') && req.user.profileType === 'student') item.location = '学校';
    const result = await db.run(`
      INSERT INTO transactions (user_id, household_id, kind, amount, category, project, note, occurred_on, detail_time, location, content)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, req.user.id, req.ledger.householdId, item.kind, item.amount, item.category, item.project, item.note, item.occurredOn,
    item.detailTime, item.location, item.content);
    return res.status(201).json({ id: Number(result.lastInsertRowid), ...item, createdBy: req.user.name });
  });

  app.put('/api/transactions/:id', requireUser, requireLedger, async (req, res) => {
    const transactionId = Number(req.params.id);
    if (!Number.isSafeInteger(transactionId) || transactionId < 1) return res.status(404).json({ error: '找不到这笔记录。' });
    const validated = safeTransaction(req.body);
    if (validated.error) return res.status(400).json({ error: validated.error });
    const item = validated.value;
    const existing = await db.get(`
      SELECT detail_time AS "detailTime", location, content
      FROM transactions WHERE id = ? AND ${req.ledger.condition}
    `, transactionId, req.ledger.value);
    if (!existing) return res.status(404).json({ error: '找不到这笔记录。' });
    const input = req.body && typeof req.body === 'object' ? req.body : {};
    if (!Object.hasOwn(input, 'detailTime')) item.detailTime = existing.detailTime ?? '';
    if (!Object.hasOwn(input, 'location')) item.location = existing.location ?? '';
    if (!Object.hasOwn(input, 'content')) item.content = existing.content ?? '';
    const result = await db.run(`
      UPDATE transactions SET kind = ?, amount = ?, category = ?, project = ?, note = ?, occurred_on = ?, detail_time = ?, location = ?, content = ?
      WHERE id = ? AND ${req.ledger.condition}
    `, item.kind, item.amount, item.category, item.project, item.note, item.occurredOn, item.detailTime, item.location, item.content,
    transactionId, req.ledger.value);
    if (result.changes === 0) return res.status(404).json({ error: '找不到这笔记录。' });
    return res.json({ id: transactionId, ...item });
  });

  app.delete('/api/transactions/:id', requireUser, requireLedger, async (req, res) => {
    const transactionId = Number(req.params.id);
    if (!Number.isSafeInteger(transactionId) || transactionId < 1) return res.status(404).json({ error: '找不到这笔记录。' });
    const result = await db.run(`DELETE FROM transactions WHERE id = ? AND ${req.ledger.condition}`, transactionId, req.ledger.value);
    if (result.changes === 0) return res.status(404).json({ error: '找不到这笔记录。' });
    return res.status(204).end();
  });

  app.get('/api/export.csv', requireUser, requireLedger, async (req, res) => {
    const rows = await db.all(`
      SELECT occurred_on AS "date", kind, category, amount, project, detail_time AS "detailTime", location, content
      FROM transactions WHERE ${req.ledger.condition} ORDER BY occurred_on DESC, id DESC
    `, req.ledger.value);
    const escapeCell = (value) => {
      const text = String(value);
      const spreadsheetSafe = /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text;
      return `"${spreadsheetSafe.replaceAll('"', '""')}"`;
    };
    const lines = [
      ['date', 'time', 'type', 'category', 'amount', 'location', 'project', 'content'].join(','),
      ...rows.map((row) => [
        row.date,
        row.detailTime ?? '',
        row.kind,
        row.category,
        (Number(row.amount) / 100).toFixed(2),
        row.location ?? '',
        row.project ?? '',
        row.content ?? '',
      ].map(escapeCell).join(',')),
    ];
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="fencun-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return res.send(`\uFEFF${lines.join('\r\n')}`);
  });

  app.post('/api/import.csv', requireUser, requireLedger, express.text({ type: ['text/csv', 'text/plain'], limit: '2mb' }), async (req, res) => {
    if (typeof req.body !== 'string' || req.body.trim() === '') return res.status(400).json({ error: '请选择非空 CSV 文件。' });
    let rows;
    try {
      rows = parseCsv(req.body.replace(/^\uFEFF/, ''));
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
    if (rows.length < 2) return res.status(400).json({ error: 'CSV 至少需要一行表头和一条记录。' });
    if (rows.length > 1001) return res.status(400).json({ error: '单次最多导入 1,000 条记录。' });

    const heading = rows[0].map((value) => value.trim().toLowerCase());
    const locate = (...names) => heading.findIndex((value) => names.includes(value));
    const dateIndex = locate('date', '日期');
    const typeIndex = locate('type', 'kind', '类型');
    const categoryIndex = locate('category', '分类');
    const amountIndex = locate('amount', '金额');
    const timeIndex = locate('time', 'detail_time', '具体时间', '时间');
    const locationIndex = locate('location', '地点');
    const contentIndex = locate('content', 'item', '具体内容', '内容');
    const projectIndex = locate('project', '项目');
    const legacyNoteIndex = locate('note', 'description', '备注', '说明');
    const projectValueIndex = projectIndex >= 0 ? projectIndex : legacyNoteIndex;
    if ([dateIndex, typeIndex, categoryIndex, amountIndex].some((index) => index < 0)) {
      return res.status(400).json({ error: '表头需包含 date、type、category、amount；time、location、project、content 均可选。' });
    }

    const validatedRows = [];
    for (let index = 1; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.length !== heading.length) return res.status(400).json({ error: `第 ${index + 1} 行列数不匹配。` });
      const rawKind = row[typeIndex].trim().toLowerCase();
      const kind = ['expense', '支出'].includes(rawKind) ? 'expense' : ['income', '收入'].includes(rawKind) ? 'income' : '';
      const validated = safeTransaction({
        kind,
        amount: amountFromCsv(row[amountIndex]),
        category: row[categoryIndex].trim(),
        project: projectValueIndex < 0 ? '' : row[projectValueIndex],
        occurredOn: row[dateIndex].trim(),
        detailTime: timeIndex < 0 ? '' : row[timeIndex],
        location: locationIndex < 0 ? '' : row[locationIndex],
        content: contentIndex < 0 ? '' : row[contentIndex],
      });
      if (validated.error) return res.status(400).json({ error: `第 ${index + 1} 行：${validated.error}` });
      if (locationIndex < 0 && req.user.profileType === 'student') validated.value.location = '学校';
      validatedRows.push(validated.value);
    }

    try {
      await db.transaction(async (transaction) => {
        for (const item of validatedRows) {
          await transaction.run(`
            INSERT INTO transactions (user_id, household_id, kind, amount, category, project, note, occurred_on, detail_time, location, content)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, req.user.id, req.ledger.householdId, item.kind, item.amount, item.category, item.project, item.note, item.occurredOn,
          item.detailTime, item.location, item.content);
        }
      });
      return res.status(201).json({ imported: validatedRows.length });
    } catch {
      return res.status(500).json({ error: '导入失败，数据未写入。' });
    }
  });

  app.use('/api', (_req, res) => res.status(404).json({ error: '接口不存在。' }));
  app.use(express.static(publicDirectory, {
    index: 'index.html',
    dotfiles: 'deny',
    maxAge: '1h',
    setHeaders(res, filePath) {
      if (/\.(?:html|css|js)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    const status = error.status ?? 500;
    return res.status(status).json({ error: status === 413 ? '请求内容过大。' : '服务器暂时无法处理请求。' });
  });

  return app;
}
