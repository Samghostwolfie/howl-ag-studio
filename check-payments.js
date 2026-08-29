// Checks your PayPal setup and tells you exactly what is wrong, if anything.
//
//   npm run check:payments
//
// Safe to run any time. It never prints your secret, and it never moves money —
// the only thing it asks PayPal for is an access token, which proves your
// credentials are real and match the environment you selected.

require('dotenv').config();

const ENV = (process.env.PAYPAL_ENV || 'sandbox').trim().toLowerCase();
const CLIENT_ID = (process.env.PAYPAL_CLIENT_ID || '').trim();
const CLIENT_SECRET = (process.env.PAYPAL_CLIENT_SECRET || '').trim();
const WEBHOOK_ID = (process.env.PAYPAL_WEBHOOK_ID || '').trim();
const CURRENCY = (process.env.PAYPAL_CURRENCY || 'USD').trim().toUpperCase();
const SITE_URL = (process.env.SITE_URL || '').trim();

const ok = (m) => console.log('  \x1b[32mOK\x1b[0m    ' + m);
const bad = (m) => console.log('  \x1b[31mPROBLEM\x1b[0m  ' + m);
const warn = (m) => console.log('  \x1b[33mNOTE\x1b[0m  ' + m);

function mask(v) {
  if (!v) return '(empty)';
  if (v.length <= 8) return v[0] + '***';
  return `${v.slice(0, 4)}...${v.slice(-4)}  (${v.length} chars)`;
}

console.log('\n  PayPal setup check');
console.log('  ==================\n');

let fatal = 0;

// ---- 1. environment --------------------------------------------------------
if (ENV === 'sandbox' || ENV === 'live') {
  ok(`PAYPAL_ENV is "${ENV}"`);
} else {
  bad(`PAYPAL_ENV is "${ENV}" — must be exactly "sandbox" or "live".`);
  fatal++;
}

// ---- 2. credentials present ------------------------------------------------
if (CLIENT_ID) ok(`PAYPAL_CLIENT_ID   ${mask(CLIENT_ID)}`);
else { bad('PAYPAL_CLIENT_ID is empty — paste it from developer.paypal.com'); fatal++; }

if (CLIENT_SECRET) ok(`PAYPAL_CLIENT_SECRET  ${mask(CLIENT_SECRET)}`);
else { bad('PAYPAL_CLIENT_SECRET is empty — paste it from developer.paypal.com'); fatal++; }

// A very common mistake: copying the key with surrounding quotes or spaces.
if (/^["']|["']$/.test(process.env.PAYPAL_CLIENT_ID || '')) {
  bad('PAYPAL_CLIENT_ID has quote marks around it. Remove them — .env needs no quotes.');
  fatal++;
}
if (/\s/.test(CLIENT_ID) || /\s/.test(CLIENT_SECRET)) {
  bad('A credential contains a space — you probably copied an extra character.');
  fatal++;
}

// ---- 3. webhook ------------------------------------------------------------
if (WEBHOOK_ID) {
  if (/^WH-/i.test(WEBHOOK_ID)) ok(`PAYPAL_WEBHOOK_ID  ${mask(WEBHOOK_ID)}`);
  else warn(`PAYPAL_WEBHOOK_ID is set but does not start with "WH-" — check you copied the Webhook ID, not the URL.`);
} else {
  warn('PAYPAL_WEBHOOK_ID is empty. Fine for a first local test, but before going');
  warn('      live you MUST set it — without it, a donor who approves the payment and');
  warn('      then closes the tab is never charged, and the donation is lost.');
}

// ---- 4. site url -----------------------------------------------------------
if (SITE_URL) {
  if (/\/$/.test(SITE_URL)) warn(`SITE_URL ends with a slash — remove it: ${SITE_URL}`);
  else ok(`SITE_URL is ${SITE_URL}`);
} else if (ENV === 'live') {
  bad('SITE_URL is empty but PAYPAL_ENV=live. Set it to your real domain.');
  fatal++;
} else {
  ok('SITE_URL is empty (fine for localhost testing)');
}

ok(`Currency is ${CURRENCY}`);

// ---- 5. actually talk to PayPal -------------------------------------------
(async () => {
  if (fatal) {
    console.log(`\n  ${fatal} problem(s) to fix before PayPal can be contacted.`);
    console.log('  Walkthrough: PAYMENTS-SETUP.md\n');
    process.exit(1);
  }

  const finish = (code) => { process.exitCode = code; };

  const base = ENV === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
  console.log(`\n  Contacting ${base} ...\n`);

  try {
    const res = await fetch(`${base}/v1/oauth2/token`, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    const text = await res.text();

    if (res.ok) {
      const data = JSON.parse(text);
      ok('PayPal accepted your credentials.');
      ok(`Access token received, valid for ${Math.round((data.expires_in || 0) / 60)} minutes.`);
      console.log('\n  \x1b[32mYour PayPal connection works.\x1b[0m');
      if (ENV === 'sandbox') {
        console.log('  You are in SANDBOX — no real money can move. Next: turn the');
        console.log('  fundraiser on in the admin panel and make a test donation.');
      } else {
        console.log('  \x1b[33mYou are in LIVE mode — real money will move.\x1b[0m');
      }
      console.log('');
      return finish(0);
    }

    bad(`PayPal rejected your credentials (HTTP ${res.status}).`);
    if (res.status === 401) {
      console.log('\n  That means the Client ID and Secret do not match, or they belong to');
      console.log(`  the other environment. You are set to "${ENV}", so make sure the`);
      console.log(`  Sandbox/Live toggle at developer.paypal.com was on ${ENV === 'live' ? 'LIVE' : 'SANDBOX'}`);
      console.log('  when you copied them. Sandbox and live credentials are NOT interchangeable.');
    } else {
      console.log('\n  PayPal said: ' + text.slice(0, 300));
    }
    console.log('');
    return finish(1);
  } catch (err) {
    bad('Could not reach PayPal at all: ' + err.message);
    console.log('\n  Check your internet connection, and any firewall or VPN.\n');
    return finish(1);
  }
})();
