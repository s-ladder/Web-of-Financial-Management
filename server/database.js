import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export const expenseCategories = ['餐饮', '交通', '日用', '居家', '购物', '娱乐', '医疗', '学习', '其他'];
export const incomeCategories = ['工资', '兼职', '奖金', '退款', '其他'];

const demoEmail = 'demo@fencun.local';
const demoPassword = 'Fencun2026!';

function localDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const { Pool } = pg;

function createSqliteAdapter(connection) {
  const adapter = {
    get: async (statement, ...params) => connection.prepare(statement).get(...params),
    all: async (statement, ...params) => connection.prepare(statement).all(...params),
    run: async (statement, ...params) => {
      const result = connection.prepare(statement).run(...params);
      return { changes: Number(result.changes), lastInsertRowid: Number(result.lastInsertRowid) };
    },
    exec: async (statement) => connection.exec(statement),
    close: () => connection.close(),
    transaction: async (callback) => {
      connection.exec('BEGIN');
      try {
        const result = await callback(adapter);
        connection.exec('COMMIT');
        return result;
      } catch (error) {
        connection.exec('ROLLBACK');
        throw error;
      }
    },
  };
  return adapter;
}

function createPostgresAdapter(query, close, connect) {
  const numbered = (statement) => statement.replace(/\?/g, (_match, offset, original) => {
    const previous = original.slice(0, offset);
    return `$${(previous.match(/\?/g) || []).length + 1}`;
  });
  const adapter = {
    get: async (statement, ...params) => (await query(numbered(statement), params)).rows[0],
    all: async (statement, ...params) => (await query(numbered(statement), params)).rows,
    run: async (statement, ...params) => {
      const returnsId = /^\s*INSERT\s+INTO\s+(?:users|transactions)\b/i.test(statement) && !/\bRETURNING\b/i.test(statement);
      const sql = numbered(returnsId ? `${statement} RETURNING id` : statement);
      const result = await query(sql, params);
      return {
        changes: Number(result.rowCount || 0),
        lastInsertRowid: result.rows?.[0]?.id === undefined ? undefined : Number(result.rows[0].id),
      };
    },
    exec: async (statement) => query(statement, []),
    close,
    transaction: async (callback) => {
      const client = await connect();
      const transactionQuery = (statement, params) => client.query(statement, params);
      await client.query('BEGIN');
      try {
        const result = await callback(createPostgresAdapter(transactionQuery, async () => {}, connect));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
  return adapter;
}

const postgresSchema = `
  CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    occurred_on TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, occurred_on DESC, id DESC);
  CREATE INDEX IF NOT EXISTS transactions_user_category ON transactions(user_id, category);
`;

export async function createDatabase(databasePath, { seedDemo = false, databaseUrl = process.env.DATABASE_URL } = {}) {
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10_000 });
    const database = createPostgresAdapter((statement, params) => pool.query(statement, params), () => pool.end(), () => pool.connect());
    try {
      for (const statement of postgresSchema.split(';').map((item) => item.trim()).filter(Boolean)) {
        await database.exec(statement);
      }
      if (seedDemo) await seedDemoAccount(database);
      return database;
    } catch (error) {
      await database.close();
      throw error;
    }
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('Set DATABASE_URL to a persistent PostgreSQL database before starting in production.');
  }
  if (databasePath !== ':memory:') mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true });

  const connection = new DatabaseSync(databasePath);
  const db = createSqliteAdapter(connection);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      occurred_on TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, occurred_on DESC, id DESC);
    CREATE INDEX IF NOT EXISTS transactions_user_category ON transactions(user_id, category);
  `);

  if (seedDemo) await seedDemoAccount(db);
  return db;
}

async function seedDemoAccount(db) {
  const existing = await db.get('SELECT id FROM users WHERE email = ?', demoEmail);
  if (existing) return;

  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(demoPassword, salt, 64).toString('hex');
  const result = await db.run('INSERT INTO users (name, email, password_hash, password_salt) VALUES (?, ?, ?, ?)',
    '林同学', demoEmail, hash, salt);
  const userId = Number(result.lastInsertRowid);
  const today = new Date();
  const samples = [
    ['expense', 2860, '餐饮', '学校食堂午餐', 0],
    ['expense', 1800, '交通', '地铁月卡补差', 1],
    ['income', 280000, '兼职', '设计稿结算', 2],
    ['expense', 4590, '学习', '专业书籍', 3],
    ['expense', 1200, '餐饮', '咖啡和面包', 4],
    ['expense', 3290, '日用', '洗护用品', 5],
    ['expense', 6800, '娱乐', '周末电影', 7],
    ['expense', 2400, '交通', '公交出行', 8],
    ['expense', 5250, '餐饮', '朋友聚餐', 10],
    ['expense', 9600, '购物', '秋冬外套', 12],
    ['income', 520000, '工资', '月度收入', 13],
    ['expense', 2100, '居家', '宿舍用品', 14],
  ];
  await db.transaction(async (transaction) => {
    for (const [kind, amount, category, note, daysAgo] of samples) {
      const date = new Date(today);
      date.setDate(date.getDate() - daysAgo);
      await transaction.run(`
        INSERT INTO transactions (user_id, kind, amount, category, note, occurred_on)
        VALUES (?, ?, ?, ?, ?, ?)
      `, userId, kind, amount, category, note, localDate(date));
    }
  });
}
