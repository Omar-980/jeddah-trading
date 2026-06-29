# Deploying Jeddah Trading online

Your store runs on `localhost` (only your computer) until you put it on a host.
This guide covers the easiest free option — **Render.com** — plus alternatives.

> You'll need to create the hosting account and sign in yourself (that part can't be
> automated for you). Everything else is pre-configured in this project.

---

## Option A — Render.com (recommended, free to start)

This project already includes a `render.yaml` blueprint, so Render sets up the server,
the Node version, and a persistent disk for your database **automatically**.

**1. Put the code on GitHub** (Render deploys from a Git repo)

- Create a free account at https://github.com and click **New repository** → name it `jeddah-trading` → **Create**.
- On the new repo page, click **uploading an existing file**.
- Drag in **all the files from this folder** (server.js, db.js, package.json, render.yaml, Dockerfile, the `public/` and `admin/` folders, etc.). Click **Commit changes**.

**2. Deploy on Render**

- Create a free account at https://render.com (you can sign up with your GitHub account).
- Click **New +** → **Blueprint**.
- Select your `jeddah-trading` repository. Render reads `render.yaml` and shows the service.
- Click **Apply** / **Create**. Wait ~2 minutes for it to build and go live.
- Render gives you a public URL like `https://jeddah-trading.onrender.com`.

**3. First steps on your live site**

- Visit your URL → the storefront.
- Visit `your-url/admin` → log in with `jeddah2026` → **Settings** → change the password and confirm your WhatsApp number.

> **Free tier note:** Render's free plan "sleeps" after ~15 minutes idle, so the first
> visit after a quiet spell takes ~30 seconds to wake. Upgrading to the **Starter** plan
> (a few dollars/month) keeps it always-on. Your data persists either way (it's on the disk).

---

## Option B — Any host that supports Docker

This project has a `Dockerfile`, so it runs on **Railway, Fly.io, DigitalOcean App Platform,
or any VPS** without changes. Point the host at this folder; it builds the image and runs it.
Mount a persistent volume at `/data` so your database and images are kept (the Dockerfile
already declares `VOLUME ["/data"]` and sets `DATA_DIR=/data`).

---

## Option C — Your own VPS (full control)

On a server with **Node 22.13 or newer**:

```bash
# copy this folder to the server, then:
cd jeddah-trading-backend
DATA_DIR=/var/jeddah-data PORT=3000 node server.js
```

Keep it running with `pm2`:

```bash
npm install -g pm2
DATA_DIR=/var/jeddah-data pm2 start server.js --name jeddah-trading
pm2 save && pm2 startup
```

Put Nginx (or Caddy) in front for HTTPS and your custom domain.

---

## Important for every option

- **Node version must be 22.13.0 or newer** (built-in SQLite). Render uses `NODE_VERSION=22`
  from the blueprint; Docker uses `node:22-alpine` — both are fine.
- **Back up your data.** Everything lives in `DATA_DIR` (`store.db` + `uploads/`). On hosts
  with throwaway disks, always attach a persistent volume there (the blueprint/Dockerfile do this).
- **Change the admin password** immediately after first login (Settings page).
- **Custom domain** (e.g. `jeddahtrading.gm`): every option above supports adding one in the host's dashboard.
