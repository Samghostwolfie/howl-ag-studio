# Payments Setup — Howl A/G Studio

Payments run on **PayPal**. Money lands in your PayPal business account, and you
withdraw from there to the studio bank account.

Everything on the code side is finished and tested. What's left is connecting
**your** PayPal account, which only you can do because it needs your credentials.
Work through this top to bottom — about 20 minutes.

---

## A note on Google Pay

Google Pay is not a payment processor. It is a card wallet — a place to store a
card — and it has no ability to move money into a bank account by itself. Every
site that shows a Google Pay button has a processor sitting behind it doing the
actual work.

So "Google Pay straight into the studio bank account" isn't something that can be
built, by anyone. PayPal is the real processor here, and it covers the same
ground: donors can pay with a PayPal balance, a linked bank account, or **a debit
or credit card as a guest with no PayPal account at all**.

(If Google Pay specifically matters later, PayPal exposes it through *Advanced
Checkout*, which is a separate product with its own eligibility review. That is a
future change, not a config toggle.)

---

## How the money actually flows

```
Donor fills in the form on /games/<slug>
        |
        v
POST /games/<slug>/donate
   - writes a PENDING record holding their name, email and message
   - creates a PayPal order carrying only a reference id
        |
        v
PayPal's hosted page          <- donor enters card / logs in, here on paypal.com
   Donor approves. NOTE: no money has moved yet.
        |
        +---------------------------+
        |                           |
        v                           v
Browser returns to           CHECKOUT.ORDER.APPROVED
/donate/success              webhook -> /webhooks/paypal
        |                           |
        v                           v
   captureOrder()             captureOrder()      <- whichever gets there first
        |                           |
        +------------+--------------+
                     v
              recordCapture()
     - flips PENDING -> completed, but only on a COMPLETED capture
     - keyed on the PayPal capture id, so the second one is a no-op
                     v
     data/donations.json -> progress bar, backer wall, receipt email
```

Three things worth understanding, because they are where donation systems
usually leak money:

**Card details never touch this server.** The donor types them on paypal.com.
That is what keeps you out of PCI compliance scope.

**Approving is not paying.** PayPal separates approval from capture. If a donor
approves and then closes the tab, the money has *not* been taken. The
`CHECKOUT.ORDER.APPROVED` webhook captures it server-side, which is why the
webhook is not optional — without it, those donations are simply lost.

**Only a completed capture counts.** A pending, failed, cancelled or refunded
record stays in the file for your records but never reaches a fundraiser total.
A refund webhook actively removes the donation from the total.

---

## Step 1 — Create a PayPal app (sandbox first)

Do the whole first pass in **sandbox**. No real money can move there.

1. Sign in at <https://developer.paypal.com/dashboard/> with your PayPal business
   account.
2. Go to **Apps & Credentials** and make sure the **Sandbox** toggle (top right)
   is selected.
3. **Create App** → give it a name (e.g. `Howl AG Studio Site`) → Merchant type.
4. Copy the **Client ID** and **Secret**.

Open `.env` in this folder and paste them in:

```
PAYPAL_ENV=sandbox
PAYPAL_CLIENT_ID=AY...
PAYPAL_CLIENT_SECRET=EL...
```

> `.env` is already created for you with a strong random `SESSION_SECRET`
> generated, and is listed in `.gitignore` so it can never be committed.
> **Never paste these into a chat, an issue, or a screenshot.** If a secret ever
> leaks, delete the app in the dashboard and create a new one.

Then check them before going any further:

```bash
npm run check:payments
```

That validates your `.env` and asks PayPal for an access token, which proves the
credentials are real and match the environment you selected. It never prints your
secret and never moves money. Fix anything it flags before continuing — most
setup failures are caught right here.

---

## Step 2 — Get a sandbox test account

PayPal gives you fake buyer accounts to pay with.

1. Go to **Testing Tools → Sandbox Accounts**.
2. You'll see a *Personal* account already created. Click **⋮ → View/Edit** to
   see its email and system-generated password. That's your test donor.

---

## Step 3 — Set up the webhook

The webhook needs a public URL, which `localhost` isn't. Two options:

**Option A — test the webhook locally** using the tunnel you already have. This
repo ships `cloudflared.exe`, and `RESTART-SITE.bat` / `SHARE-DEMO-LINK.bat`
already use it. Start the tunnel, note the public `https://...trycloudflare.com`
URL, and use that below.

**Option B — skip the webhook for the first local test** and set it up properly
when you deploy. The browser-return path alone is enough to prove the flow works;
just be aware that abandoned-tab donations won't be captured until the webhook
exists. Do not go live without it.

To create it:

1. **Apps & Credentials → your app → Webhooks → Add Webhook**.
2. **Webhook URL:** `https://YOUR-PUBLIC-URL/webhooks/paypal`
3. **Event types** — select exactly these five:
   - `CHECKOUT.ORDER.APPROVED`
   - `PAYMENT.CAPTURE.COMPLETED`
   - `PAYMENT.CAPTURE.DENIED`
   - `PAYMENT.CAPTURE.REFUNDED`
   - `PAYMENT.CAPTURE.REVERSED`
4. Save, then copy the **Webhook ID** (it starts with `WH-`) into `.env`:

```
PAYPAL_WEBHOOK_ID=WH-...
```

Restart the site after editing `.env`.

---

## Step 4 — Turn the fundraiser on

The fundraiser is currently **closed** on your game, which is why no donation
section appears on the page at all.

1. Start the site and open <http://localhost:3000/admin>
2. Games → edit **Home** → scroll to the fundraiser block.
3. Set **Fundraiser Status** to `Open`.
4. Set a **Goal** (e.g. `5000`), a **Title**, and a **Pitch**.
5. Save.

| Status | What visitors see |
|---|---|
| **Open** | Full donation form, live progress bar, backer wall. Donations accepted. |
| **Warn / On Hold** | Section visible with a "DO NOT DONATE" banner. Donations refused by the server, not merely hidden. |
| **Closed** | Section hidden entirely. Donations refused. |

---

## Step 5 — Make a test donation

Open the game page, fill in the donation form, and pay with the **sandbox
Personal account** from Step 2.

Then check all four:

- [ ] The progress bar moved and the backer count went up.
- [ ] Your name and message appear on the backer wall.
- [ ] `data/donations.json` has one entry with `"status": "completed"` and a
      `paypalCaptureId`.
- [ ] The server log shows `[paypal] Donation recorded via ...`.

**Then test the failure cases**, which matter just as much:

| Test | Expected |
|---|---|
| Start a donation, then click **Cancel** on PayPal | Record flips to `failed`. Total unchanged. |
| Start a donation, then close the tab at PayPal | Nothing counted (no approval happened). |
| Approve on PayPal, then close the tab before returning | Webhook captures it. Donation appears within a minute. |
| Refund the payment from the PayPal dashboard | Donation flips to `refunded` and drops out of the total. |

---

## Step 6 — Go live

Only after Step 5 passes in sandbox.

1. Switch the dashboard toggle to **Live**, open your app there, and copy the
   **live** Client ID and Secret. They are different from the sandbox ones.

2. Create a **live webhook** pointing at your real domain, with the same five
   event types. Copy its Webhook ID — also different from the sandbox one.

3. Set these on your host (Render → Environment, or `.env` on a VPS):

   ```
   SITE_URL=https://YOUR-DOMAIN.com
   PAYPAL_ENV=live
   PAYPAL_CLIENT_ID=<live client id>
   PAYPAL_CLIENT_SECRET=<live secret>
   PAYPAL_WEBHOOK_ID=<live webhook id>
   PAYPAL_CURRENCY=USD
   SESSION_SECRET=<a long random string>
   ```

   `SITE_URL` matters: without it the server guesses the return URL from request
   headers, which breaks behind a load balancer. No trailing slash.

4. Restart and read the boot banner — it tells you the truth:

   ```
   Payments:    PayPal connected (live mode, USD) — webhook OK
   ```

   If it says `NOT CONNECTED`, or warns about a missing webhook ID, fix that
   before announcing the fundraiser.

5. **Donate $1 to yourself for real**, confirm it lands on the backer wall and in
   your PayPal balance, then refund it from the PayPal dashboard and confirm the
   total drops back.

---

## Getting the money into the bank account

PayPal holds the money in your PayPal business balance. To move it:

- **PayPal dashboard → Money → Transfer to your bank.** Link the studio bank
  account there first; PayPal verifies it with small test deposits.
- You can set **automatic withdrawals** (daily/weekly) in PayPal's settings so
  you don't have to do it by hand.
- Transfers typically take 1–3 business days. Money does not arrive in the bank
  instantly — no processor does that.
- New accounts sometimes have funds held for a period until a payment history is
  established. That is a PayPal account matter, nothing to do with this code.

**Fees:** PayPal deducts its cut before the money reaches your balance, so the
amount on the backer wall (what the donor chose) will be slightly more than what
lands. Check current rates for your country, and note that PayPal offers reduced
nonprofit rates if the studio ever qualifies.

**Tax:** you mentioned tax being handled for you. Two separate things:
donations to a company are normally not taxable sales, so no tax is calculated or
added by this code. PayPal reports your received payments to you (1099-K style,
depending on country) — but how that income is treated is a question for your
accountant, not something the site decides.

---

## Where things live

| File | What it does |
|---|---|
| `lib/payments.js` | All PayPal logic. Credentials, orders, capture, webhook verification, and the single place donations are ever written. |
| `server.js` → `/webhooks/paypal` | Webhook receiver. Mounted **before** the body parsers — do not move it, or verification breaks. |
| `server.js` → `POST /games/:slug/donate` | Writes the pending record, creates the order, sends the donor to PayPal. |
| `server.js` → `GET /games/:slug/donate/success` | Captures on return. Not the only path — the webhook does the same. |
| `server.js` → `recordCapture()` | The single funnel both paths go through. |
| `data/donations.json` | Donation records. Only `"status": "completed"` counts toward a total. |
| `data/orders.json` | Game purchase records, same machinery. |

**Record statuses:** `pending` (sent to PayPal, not yet paid), `completed` (money
captured — the only status that counts), `failed` (cancelled or denied),
`refunded` (was completed, money given back).

---

## Troubleshooting

**"Donations are temporarily unavailable"**
`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` are empty, or the server wasn't
restarted after editing `.env`. The boot banner confirms which.

**"We could not reach PayPal just now"**
PayPal rejected the request. The exact reason is in the server log prefixed
`[paypal]`. Most often: sandbox credentials used with `PAYPAL_ENV=live` (or the
reverse), or a deleted app.

**Donation succeeded but the backer wall is empty**
The capture didn't complete, or the webhook isn't arriving. Check the app's
Webhooks page in the PayPal dashboard for failed deliveries — it shows the
response it got from your server.

**Every webhook is rejected with "could not verify signature"**
`PAYPAL_WEBHOOK_ID` doesn't match the webhook sending the events (sandbox and
live have different IDs), or something was added ahead of the raw-body route in
`server.js` that parses the body first.

**A record is stuck on `pending`**
The donor started a donation and never finished. Harmless — it counts toward
nothing. Delete it in Admin → Donations if you want it tidied.

**A donation shows `orphaned: true`**
It was captured but no pending record matched, so it was rebuilt from PayPal's
data alone and has no message or game attached. Rare. Check Admin → Donations and
fix the details by hand.

**The fundraiser section isn't on the page at all**
Its status is `Closed`. See Step 4.

**`npm install` succeeds but the app can't find its modules**
Something on this machine has been deleting `.js` files out of `node_modules` —
this happened once already and needed a full reinstall. It's almost always
antivirus quarantine or OneDrive sync. Exclude this folder from both, and
consider moving the project out of `C:\Users\...\Music\` (a OneDrive-synced
location) to somewhere like `C:\dev\`.
