# Kite Competition Judging

A live scoring app for kitesurf competitions: admin planning, a trick spotter,
judge scoring, a public bracket, and a live leaderboard — all synced in
real time through Supabase.

## 1. Set up Supabase (the database)

1. Go to [supabase.com](https://supabase.com) and create a free account, then a new project.
2. Once it's created, open the **SQL Editor** (left sidebar) → **New query**.
3. Paste in the entire contents of `supabase-schema.sql` (in this folder) and click **Run**.
   This creates the three tables the app needs and turns on realtime sync.
4. Go to **Project Settings → API**. You'll need two values from this page:
   - **Project URL**
   - **anon public** key (NOT the `service_role` key — that one must stay secret)

## 2. Push this project to GitHub

1. Create a free account at [github.com](https://github.com) if you don't have one.
2. Create a new empty repository (e.g. `kite-comp-judging`).
3. From this folder, run:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/kite-comp-judging.git
   git push -u origin main
   ```
   (GitHub will show you these exact commands with your username filled in
   when you create the repo — you can copy them from there instead.)

## 3. Deploy on Vercel (the hosting)

1. Go to [vercel.com](https://vercel.com) and sign up (you can sign up directly with your GitHub account — easiest option).
2. Click **Add New → Project**, then pick the `kite-comp-judging` repo you just pushed.
3. Vercel will auto-detect it's a Vite project. Before clicking Deploy, open
   **Environment Variables** and add the two values from Supabase step 4:
   - `VITE_SUPABASE_URL` = your Project URL
   - `VITE_SUPABASE_ANON_KEY` = your anon public key
4. Click **Deploy**. In about a minute you'll get a live URL like
   `kite-comp-judging.vercel.app` — that's the link you share with judges,
   spotters, and anyone watching the leaderboard.

Any time you want changes, just ask me, I'll update the code, and you push
the updated files to GitHub the same way — Vercel redeploys automatically
within a minute or two.

## Local development (optional)

If you want to run it on your own laptop before deploying:

```
npm install
cp .env.example .env.local
# then edit .env.local with your real Supabase URL and anon key
npm run dev
```

## Notes

- The admin area is protected by a simple password (currently set in the
  code), not full user accounts — enough to keep casual visitors out, not
  meant as strong security.
- Every reader/writer with the site link can read and write competition
  data (matching how the earlier prototype worked). If you ever want real
  per-person logins, that's a bigger follow-up using Supabase Auth.
