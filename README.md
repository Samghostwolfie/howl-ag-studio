# Howl A/G Studio — website

A full website for the studio, built as a small Node.js app so every piece is actually functional,
not just a visual mockup:

- **Intro / Home** — hero, studio pitch, featured game, live wishlist count
- **About** — studio story
- **Team** — grid of team members (managed from the admin panel)
- **Work** — showcase of all your games
- **Game pages** — one page per game, with a wishlist form or a Buy/Download button depending on status
- **Wishlist page** — a dedicated page listing every unreleased game so people can wishlist in one place, and shows a running total to bring to your publisher
- **Admin / Moderator panel** (`/admin`) — password-protected dashboard to add/edit games, upload cover art & screenshots, upload a free build, publish a game as **Free or Paid**, manage the team, and view/export wishlist signups as CSV

Everything (games, team, wishlist signups, studio text) is stored in plain JSON files under `/data`,
so you don't need to set up a database to start using it. You can swap that out for a real database
later — the whole thing goes through `lib/db.js`, so it's one file to change.

## 1. Run it locally

You need [Node.js](https://nodejs.org) 18 or newer installed.

```bash
cd howl-ag-studio
npm install
cp .env.example .env
npm start
```

Then open **http://localhost:3000**.

The first time it boots, it creates a default admin/moderator account and prints the credentials
in the terminal:

```
username: admin
password: ChangeMe123!
```

Log in at **http://localhost:3000/admin/login**, then go to **Settings → Change password**
and set your own password immediately — don't leave the default one active.

(You can also set your own starting `ADMIN_USERNAME` / `ADMIN_PASSWORD` in `.env` *before* the
first run — it only auto-creates an account if none exists yet.)

## 2. Make it yours

Everything below is editable from the admin panel — no code required:

- **Settings tab** — studio name, tagline, homepage pitch, About page story, contact email, social links
- **Games tab** — add your real game(s): title, description, genre, platforms, screenshots, trailer, and status (In development / Wishlist open / Released / Archived)
- **Team tab** — add each team member with a photo, role and bio
- **Wishlist tab** — see every signup, export to CSV to hand to a publisher

## 3. Publishing a game: free or paid

When you create or edit a game, the **Pricing & publishing** section lets you flip between:

- **Free** — if you upload a build file (zip, exe, etc.), the "Download now" button serves it directly from your site. You can also just point it at an external link (itch.io, Steam, your own host).
- **Paid** — set a USD price. Add an **external store link** (Steam, itch.io, your own checkout) as your fallback — the "Buy now" button will send players there.

### Real in-site checkout and fundraiser donations (PayPal)

Donations and paid-game checkout both run on PayPal. Money lands in your PayPal business
account, and you withdraw from there to the studio bank account. Card donors can pay as a
guest without a PayPal account.

Set these in `.env`:

```
PAYPAL_ENV=sandbox            # "live" when you are ready to take real money
PAYPAL_CLIENT_ID=...
PAYPAL_CLIENT_SECRET=...
PAYPAL_WEBHOOK_ID=WH-...      # required in production
```

**Full walkthrough, including the webhook (which is not optional — without it, a donor who
approves and then closes the tab is never charged): see [PAYMENTS-SETUP.md](PAYMENTS-SETUP.md).**

Without those credentials, "Buy now" falls back to your external store link and donations
are refused rather than silently recorded as paid.

## 4. Deploying it

This is a normal Node/Express app with a small amount of local file storage (`/data` and
`/public/uploads`), so it needs a host that keeps a persistent disk — for example
[Railway](https://railway.app), [Render](https://render.com), a small VPS, or similar. It is **not**
a static site, so it won't work as-is on something like GitHub Pages.

General steps on most hosts:

1. Push this folder to a Git repo.
2. Connect the repo to your host, set the start command to `npm start`.
3. Set environment variables from `.env.example` in the host's dashboard (especially `SESSION_SECRET`,
   `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SITE_URL` set to your real domain).
4. Make sure `/data` and `/public/uploads` are on a **persistent volume** — some hosts wipe local
   disk on every deploy, which would erase your games, team and wishlist data.
5. Point your domain at it and you're live.

## 5. Project structure

```
server.js              — all routes (public site + admin)
lib/db.js               — tiny JSON-file data layer
lib/auth.js             — admin login/session logic
lib/upload.js           — file upload handling (covers, screenshots, builds)
data/                    — your content lives here as JSON (games, team, wishlist, studio info)
views/                   — EJS templates for every page
views/admin/             — the admin/moderator dashboard + login
public/css/style.css     — the whole design system
public/js/main.js        — small client-side behaviors (mobile nav, flash message auto-dismiss)
public/uploads/          — cover art, screenshots, team photos and free build files land here
```

## Notes / next steps

- This ships with **placeholder branding and placeholder game content** so you can see the whole
  site working end-to-end — replace it from the admin panel and by editing `data/studio.json` /
  `data/team.json` directly if you'd rather bulk-edit.
- Wishlist signups just require a valid email; there's no email-verification or unsubscribe flow —
  add one (e.g. via a transactional email provider) before collecting emails at scale, to stay on
  the right side of anti-spam law in your region.
- Admin auth here is intentionally simple (one shared account with a password). If you'll have
  multiple moderators, consider adding per-user accounts and roles in `data/admin.json` and
  `lib/auth.js`.
