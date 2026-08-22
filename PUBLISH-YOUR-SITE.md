# Putting Howl A/G Studio on the internet — for free

You'll end up with a real link like `https://howl-ag-studio.onrender.com` that you can
send to anyone, including publishers.

**Two free accounts, no credit card:**

| What | Why | Cost |
|---|---|---|
| **Neon** | Stores your data (wishlist, devlog, news, comments) | Free, no card, doesn't expire |
| **Render** | Runs the website itself | Free, 750 hours/month |
| **GitHub** | Holds your code so Render can read it | Free |

**Why two services and not just one?** Render's free plan wipes its own hard drive
every time the site goes to sleep. If your data lived there, every wishlist signup
would vanish. Neon keeps it somewhere permanent. This is the single most important
thing to get right.

Set aside about 40 minutes. Take it one step at a time.

---

## Step 1 — Get a database (10 min)

1. Go to **https://neon.com** and sign up (GitHub or Google login is quickest).
2. Create a project. Any name — "howl" is fine.
3. When it's made, look for **Connection string** and copy it. It looks like:

   ```
   postgresql://neondb_owner:AbC123xyz@ep-cool-name-123456.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```

4. Paste it somewhere safe for a minute. **Treat it like a password.**

---

## Step 2 — Move your existing data into it (5 min)

This copies everything you've already added — your games, team, wishlist signups —
so nothing is lost.

1. In your `howl-ag-studio-SOFTWARE` folder, find `.env.example` and make a copy
   named exactly **`.env`** (no `.example`).
2. Open `.env` in Notepad. Find the `DATABASE_URL=` line and paste your Neon string
   after the `=`, with no spaces:

   ```
   DATABASE_URL=postgresql://neondb_owner:AbC...
   ```

3. Save and close.
4. Open a Command Prompt in that folder and run:

   ```
   npm install
   npm run migrate
   ```

   You should see your data listed as it copies across.

> **If `npm` gives an error:** npm is currently broken on your machine. Reinstall
> Node.js from **https://nodejs.org** (the big LTS button) — that repairs it. You
> only need npm for this one step and for the first deploy.

5. **Important:** open `.env` again and clear the `DATABASE_URL` line back to empty:

   ```
   DATABASE_URL=
   ```

   That keeps your local copy running from files, so you can keep experimenting at
   home without touching the live site's data.

---

## Step 3 — Put the code on GitHub (10 min)

Render needs to read your code from somewhere.

1. Sign up at **https://github.com**.
2. Download **GitHub Desktop** from https://desktop.github.com — it avoids the
   command line entirely.
3. In GitHub Desktop: **File → Add local repository** → choose your
   `howl-ag-studio-SOFTWARE` folder → it will offer to create a repository, say yes.
4. Give it a name, and **tick "Keep this code private"**.
5. Click **Publish repository**.

`.gitignore` already stops your `.env` and `node_modules` from being uploaded, so
your passwords stay on your machine.

---

## Step 4 — Deploy (10 min)

1. Go to **https://render.com** and sign up **with GitHub**.
2. Click **New → Web Service**, and pick your repository.
3. Render should detect the settings automatically. Check they read:
   - **Build Command:** `npm install`
   - **Start Command:** `node server.js`
   - **Instance Type:** Free
4. Scroll to **Environment Variables** and add these four:

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | your Neon connection string from Step 1 |
   | `ADMIN_PASSWORD` | a strong password you invent now — this is your login |
   | `ADMIN_PATH` | a secret word, e.g. `howl-control` |
   | `NODE_ENV` | `production` |

   Render adds `SESSION_SECRET` for you.

5. Click **Create Web Service** and wait a few minutes.

Your site is live at the URL Render shows you.

---

## Step 5 — Log in and check

Your admin panel is **not** at `/admin` any more. It's at whatever you set
`ADMIN_PATH` to:

```
https://your-site.onrender.com/howl-control
```

Log in with username `admin` and the `ADMIN_PASSWORD` you chose.

Then check the sidebar says **Storage: Postgres**. If it says local JSON files,
`DATABASE_URL` didn't get through — check it in Render's settings.

---

## Things worth knowing

**The site sleeps.** On the free plan it shuts down after 15 minutes with no
visitors, and the next person waits about a minute for it to wake. Your data is
safe — only the site is asleep. If you're sending the link to a publisher, open it
yourself a minute beforehand so it's already awake.

**Use image links, not uploads.** Uploaded files live on Render's disk, which is
wiped when the site sleeps. Every image field in the admin also accepts a **link**
(Google Drive, Imgur, YouTube) — use those and your art always survives. Same for
game builds: use the "external store link" field pointing at itch.io.

**Updating the site later.** Make your changes locally, then in GitHub Desktop write
a short summary and press **Commit** then **Push**. Render redeploys on its own in a
few minutes.

**Keep your local copy.** Your computer still runs the site from the `data/` folder
as a private sandbox. It's completely separate from the live site now.

---

## If something goes wrong

- **"Application failed to respond"** — usually still waking up. Wait a minute and
  reload. If it persists, open **Logs** in Render; the error is printed there.
- **Site loads but everything is empty** — `DATABASE_URL` isn't set correctly, or you
  skipped the migrate step. The sidebar's Storage line tells you which.
- **Can't log in** — you're using the old password. The account is created from
  `ADMIN_PASSWORD` the *first* time it runs. If it was already created with a
  different one, log in with that and change it in Settings.
- **Locked out after wrong guesses** — five failed attempts locks that IP for 15
  minutes, on purpose. Wait it out.
