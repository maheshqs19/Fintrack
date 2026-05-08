require('dotenv').config();
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const APP_PASSWORD = process.env.APP_PASSWORD || 'fintrack2024';

// ─── DATABASE ────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { rejectUnauthorized: false }
    : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id        SERIAL PRIMARY KEY,
        amount    DECIMAL(12,2) NOT NULL,
        type      VARCHAR(10)   NOT NULL CHECK (type IN ('income','expense')),
        category  VARCHAR(60)   NOT NULL,
        note      TEXT          DEFAULT '',
        date      DATE          NOT NULL DEFAULT CURRENT_DATE,
        created_at TIMESTAMPTZ  DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS budgets (
        id              SERIAL PRIMARY KEY,
        category        VARCHAR(60)    UNIQUE NOT NULL,
        monthly_limit   DECIMAL(12,2)  NOT NULL,
        warn_pct        INTEGER        DEFAULT 80
      );

      CREATE TABLE IF NOT EXISTS alerts (
        id         SERIAL PRIMARY KEY,
        type       VARCHAR(50) NOT NULL,
        message    TEXT        NOT NULL,
        severity   VARCHAR(10) DEFAULT 'warning',
        is_read    BOOLEAN     DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   VARCHAR(50) PRIMARY KEY,
        value TEXT        NOT NULL
      );

      INSERT INTO settings (key, value) VALUES
        ('currency', 'QAR'),
        ('currency_symbol', 'QAR'),
        ('large_tx_threshold', '2000'),
        ('monthly_income_target', '0')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('✅ Database ready');
  } finally {
    client.release();
  }
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'fintrack-super-secret-change-in-prod',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

const requireAuth = (req, res, next) => {
  if (req.session.authenticated) return next();
  if (req.path.startsWith('/api')) return res.status(401).json({ error: 'Unauthorized' });
  res.redirect('/login');
};

// ─── PUBLIC ROUTES ────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.authenticated) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/api/auth/login', (req, res) => {
  const { password } = req.body;
  if (password === APP_PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Wrong password' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// ─── PROTECTED STATIC FILES ───────────────────────────────────────────────────
app.get('/', requireAuth, (req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'index.html'))
);

// ─── ALERT ENGINE ─────────────────────────────────────────────────────────────
async function createAlertOnce(client, type, key, message, severity = 'warning') {
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const exists = await client.query(
    `SELECT id FROM alerts WHERE type=$1 AND message=$2 AND created_at >= $3`,
    [type, message, monthStart]
  );
  if (exists.rows.length === 0) {
    await client.query(
      `INSERT INTO alerts (type, message, severity) VALUES ($1,$2,$3)`,
      [type, message, severity]
    );
  }
}

async function runAlertEngine(client) {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  // ── 1. Budget alerts
  const budgets = await client.query('SELECT * FROM budgets');
  for (const b of budgets.rows) {
    const { rows } = await client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
       WHERE type='expense' AND category=$1
         AND EXTRACT(YEAR FROM date)=$2 AND EXTRACT(MONTH FROM date)=$3`,
      [b.category, year, month]
    );
    const spent = parseFloat(rows[0].total);
    const pct = (spent / parseFloat(b.monthly_limit)) * 100;

    if (pct >= 100) {
      await createAlertOnce(client, 'budget_exceeded', b.category,
        `🚨 Budget exceeded — ${b.category}: spent QAR ${spent.toFixed(0)} of QAR ${b.monthly_limit} limit`,
        'critical');
    } else if (pct >= b.warn_pct) {
      await createAlertOnce(client, 'budget_warning', b.category,
        `⚠️ Budget at ${pct.toFixed(0)}% — ${b.category}: QAR ${spent.toFixed(0)} of QAR ${b.monthly_limit}`,
        'warning');
    }
  }

  // ── 2. Spending spike: this week vs last week
  const todayStr = now.toISOString().split('T')[0];
  const dayOfWeek = now.getDay();
  const thisWeekStart = new Date(now);
  thisWeekStart.setDate(now.getDate() - dayOfWeek);
  const lastWeekStart = new Date(thisWeekStart);
  lastWeekStart.setDate(lastWeekStart.getDate() - 7);
  const lastWeekEnd = new Date(thisWeekStart);
  lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);

  const [tw, lw] = await Promise.all([
    client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='expense' AND date>=$1`,
      [thisWeekStart.toISOString().split('T')[0]]
    ),
    client.query(
      `SELECT COALESCE(SUM(amount),0) AS total FROM transactions WHERE type='expense' AND date>=$1 AND date<=$2`,
      [lastWeekStart.toISOString().split('T')[0], lastWeekEnd.toISOString().split('T')[0]]
    )
  ]);

  const thisWeekTotal = parseFloat(tw.rows[0].total);
  const lastWeekTotal = parseFloat(lw.rows[0].total);
  if (lastWeekTotal > 0 && thisWeekTotal > lastWeekTotal * 1.5) {
    await createAlertOnce(client, 'spending_spike', 'weekly',
      `📈 Spending spike: this week QAR ${thisWeekTotal.toFixed(0)} vs last week QAR ${lastWeekTotal.toFixed(0)} (+${(((thisWeekTotal/lastWeekTotal)-1)*100).toFixed(0)}%)`,
      'warning');
  }

  // ── 3. Negative balance alert
  const bal = await client.query(
    `SELECT
       SUM(CASE WHEN type='income' THEN amount ELSE 0 END) -
       SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS balance
     FROM transactions
     WHERE EXTRACT(YEAR FROM date)=$1 AND EXTRACT(MONTH FROM date)=$2`,
    [year, month]
  );
  const balance = parseFloat(bal.rows[0].balance || 0);
  if (balance < 0) {
    await createAlertOnce(client, 'negative_balance', 'monthly',
      `🔴 Negative balance this month: QAR ${Math.abs(balance).toFixed(0)} overspent`,
      'critical');
  }
}

// ─── API: TRANSACTIONS ────────────────────────────────────────────────────────
app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const { month, year, category, type, search, limit = 200 } = req.query;
    const params = [];
    let where = 'WHERE 1=1';

    if (year)  { params.push(year);     where += ` AND EXTRACT(YEAR  FROM date)=$${params.length}`; }
    if (month) { params.push(month);    where += ` AND EXTRACT(MONTH FROM date)=$${params.length}`; }
    if (category && category !== 'all') { params.push(category); where += ` AND category=$${params.length}`; }
    if (type && type !== 'all')         { params.push(type);     where += ` AND type=$${params.length}`; }
    if (search) { params.push(`%${search}%`); where += ` AND (note ILIKE $${params.length} OR category ILIKE $${params.length})`; }

    params.push(limit);
    const { rows } = await pool.query(
      `SELECT * FROM transactions ${where} ORDER BY date DESC, created_at DESC LIMIT $${params.length}`,
      params
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/transactions', requireAuth, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { amount, type, category, note, date } = req.body;

    const { rows } = await client.query(
      `INSERT INTO transactions (amount,type,category,note,date) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [amount, type, category, note || '', date || new Date().toISOString().split('T')[0]]
    );

    // Large transaction check
    const setting = await client.query(`SELECT value FROM settings WHERE key='large_tx_threshold'`);
    const thresh = parseFloat(setting.rows[0]?.value || 2000);
    if (type === 'expense' && parseFloat(amount) >= thresh) {
      await createAlertOnce(client, 'large_tx', category,
        `💰 Large expense: QAR ${parseFloat(amount).toFixed(0)} on ${category}${note ? ` (${note})` : ''}`,
        'info');
    }

    await runAlertEngine(client);
    await client.query('COMMIT');
    res.json(rows[0]);
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: e.message });
  } finally { client.release(); }
});

app.delete('/api/transactions/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM transactions WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: SUMMARY ─────────────────────────────────────────────────────────────
app.get('/api/summary', requireAuth, async (req, res) => {
  try {
    const now = new Date();
    const year  = parseInt(req.query.year  || now.getFullYear());
    const month = parseInt(req.query.month || now.getMonth() + 1);

    const [incomeR, expenseR, byCatR, trendR, budgetsR, recentR, topR] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE type='income' AND EXTRACT(YEAR FROM date)=$1 AND EXTRACT(MONTH FROM date)=$2`,
        [year, month]
      ),
      pool.query(
        `SELECT COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE type='expense' AND EXTRACT(YEAR FROM date)=$1 AND EXTRACT(MONTH FROM date)=$2`,
        [year, month]
      ),
      pool.query(
        `SELECT category, COALESCE(SUM(amount),0) AS total FROM transactions
         WHERE type='expense' AND EXTRACT(YEAR FROM date)=$1 AND EXTRACT(MONTH FROM date)=$2
         GROUP BY category ORDER BY total DESC`,
        [year, month]
      ),
      pool.query(
        `SELECT
           TO_CHAR(date,'YYYY-MM') AS month,
           SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expenses,
           SUM(CASE WHEN type='income'  THEN amount ELSE 0 END) AS income
         FROM transactions
         WHERE date >= NOW() - INTERVAL '7 months'
         GROUP BY TO_CHAR(date,'YYYY-MM')
         ORDER BY month`
      ),
      pool.query('SELECT * FROM budgets'),
      pool.query('SELECT * FROM transactions ORDER BY created_at DESC LIMIT 8'),
      pool.query(
        `SELECT category, SUM(amount) AS total FROM transactions
         WHERE type='expense' AND EXTRACT(YEAR FROM date)=$1 AND EXTRACT(MONTH FROM date)=$2
         GROUP BY category ORDER BY total DESC LIMIT 3`,
        [year, month]
      )
    ]);

    const income   = parseFloat(incomeR.rows[0].total);
    const expenses = parseFloat(expenseR.rows[0].total);

    // Budget utilization
    const budgetStatus = budgetsR.rows.map(b => {
      const catSpend = byCatR.rows.find(r => r.category === b.category);
      const spent = catSpend ? parseFloat(catSpend.total) : 0;
      return {
        category: b.category,
        limit:    parseFloat(b.monthly_limit),
        spent,
        pct:      Math.min((spent / parseFloat(b.monthly_limit)) * 100, 100).toFixed(1),
        warn_pct: b.warn_pct
      };
    });

    // Daily spending for current month (for sparkline)
    const dailyR = await pool.query(
      `SELECT EXTRACT(DAY FROM date) AS day, SUM(amount) AS total
       FROM transactions
       WHERE type='expense' AND EXTRACT(YEAR FROM date)=$1 AND EXTRACT(MONTH FROM date)=$2
       GROUP BY EXTRACT(DAY FROM date) ORDER BY day`,
      [year, month]
    );

    res.json({
      income, expenses,
      balance:     income - expenses,
      savingsRate: income > 0 ? (((income - expenses) / income) * 100).toFixed(1) : 0,
      byCategory:  byCatR.rows,
      trend:       trendR.rows,
      budgetStatus,
      recentTransactions: recentR.rows,
      topCategories:      topR.rows,
      dailySpend:         dailyR.rows
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: BUDGETS ─────────────────────────────────────────────────────────────
app.get('/api/budgets', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM budgets ORDER BY category');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/budgets', requireAuth, async (req, res) => {
  try {
    const { category, monthly_limit, warn_pct = 80 } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO budgets (category, monthly_limit, warn_pct) VALUES ($1,$2,$3)
       ON CONFLICT (category) DO UPDATE SET monthly_limit=$2, warn_pct=$3 RETURNING *`,
      [category, monthly_limit, warn_pct]
    );
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/budgets/:id', requireAuth, async (req, res) => {
  try {
    await pool.query('DELETE FROM budgets WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: ALERTS ──────────────────────────────────────────────────────────────
app.get('/api/alerts', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM alerts WHERE is_read=FALSE ORDER BY created_at DESC LIMIT 30`
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/alerts/:id/read', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE alerts SET is_read=TRUE WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/alerts/read-all', requireAuth, async (req, res) => {
  try {
    await pool.query('UPDATE alerts SET is_read=TRUE');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── API: SETTINGS ────────────────────────────────────────────────────────────
app.get('/api/settings', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM settings');
    const out = {};
    rows.forEach(r => out[r.key] = r.value);
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/settings', requireAuth, async (req, res) => {
  try {
    const updates = req.body; // { key: value, ... }
    for (const [k, v] of Object.entries(updates)) {
      await pool.query(
        `INSERT INTO settings (key,value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2`,
        [k, v]
      );
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── BOOT ─────────────────────────────────────────────────────────────────────
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 FinTrack running on port ${PORT}`));
}).catch(err => {
  console.error('❌ DB init failed:', err.message);
  process.exit(1);
});
