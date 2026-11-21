import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';

export const profileTypes = {
  student: {
    label: '学生',
    description: '生活费、奖学金、兼职与校园日常',
    expense: ['餐饮', '交通', '学习', '日用', '娱乐', '医疗', '其他'],
    income: ['生活费', '奖学金', '兼职', '退款', '其他'],
  },
  employee: {
    label: '上班族',
    description: '工资、奖金、通勤与日常账单',
    expense: ['餐饮', '交通', '居家', '日用', '购物', '娱乐', '医疗', '其他'],
    income: ['工资', '奖金', '兼职', '退款', '其他'],
  },
  family: {
    label: '家庭',
    description: '家庭收入、住房、教育与共同开支',
    expense: ['餐饮', '交通', '居家', '教育', '日用', '购物', '医疗', '娱乐', '其他'],
    income: ['工资', '经营收入', '奖金', '退款', '其他'],
  },
};

export const expenseCategories = [...new Set(Object.values(profileTypes).flatMap((profile) => profile.expense))];
export const incomeCategories = [...new Set(Object.values(profileTypes).flatMap((profile) => profile.income))];

export function categoriesForProfile(profileType = 'student') {
  const profile = profileTypes[profileType] ?? profileTypes.student;
  return { expense: profile.expense, income: profile.income };
}

export function allCategories() {
  return { expense: expenseCategories, income: incomeCategories };
}

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
      const returnsId = /^\s*INSERT\s+INTO\s+(?:users|transactions|households)\b/i.test(statement) && !/\bRETURNING\b/i.test(statement);
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
    profile_type TEXT NOT NULL DEFAULT 'student' CHECK (profile_type IN ('student', 'employee', 'family')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_type TEXT NOT NULL DEFAULT 'student' CHECK (profile_type IN ('student', 'employee', 'family'));
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at BIGINT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
  CREATE TABLE IF NOT EXISTS households (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    invite_code TEXT NOT NULL UNIQUE,
    created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS household_members (
    household_id BIGINT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
    joined_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (household_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS household_members_user ON household_members(user_id, household_id);
  CREATE UNIQUE INDEX IF NOT EXISTS household_members_one_per_user ON household_members(user_id);
  CREATE TABLE IF NOT EXISTS transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    household_id BIGINT REFERENCES households(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    category TEXT NOT NULL,
    project TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    occurred_on TEXT NOT NULL,
    detail_time TEXT,
    location TEXT,
    content TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS household_id BIGINT REFERENCES households(id) ON DELETE CASCADE;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS project TEXT NOT NULL DEFAULT '';
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS detail_time TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS location TEXT;
  ALTER TABLE transactions ADD COLUMN IF NOT EXISTS content TEXT;
  CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, occurred_on DESC, id DESC);
  CREATE INDEX IF NOT EXISTS transactions_user_category ON transactions(user_id, category);
  CREATE INDEX IF NOT EXISTS transactions_household_date ON transactions(household_id, occurred_on DESC, id DESC);
`;

export async function createDatabase(databasePath, { seedDemo = false, databaseUrl = process.env.DATABASE_URL } = {}) {
  if (databaseUrl) {
    const pool = new Pool({ connectionString: databaseUrl, max: 5, connectionTimeoutMillis: 10_000 });
    const database = createPostgresAdapter((statement, params) => pool.query(statement, params), () => pool.end(), () => pool.connect());
    try {
      for (const statement of postgresSchema.split(';').map((item) => item.trim()).filter(Boolean)) {
        await database.exec(statement);
      }
      await database.run("UPDATE transactions SET project = note WHERE project = '' AND note <> ''");
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
      profile_type TEXT NOT NULL DEFAULT 'student',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
    CREATE TABLE IF NOT EXISTS households (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      invite_code TEXT NOT NULL UNIQUE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS household_members (
      household_id INTEGER NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('owner', 'member')),
      joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (household_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS household_members_user ON household_members(user_id, household_id);
    CREATE UNIQUE INDEX IF NOT EXISTS household_members_one_per_user ON household_members(user_id);
    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      household_id INTEGER REFERENCES households(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('expense', 'income')),
      amount INTEGER NOT NULL CHECK (amount > 0),
      category TEXT NOT NULL,
      project TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      occurred_on TEXT NOT NULL,
      detail_time TEXT,
      location TEXT,
      content TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS transactions_user_date ON transactions(user_id, occurred_on DESC, id DESC);
    CREATE INDEX IF NOT EXISTS transactions_user_category ON transactions(user_id, category);
  `);

  const userColumns = connection.prepare('PRAGMA table_info(users)').all();
  if (!userColumns.some((column) => column.name === 'profile_type')) {
    db.exec("ALTER TABLE users ADD COLUMN profile_type TEXT NOT NULL DEFAULT 'student'");
  }
  const transactionColumns = connection.prepare('PRAGMA table_info(transactions)').all();
  if (!transactionColumns.some((column) => column.name === 'household_id')) {
    db.exec('ALTER TABLE transactions ADD COLUMN household_id INTEGER REFERENCES households(id) ON DELETE CASCADE');
  }
  for (const column of ['project', 'detail_time', 'location', 'content']) {
    if (!transactionColumns.some((existing) => existing.name === column)) {
      db.exec(`ALTER TABLE transactions ADD COLUMN ${column} ${column === 'project' ? "TEXT NOT NULL DEFAULT ''" : 'TEXT'}`);
    }
  }
  db.exec("UPDATE transactions SET project = note WHERE project = '' AND note <> ''");
  db.exec('CREATE INDEX IF NOT EXISTS transactions_household_date ON transactions(household_id, occurred_on DESC, id DESC)');

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
        INSERT INTO transactions (user_id, kind, amount, category, project, note, occurred_on)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, userId, kind, amount, category, note, note, localDate(date));
    }
  });
}
