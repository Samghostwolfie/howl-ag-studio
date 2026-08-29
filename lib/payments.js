// PayPal payments — every piece of money-handling logic the site has, in one file.
//
// Money path:  donor -> PayPal -> your PayPal business account -> your bank.
// Card details never touch this server; the donor enters them on paypal.com.
//
// The rules this module exists to enforce:
//
//   1. A donation only counts once PayPal has actually CAPTURED the money.
//      Creating an order is not payment. Approving an order is not payment.
//      Only a completed capture flips a record to 'completed', and only
//      'completed' records count toward a fundraiser total.
//
//   2. Every payment is recorded exactly once. PayPal tells us a payment
//      succeeded in two independent ways (the browser return and the webhook),
//      either can arrive first, and the browser return may never arrive at all.
//      Both paths funnel through the same recorder, keyed on our own reference
//      id, so a double delivery changes nothing.
//
//   3. If the donor approves and then closes the tab, the money has NOT been
//      taken — the order sits approved but uncaptured. The CHECKOUT.ORDER.APPROVED
//      webhook captures it server-side so that donation isn't silently lost.
//
// Setup instructions live in PAYMENTS-SETUP.md.

const db = require('./db');

const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const WEBHOOK_ID = (process.env.PAYPAL_WEBHOOK_ID || '').trim();
const ENV = (process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();
const CURRENCY = (process.env.PAYPAL_CURRENCY || 'USD').trim().toUpperCase();

const API_BASE = ENV === 'live'
  ? 'https://api-m.paypal.com'
  : 'https://api-m.sandbox.paypal.com';

// PayPal's per-transaction ceiling for most currencies.
const MIN_AMOUNT = 1;
const MAX_AMOUNT = 999999;

function isConfigured() { return !!(CLIENT_ID && CLIENT_SECRET); }
function isLiveMode() { return ENV === 'live'; }
function hasWebhookId() { return !!WEBHOOK_ID; }
function currency() { return CURRENCY; }
function apiBase() { return API_BASE; }

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
// PayPal uses OAuth2 client-credentials: swap the client id + secret for a
// bearer token that lasts ~9 hours. Cached so we aren't re-authenticating on
// every donation, and refreshed a minute early to avoid an expiry race.

let tokenCache = { value: '', expiresAt: 0 };

async function getAccessToken() {
  if (!isConfigured()) throw new Error('PayPal is not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET are empty).');

  if (tokenCache.value && Date.now() < tokenCache.expiresAt) return tokenCache.value;

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const text = await res.text();
  if (!res.ok) {
    // Don't leak the secret into the log — just what PayPal said.
    throw new Error(`PayPal auth failed (${res.status}): ${text.slice(0, 300)}`);
  }

  const data = JSON.parse(text);
  tokenCache = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000,
  };
  return tokenCache.value;
}

/** Thin wrapper so every PayPal call gets auth, JSON handling and useful errors. */
async function api(method, path, { body, headers = {} } = {}) {
  const token = await getAccessToken();
  const init = {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...headers,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);

  const res = await fetch(`${API_BASE}${path}`, init);
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch (e) { data = { raw: text }; }
  }

  if (!res.ok) {
    const detail = data && data.details && data.details[0]
      ? `${data.details[0].issue} — ${data.details[0].description || ''}`
      : (data && data.message) || text.slice(0, 300);
    const err = new Error(`PayPal ${method} ${path} failed (${res.status}): ${detail}`);
    err.status = res.status;
    err.paypal = data;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------------------
// Amounts
// ---------------------------------------------------------------------------

/**
 * Turn whatever the form sent into a safe amount, or null if it isn't usable.
 * Deliberately strict: "abc" is not a $1 donation, it's a broken request, and
 * "-5" must be rejected rather than quietly becoming $5.
 */
function parseAmount(raw) {
  const cleaned = String(raw == null ? '' : raw).replace(/[\s,$£€¥]/g, '');
  const n = Number(cleaned);
  if (!Number.isFinite(n) || n < MIN_AMOUNT || n > MAX_AMOUNT) return null;
  return Math.round(n * 100) / 100;
}

/** PayPal wants amounts as strings with exactly two decimals: 25 -> "25.00". */
function toAmountString(amount) {
  return Number(amount).toFixed(2);
}

// ---------------------------------------------------------------------------
// Funding sources
// ---------------------------------------------------------------------------
// What the donation form offers. PayPal's hosted checkout decides which of
// these it can actually show the individual donor — we only steer it.
//
//   paypal — PayPal balance / linked bank / PayPal Credit
//   card   — "Debit or Credit Card", guest checkout, no PayPal account needed
//
// Google Pay is deliberately absent: it is a card wallet, not a processor, and
// PayPal only exposes it through Advanced Checkout, which is separately
// eligibility-gated. See PAYMENTS-SETUP.md.
const FUNDING = {
  paypal: { label: 'PayPal', landingPage: 'LOGIN' },
  card: { label: 'Debit or Credit Card', landingPage: 'BILLING' },
};

function isKnownMethod(choice) {
  return Object.prototype.hasOwnProperty.call(FUNDING, choice);
}

function methodLabel(choice) {
  return (FUNDING[choice] || FUNDING.paypal).label;
}

/**
 * BILLING drops the donor straight onto the card form; LOGIN shows the PayPal
 * sign-in first. Either way both options remain reachable on PayPal's page.
 */
function landingPageFor(choice) {
  return (FUNDING[choice] || FUNDING.paypal).landingPage;
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

function newRef(prefix) {
  return `${prefix}_${Date.now()}_${Math.round(Math.random() * 1e6)}`;
}

/** Pull the URL the donor must be sent to in order to approve the payment. */
function approveUrlFrom(order) {
  const links = (order && order.links) || [];
  const link = links.find((l) => l.rel === 'payer-action') || links.find((l) => l.rel === 'approve');
  return link ? link.href : null;
}

/**
 * Create a PayPal order and return { id, approveUrl }.
 *
 * `ref` is our own reference id. It travels to PayPal as custom_id and comes
 * back on every webhook, which is how a capture is matched to the pending
 * record holding the donor's name, message and email.
 */
async function createOrder({ ref, amount, description, brandName, returnUrl, cancelUrl, method }) {
  const order = await api('POST', '/v2/checkout/orders', {
    // Makes order creation idempotent — a double-submitted form cannot create
    // two orders and therefore cannot take the money twice.
    headers: { 'PayPal-Request-Id': ref },
    body: {
      intent: 'CAPTURE',
      purchase_units: [
        {
          reference_id: ref,
          custom_id: ref,
          description: String(description || '').slice(0, 127),
          amount: {
            currency_code: CURRENCY,
            value: toAmountString(amount),
          },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            brand_name: String(brandName || 'Howl A/G Studio').slice(0, 127),
            landing_page: landingPageFor(method),
            // A donation has nothing to ship — asking for an address would
            // just add a step and lose donors.
            shipping_preference: 'NO_SHIPPING',
            // Button says "Pay Now" rather than "Continue".
            user_action: 'PAY_NOW',
            return_url: returnUrl,
            cancel_url: cancelUrl,
          },
        },
      },
    },
  });

  return { id: order.id, status: order.status, approveUrl: approveUrlFrom(order), raw: order };
}

async function getOrder(orderId) {
  return api('GET', `/v2/checkout/orders/${encodeURIComponent(orderId)}`);
}

/**
 * Capture an approved order — this is the step that actually moves the money.
 *
 * Safe to call twice. If the webhook captured it first, PayPal replies 422
 * ORDER_ALREADY_CAPTURED; we swallow that and fetch the existing capture
 * instead of treating it as a failure.
 */
async function captureOrder(orderId, ref) {
  try {
    return await api('POST', `/v2/checkout/orders/${encodeURIComponent(orderId)}/capture`, {
      headers: { 'PayPal-Request-Id': `cap_${ref || orderId}` },
    });
  } catch (err) {
    const issue = err.paypal && err.paypal.details && err.paypal.details[0]
      ? err.paypal.details[0].issue
      : '';
    if (issue === 'ORDER_ALREADY_CAPTURED') {
      return getOrder(orderId);
    }
    throw err;
  }
}

/** Dig the completed capture out of an order/capture response, if there is one. */
function extractCapture(order) {
  const unit = order && order.purchase_units && order.purchase_units[0];
  const capture = unit && unit.payments && unit.payments.captures && unit.payments.captures[0];
  if (!capture) return null;
  return {
    id: capture.id,
    status: capture.status,
    amount: capture.amount ? Number(capture.amount.value) : 0,
    currency: capture.amount ? capture.amount.currency_code : CURRENCY,
    ref: capture.custom_id || unit.custom_id || unit.reference_id || '',
  };
}

/** Payer details PayPal collected, used when the donor left our fields blank. */
function extractPayer(order) {
  const payer = (order && order.payer) || {};
  const name = payer.name ? [payer.name.given_name, payer.name.surname].filter(Boolean).join(' ') : '';
  return { name: name.trim(), email: payer.email_address || '' };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/**
 * Ask PayPal whether a webhook really came from PayPal.
 *
 * Unlike a local HMAC check this is a live API call, so it fails closed: if we
 * cannot verify it, we do not trust it.
 */
async function verifyWebhook(headers, event) {
  if (!WEBHOOK_ID) throw new Error('PAYPAL_WEBHOOK_ID is not set.');

  const required = [
    'paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id',
    'paypal-transmission-sig', 'paypal-transmission-time',
  ];
  for (const h of required) {
    if (!headers[h]) throw new Error(`Missing ${h} header — not a PayPal webhook.`);
  }

  const result = await api('POST', '/v1/notifications/verify-webhook-signature', {
    body: {
      auth_algo: headers['paypal-auth-algo'],
      cert_url: headers['paypal-cert-url'],
      transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'],
      transmission_time: headers['paypal-transmission-time'],
      webhook_id: WEBHOOK_ID,
      webhook_event: event,
    },
  });

  return result && result.verification_status === 'SUCCESS';
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
// Everything below is synchronous — db.read and db.write are sync in every
// storage mode — so on a single-threaded Node process the read/check/write
// cannot be interleaved by the other delivery path. That is what makes the
// "record exactly once" guarantee hold without a lock.

/**
 * Write the donor's details down before sending them to PayPal, as 'pending'.
 *
 * Pending records never count toward a fundraiser total. They exist so the
 * donor's name, message and email survive the round trip — PayPal's custom_id
 * field is only 127 characters, far too small to carry them.
 */
function createPendingDonation(fields) {
  const donations = db.read('donations', []);
  const record = {
    id: fields.ref,
    ref: fields.ref,
    gameId: fields.gameId || '',
    gameTitle: fields.gameTitle || '',
    gameSlug: fields.gameSlug || '',
    donorName: String(fields.donorName || 'Anonymous').slice(0, 120),
    donorEmail: fields.donorEmail || '',
    amount: fields.amount,
    currency: CURRENCY,
    message: fields.message || '',
    isAnonymous: !!fields.isAnonymous,
    date: new Date().toISOString(),
    paymentMethod: fields.paymentMethod || 'paypal',
    provider: 'paypal',
    paypalOrderId: '',
    paypalCaptureId: '',
    livemode: isLiveMode(),
    status: 'pending',
  };
  donations.push(record);
  db.write('donations', donations);
  return record;
}

/**
 * Promote a pending record to 'completed' using a real PayPal capture.
 * Safe to call any number of times for the same capture.
 *
 * @returns {{created: boolean, donation?: object, reason: string}}
 */
function recordDonationFromCapture(order) {
  const capture = extractCapture(order);
  if (!capture) return { created: false, reason: 'no-capture-on-order' };
  if (capture.status !== 'COMPLETED') {
    return { created: false, reason: `capture not completed (status=${capture.status})` };
  }

  const donations = db.read('donations', []);

  // Already recorded by the other delivery path?
  const byCapture = donations.find((d) => d.paypalCaptureId === capture.id);
  if (byCapture) return { created: false, donation: byCapture, reason: 'already-recorded' };

  const payer = extractPayer(order);
  const pending = capture.ref ? donations.find((d) => d.ref === capture.ref) : null;

  if (pending) {
    if (pending.status === 'completed') {
      return { created: false, donation: pending, reason: 'already-recorded' };
    }
    // Trust PayPal's number, not the one the form sent.
    pending.amount = capture.amount;
    pending.currency = capture.currency;
    pending.status = 'completed';
    pending.date = new Date().toISOString();
    pending.paypalOrderId = order.id || pending.paypalOrderId;
    pending.paypalCaptureId = capture.id;
    if (!pending.donorName || pending.donorName === 'Anonymous') {
      if (payer.name) pending.donorName = payer.name;
    }
    if (!pending.donorEmail && payer.email) pending.donorEmail = payer.email;
    db.write('donations', donations);
    return { created: true, donation: pending, reason: 'recorded' };
  }

  // No pending record — the webhook beat the browser back, or the record was
  // deleted. Build one from what PayPal knows so the money is never lost.
  const record = {
    id: capture.ref || `don_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    ref: capture.ref || '',
    gameId: '',
    gameTitle: '',
    gameSlug: '',
    donorName: payer.name || 'Anonymous',
    donorEmail: payer.email || '',
    amount: capture.amount,
    currency: capture.currency,
    message: '',
    isAnonymous: false,
    date: new Date().toISOString(),
    paymentMethod: 'paypal',
    provider: 'paypal',
    paypalOrderId: order.id || '',
    paypalCaptureId: capture.id,
    livemode: isLiveMode(),
    status: 'completed',
    orphaned: true,
  };
  donations.push(record);
  db.write('donations', donations);
  return { created: true, donation: record, reason: 'recorded-without-pending' };
}

/** Mark a donation failed (capture denied). Never deletes — keeps the audit trail. */
function markDonationFailed(ref, reason) {
  if (!ref) return false;
  const donations = db.read('donations', []);
  const rec = donations.find((d) => d.ref === ref);
  if (!rec || rec.status === 'completed') return false;
  rec.status = 'failed';
  rec.failureReason = reason || 'denied';
  db.write('donations', donations);
  return true;
}

/**
 * Mark a donation refunded so it stops counting toward the fundraiser total.
 * Matched on the capture id, which is what the refund event carries.
 */
function markDonationRefunded(captureId) {
  if (!captureId) return false;
  const donations = db.read('donations', []);
  const rec = donations.find((d) => d.paypalCaptureId === captureId);
  if (!rec) return false;
  rec.status = 'refunded';
  rec.refundedAt = new Date().toISOString();
  db.write('donations', donations);
  return true;
}

// ---- game purchases: same machinery, separate collection --------------------

function createPendingOrder(fields) {
  const orders = db.read('orders', []);
  const record = {
    id: fields.ref,
    ref: fields.ref,
    gameId: fields.gameId || '',
    gameTitle: fields.gameTitle || '',
    gameSlug: fields.gameSlug || '',
    buyerName: '',
    buyerEmail: '',
    amount: fields.amount,
    currency: CURRENCY,
    date: new Date().toISOString(),
    provider: 'paypal',
    paypalOrderId: '',
    paypalCaptureId: '',
    livemode: isLiveMode(),
    status: 'pending',
  };
  orders.push(record);
  db.write('orders', orders);
  return record;
}

function recordOrderFromCapture(order) {
  const capture = extractCapture(order);
  if (!capture) return { created: false, reason: 'no-capture-on-order' };
  if (capture.status !== 'COMPLETED') {
    return { created: false, reason: `capture not completed (status=${capture.status})` };
  }

  const orders = db.read('orders', []);
  const byCapture = orders.find((o) => o.paypalCaptureId === capture.id);
  if (byCapture) return { created: false, order: byCapture, reason: 'already-recorded' };

  const payer = extractPayer(order);
  const pending = capture.ref ? orders.find((o) => o.ref === capture.ref) : null;
  if (!pending) return { created: false, reason: 'no-pending-order' };
  if (pending.status === 'completed') return { created: false, order: pending, reason: 'already-recorded' };

  pending.amount = capture.amount;
  pending.currency = capture.currency;
  pending.status = 'completed';
  pending.date = new Date().toISOString();
  pending.paypalOrderId = order.id || '';
  pending.paypalCaptureId = capture.id;
  pending.buyerName = payer.name || '';
  pending.buyerEmail = payer.email || '';
  db.write('orders', orders);
  return { created: true, order: pending, reason: 'recorded' };
}

/** Is this reference id one of ours, and which collection does it belong to? */
function refKind(ref) {
  if (!ref) return null;
  if (ref.startsWith('don_')) return 'donation';
  if (ref.startsWith('ord_')) return 'purchase';
  return null;
}

/** One-line summary of the payment setup, printed at boot. */
function describeConfig() {
  if (!isConfigured()) {
    return {
      ready: false,
      mode: 'off',
      summary: 'NOT CONNECTED — no PayPal credentials. Donations and purchases are disabled.',
    };
  }
  const webhook = WEBHOOK_ID ? 'webhook OK' : 'NO WEBHOOK ID — abandoned approvals will be missed';
  return {
    ready: true,
    mode: ENV === 'live' ? 'live' : 'sandbox',
    summary: `PayPal connected (${ENV} mode, ${CURRENCY}) — ${webhook}`,
  };
}

module.exports = {
  MIN_AMOUNT,
  MAX_AMOUNT,
  isConfigured,
  isLiveMode,
  hasWebhookId,
  currency,
  apiBase,
  getAccessToken,
  parseAmount,
  toAmountString,
  isKnownMethod,
  methodLabel,
  landingPageFor,
  newRef,
  createOrder,
  getOrder,
  captureOrder,
  extractCapture,
  extractPayer,
  approveUrlFrom,
  verifyWebhook,
  createPendingDonation,
  recordDonationFromCapture,
  markDonationFailed,
  markDonationRefunded,
  createPendingOrder,
  recordOrderFromCapture,
  refKind,
  describeConfig,
};
