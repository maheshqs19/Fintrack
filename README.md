# 💎 FinTrack — Personal Finance App

A clean, fast personal finance tracker with charts, budget tracking, and smart warnings.

---

## 🚀 Deploy to Railway (Step-by-Step)

### Prerequisites
- A [Railway](https://railway.app) account (free tier works)
- A [GitHub](https://github.com) account

---

### Step 1: Push to GitHub

```bash
cd fintrack
git init
git add .
git commit -m "Initial commit"
```

Then create a new repository on GitHub and push:
```bash
git remote add origin https://github.com/YOUR_USERNAME/fintrack.git
git branch -M main
git push -u origin main
```

---

### Step 2: Create a Railway Project

1. Go to [railway.app](https://railway.app) → **New Project**
2. Select **Deploy from GitHub repo**
3. Choose your `fintrack` repository
4. Railway will auto-detect Node.js and start building

---

### Step 3: Add PostgreSQL Database

1. In your Railway project dashboard, click **+ New**
2. Select **Database** → **Add PostgreSQL**
3. Railway will create the database and automatically set `DATABASE_URL` in your environment

---

### Step 4: Set Environment Variables

In Railway project → your service → **Variables** tab, add:

| Key              | Value                                |
|------------------|--------------------------------------|
| `APP_PASSWORD`   | Your chosen login password           |
| `SESSION_SECRET` | A long random string (32+ chars)     |

> `DATABASE_URL` and `PORT` are set automatically by Railway — do NOT add them manually.

To generate a SESSION_SECRET on your computer:
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

### Step 5: Get Your URL

1. Railway → your service → **Settings** → **Domains**
2. Click **Generate Domain** (free `*.up.railway.app` URL)
3. Open the URL → you'll see the login page
4. Sign in with your `APP_PASSWORD`

---

## 🖥️ Local Development

```bash
cd fintrack
npm install
cp .env.example .env
# Edit .env with your local PostgreSQL URL and passwords

npm run dev     # Uses nodemon for auto-reload
# OR
npm start       # Plain node
```

---

## ✨ Features

- **Dashboard** — Monthly income/expense summary, savings rate, category donut chart, 6-month trend
- **Quick Add** — Record a transaction in under 10 seconds
- **Budget Tracking** — Set monthly limits per category with visual progress bars
- **Smart Alerts** — Auto-generated warnings for:
  - 🚨 Budget exceeded
  - ⚠️  Budget approaching limit (configurable %)
  - 💰 Large single transaction
  - 📈 Weekly spending spike (>50% vs last week)
  - 🔴 Negative monthly balance
- **Transaction History** — Filterable, searchable log with delete
- **Session Auth** — Password-protected, 30-day session

---

## 📁 Project Structure

```
fintrack/
├── server.js          — Express backend + all API routes
├── package.json
├── railway.toml       — Railway deployment config
├── .env.example       — Environment variable template
└── public/
    ├── index.html     — Main SPA (dashboard, add, history, budgets, alerts)
    └── login.html     — Login page
```

---

## 🔧 Customisation

- **Currency**: Change `QAR` in `public/index.html` (search for `QAR`)
- **Large tx threshold**: Set via `/api/settings` or directly in the DB (`settings` table, key `large_tx_threshold`)
- **Default password**: Set `APP_PASSWORD` env var — never leave it as the default in production

---

## 🗄️ Database Tables

| Table          | Purpose                          |
|----------------|----------------------------------|
| `transactions` | All income/expense records       |
| `budgets`      | Monthly category limits          |
| `alerts`       | Generated warning messages       |
| `settings`     | App configuration key-value      |
