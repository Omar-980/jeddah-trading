# Putting Jeddah Trading on GitHub, then online for testing

This is a two-step journey. **GitHub** holds your code. A **host** (we'll use
Render's free tier) runs it and gives you a test web address. Both testing and
the eventual live site use the *same* GitHub repo — going live later just means
upgrading the host, not redoing anything.

---

## ⚠️ One thing to decide first: make the repo PRIVATE

Your code contains a **default admin password** (`jeddah2026`) used to create the
owner account the first time the app runs. If your GitHub repo is **public**,
anyone could read that and try to log into your admin panel.

So: **create the repository as _Private_** while testing. And the moment your
test site is up, sign in and change the owner password on the **Settings** page.
(After that, even a public repo wouldn't expose your real password, because it's
stored only in your live database, never in the code.)

---

## Step 1 — Get the code onto GitHub

Pick whichever way feels comfortable. All three end with your code on GitHub.

### Option A — GitHub Desktop (no command line, easiest)
1. Install **GitHub Desktop** (desktop.github.com) and sign in.
2. Unzip `jeddah-trading-backend` somewhere permanent (not your Downloads).
3. In GitHub Desktop: **File → Add local repository →** pick the unzipped folder.
   (This folder already contains a git repo and a first commit, so it's ready.)
4. Click **Publish repository**. **Untick "Keep this code private"? No — leave
   it private.** Name it `jeddah-trading` and publish.

### Option B — GitHub website (upload, also no command line)
1. On github.com click **New repository**, name it `jeddah-trading`, choose
   **Private**, and create it.
2. On the new repo page click **uploading an existing file**.
3. Drag the *contents* of the unzipped `jeddah-trading-backend` folder in and
   **Commit**. (Skip the `data` and `.git` folders if present — you don't need
   them.)

### Option C — Command line (if you're comfortable with it)
```bash
cd jeddah-trading-backend
# a git repo + first commit are already here, so just point it at GitHub:
git remote add origin https://github.com/<your-username>/jeddah-trading.git
git branch -M main
git push -u origin main
```
(Create the empty `jeddah-trading` repo on github.com first, set to Private.)

---

## Step 2 — Run it online for testing (Render free tier)

The repo already includes `render.yaml`, which tells Render exactly how to run
the app — including a **1 GB persistent disk** so your test database and uploaded
images survive restarts.

1. Go to **render.com**, sign up (you can sign in *with* your GitHub account),
   and grant it access to your `jeddah-trading` repo.
2. Click **New + → Blueprint**, choose the `jeddah-trading` repo. Render reads
   `render.yaml` and sets everything up — no build step, because the app has zero
   dependencies.
3. Click **Apply / Create**. First deploy takes a couple of minutes.
4. You'll get a URL like `https://jeddah-trading.onrender.com`. That's your test
   site. The admin is at `…/admin`, the investor portal at `…/investor`.
5. **Sign in to the admin and change the owner password immediately** (Settings).

Notes for the free tier:
- The free service **sleeps after ~15 minutes idle** and takes ~30 seconds to
  wake on the next visit. That's normal for testing. The persistent disk means
  no data is lost when it sleeps.
- Live chat and order/tracking updates use a steady connection; they reconnect
  automatically after a wake.

---

## Step 3 — Going live later (when you're ready)

Nothing gets rebuilt. On the same Render service you:
- Upgrade the plan from **Free** to **Starter** so it never sleeps, and/or
- Add your own domain (e.g. `shop.jeddahtrading.gm`) under the service's
  **Settings → Custom Domains**.

To ship future updates: make the change, push to GitHub, and Render redeploys
automatically. (In this workflow, ask Claude to hand you the updated files, drop
them into your repo folder, commit, and push — or upload them on github.com.)

---

## Quick reference

| Thing | Where |
|---|---|
| Storefront | `https://<your-app>.onrender.com/` |
| Admin panel | `…/admin` |
| Investor portal | `…/investor` |
| First admin login | username `owner`, password `jeddah2026` — **change immediately** |
| Local test on Windows | `set PORT=4100` then `node server.js`, open `http://localhost:4100` |
