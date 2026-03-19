# 🏆 Master Ball Cutoff Tracker — PTCG Pocket

Community-powered tool for tracking and predicting the Top 10,000 points cutoff in Pokémon TCG Pocket's Master Ball rank.

---

## 🚀 Setup Guide (15–20 minutes, 100% free)

### Step 1 — Set up Supabase (your free database)

1. Go to **https://supabase.com** and click **Start your project** (sign up with GitHub — free)
2. Click **New project**, give it any name (e.g. `masterball-tracker`), pick a region close to you, create a password (save it somewhere)
3. Wait ~2 minutes for the project to spin up
4. In the left sidebar, click **SQL Editor**, then **New query**
5. Open the file `supabase-schema.sql` from this folder, copy the entire contents, paste it into the SQL Editor, and click **Run**
6. You should see "Success. No rows returned" — your table is created ✅
7. In the left sidebar, go to **Settings → API**
8. Copy two values:
   - **Project URL** (looks like `https://abcdefgh.supabase.co`)
   - **anon / public** key (long string under "Project API keys")

---

### Step 2 — Configure environment variables

1. In the project folder, find the file called `.env.example`
2. Make a copy of it and name the copy `.env` (no ".example")
3. Open `.env` and fill in your values:

```
VITE_SUPABASE_URL=https://your-project-id.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key-here
```

---

### Step 3 — Run it locally (optional, to test first)

Make sure you have **Node.js** installed (https://nodejs.org — download the LTS version).

Open a terminal in the project folder and run:

```bash
npm install
npm run dev
```

Open **http://localhost:5173** in your browser. Try submitting a snapshot!

---

### Step 4 — Push to GitHub

In your terminal (still in the project folder):

```bash
git init
git add .
git commit -m "Initial commit"
```

Then go to **https://github.com/new**, create a new repository (name it `masterball-tracker`, keep it public or private), and follow the "push an existing repository" instructions GitHub shows you. It'll look like:

```bash
git remote add origin https://github.com/YOUR_USERNAME/masterball-tracker.git
git branch -M main
git push -u origin main
```

---

### Step 5 — Deploy to Vercel (free hosting)

1. Go to **https://vercel.com** and sign in with GitHub
2. Click **Add New → Project**
3. Find your `masterball-tracker` repo and click **Import**
4. Before clicking Deploy, click **Environment Variables** and add:
   - `VITE_SUPABASE_URL` → your Supabase project URL
   - `VITE_SUPABASE_ANON_KEY` → your Supabase anon key
5. Click **Deploy** — Vercel builds and hosts it automatically
6. In ~1 minute you'll get a live URL like `https://masterball-tracker.vercel.app` 🎉

**Every time you push to GitHub, Vercel auto-redeploys.** No manual steps needed.

---

## 🔒 Security notes

- The `.env` file is in `.gitignore` — your keys will **never** be pushed to GitHub
- The Supabase **anon key** is safe to use in a frontend app — it's designed to be public
- Row Level Security (RLS) is enabled on the database — the SQL schema limits what anonymous users can do (read + insert only, with validation)
- Rank is validated server-side to 1–10,000
- No user accounts required

---

## 📁 Project structure

```
masterball-tracker/
├── src/
│   ├── App.jsx           ← Main app component
│   ├── supabaseClient.js ← Supabase connection
│   ├── main.jsx          ← React entry point
│   └── index.css         ← Global styles
├── index.html
├── vite.config.js
├── package.json
├── .env.example          ← Template for environment variables
├── .env                  ← Your actual keys (never committed)
├── .gitignore
└── supabase-schema.sql   ← Run this in Supabase SQL Editor
```
