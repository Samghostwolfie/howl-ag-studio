require('dotenv').config();

const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');
const path = require('path');
const fs = require('fs');
const slugify = require('slugify');

const db = require('./lib/db');
const { ensureAdmin, verifyLogin, updatePassword, requireAuth } = require('./lib/auth');
const {
  uploadCover, uploadScreenshots, uploadTeamPhoto, uploadBuild,
  handleUploadErrors, resolveUploadUrl, IMAGE_LIMIT_MB, USE_FIREBASE_STORAGE,
} = require('./lib/upload');

// Bumped whenever the server code changes — printed at boot and shown in the admin
// sidebar so you can instantly tell whether a stale process is still running.
const APP_VERSION = '3.0.0';
const { normalizeImageUrl, resolveVideo, linesToArray } = require('./lib/media');
const { normalizeEmailForDedup, isDisposableEmail, checkRateLimit } = require('./lib/spam');
const {
  PLATFORMS, SOURCES, COMMENT_MAX, parseDetails, enrich, buildStats,
} = require('./lib/wishlist');
const { parseFocus, readFocus, focusToCss } = require('./lib/focus');
const { sendWishlistConfirmation, sendDonationThankYou } = require('./lib/email');
const {
  parseDevlog, normalizeDevlog, parseVoice, normalizeVoice, toDateInput,
} = require('./lib/posts');
const {
  CATEGORIES, FEEDBACK_TOPICS, COMMENT_MAX: PUBLIC_COMMENT_MAX,
  voterKey, newVisitorId, parsePost, normalizePost, parseComment,
  parseFeedback, feedbackStats,
} = require('./lib/community');

const app = express();
const PORT = process.env.PORT || 3000;

// Behind a host's load balancer (Render, Fly, etc.) the real visitor IP arrives in
// X-Forwarded-For. Without this every visitor looks like the proxy, which would make
// the rate limits treat the whole internet as one person.
if (process.env.TRUST_PROXY !== 'off') app.set('trust proxy', 1);

// Where the admin panel lives. Set ADMIN_PATH to something unguessable in production
// so bots scanning for /admin find nothing. This is obscurity, not security — the
// password below is what actually protects it.
const ADMIN_PATH = (process.env.ADMIN_PATH || 'admin').replace(/^\/+|\/+$/g, '') || 'admin';
const A = `/${ADMIN_PATH}`;

// All PayPal wiring — credentials, orders, capture, webhook verification, and
// the one place donations are ever written — lives in lib/payments.js.
// See PAYMENTS-SETUP.md.
const payments = require('./lib/payments');

// ---------- view + core middleware ----------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ---------- PayPal webhook (MUST be mounted before the body parsers) ----------
// PayPal signs the exact bytes it sent. express.json() would parse and discard
// those bytes, so this one route takes the raw buffer and is registered ahead of
// the parsers below. Do not move it.
//
// This is what makes payments reliable rather than best-effort. Two cases the
// browser return alone cannot cover:
//
//   • The donor approves on paypal.com and then closes the tab. The order is
//     approved but NOT captured — no money has moved. CHECKOUT.ORDER.APPROVED
//     lets us capture it server-side instead of losing the donation.
//   • The donor pays but never makes it back to the site. PAYMENT.CAPTURE.COMPLETED
//     records it anyway.
app.post('/webhooks/paypal', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!payments.isConfigured() || !payments.hasWebhookId()) {
    return res.status(503).send('PayPal webhook is not configured on this server.');
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch (err) {
    return res.status(400).send('Webhook Error: body is not valid JSON.');
  }

  // Fails closed. If PayPal will not confirm it sent this, we do not act on it.
  let verified = false;
  try {
    verified = await payments.verifyWebhook(req.headers, event);
  } catch (err) {
    console.error('[paypal] Webhook verification call failed:', err.message);
    return res.status(400).send('Webhook Error: could not verify signature.');
  }
  if (!verified) {
    console.error(`[paypal] REJECTED unverified webhook (event type: ${event.event_type}).`);
    return res.status(400).send('Webhook Error: signature verification failed.');
  }

  const resource = event.resource || {};

  try {
    switch (event.event_type) {
      // Donor approved on paypal.com. Money has NOT moved yet — capture it.
      case 'CHECKOUT.ORDER.APPROVED': {
        const unit = (resource.purchase_units || [])[0] || {};
        const ref = unit.custom_id || unit.reference_id || '';
        const captured = await payments.captureOrder(resource.id, ref);
        recordCapture(captured, 'webhook');
        break;
      }

      // The money actually moved.
      case 'PAYMENT.CAPTURE.COMPLETED': {
        // A capture event is not a full order, so fetch the order it belongs to
        // and let the recorder work from the same shape as everywhere else.
        const orderLink = (resource.links || []).find((l) => l.rel === 'up');
        const orderId = orderLink ? orderLink.href.split('/').pop() : null;
        if (orderId) {
          recordCapture(await payments.getOrder(orderId), 'webhook');
        } else {
          console.warn(`[paypal] Capture ${resource.id} completed but its order could not be resolved.`);
        }
        break;
      }

      case 'PAYMENT.CAPTURE.DENIED': {
        const ref = resource.custom_id || '';
        payments.markDonationFailed(ref, 'PayPal denied the capture');
        console.warn(`[paypal] Capture DENIED for ${ref || resource.id}. Nothing counted.`);
        break;
      }

      // Refunds must stop counting toward the fundraiser total.
      case 'PAYMENT.CAPTURE.REFUNDED':
      case 'PAYMENT.CAPTURE.REVERSED': {
        const capLink = (resource.links || []).find((l) => l.rel === 'up');
        const capId = capLink ? capLink.href.split('/').pop() : '';
        if (payments.markDonationRefunded(capId)) {
          console.log(`[paypal] Donation for capture ${capId} marked refunded — removed from the fundraiser total.`);
        }
        break;
      }

      default:
        return res.json({ received: true, ignored: event.event_type });
    }
  } catch (err) {
    // Return 500 so PayPal retries. It re-delivers with backoff for up to three
    // days, so a transient failure here cannot lose a real payment.
    console.error(`[paypal] Failed handling ${event.event_type}:`, err.message);
    return res.status(500).send('Handling failed — please retry.');
  }

  return res.json({ received: true });
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// Read the Cookie header into req.cookies. This used to be the `cookie-parser`
// package; it's inlined here so the app needs nothing beyond what's already
// installed — one less thing that can go wrong on a fresh machine.
// (res.cookie() is built into Express, so only the reading half was ever missing.)
app.use((req, res, next) => {
  const header = req.headers.cookie;
  const jar = {};
  if (header) {
    header.split(';').forEach((pair) => {
      const eq = pair.indexOf('=');
      if (eq < 0) return;
      const key = pair.slice(0, eq).trim();
      if (!key) return;
      let val = pair.slice(eq + 1).trim();
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      try { jar[key] = decodeURIComponent(val); } catch (e) { jar[key] = val; }
    });
  }
  req.cookies = jar;
  next();
});

// Give every visitor a random id so a like can't be counted twice. It identifies
// nobody — it's a random string, not tied to any personal detail.
app.use((req, res, next) => {
  if (!req.cookies || !req.cookies.visitor) {
    const id = newVisitorId();
    res.cookie('visitor', id, {
      maxAge: 1000 * 60 * 60 * 24 * 365, httpOnly: true, sameSite: 'lax',
    });
    req.cookies = Object.assign({}, req.cookies, { visitor: id });
  }
  next();
});
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));
app.use(express.static(path.join(__dirname, 'public')));

const IS_PROD = process.env.NODE_ENV === 'production';

if (IS_PROD && !process.env.SESSION_SECRET) {
  console.warn('\n[security] SESSION_SECRET is not set. Anyone who knows the default can forge a login.');
  console.warn('           Set SESSION_SECRET to a long random string on your host.\n');
}

app.use(
  session({
    secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
    resave: false,
    saveUninitialized: false,
    name: 'howl.sid',
    cookie: {
      maxAge: 1000 * 60 * 60 * 24 * 7, // 7 days
      httpOnly: true,
      sameSite: 'lax',
      // Over HTTPS the cookie must never be sent in the clear. Off locally, where
      // there is no certificate, or the login would silently fail to stick.
      secure: IS_PROD,
    },
  })
);
app.use(flash());

// make common data available to every view
app.use((req, res, next) => {
  // Dynamic pages must never be served from the browser cache. Without this, a
  // like/comment POST redirects back to the same URL and the browser re-shows the
  // page it already had — so your vote looks like it did nothing. Static assets are
  // handled by express.static above and keep their normal caching.
  res.set('Cache-Control', 'no-store, must-revalidate');

  res.locals.studio = db.read('studio', {});
  // So the admin panel can report the real payment state instead of a badge
  // that always claims "Active".
  res.locals.paymentStatus = payments.describeConfig();
  res.locals.currentUser = req.session.userId
    ? db.read('admin', []).find((a) => a.id === req.session.userId)
    : null;
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.path = req.path;
  res.locals.appVersion = APP_VERSION;
  res.locals.imageLimitMb = IMAGE_LIMIT_MB;
  res.locals.wlPlatforms = PLATFORMS;
  res.locals.wlSources = SOURCES;
  res.locals.wlCommentMax = COMMENT_MAX;
  res.locals.publicCommentMax = PUBLIC_COMMENT_MAX;
  res.locals.newsCategories = CATEGORIES;
  res.locals.adminPath = A;
  // Make resolveUploadUrl available in all EJS templates
  res.locals.resolveUploadUrl = resolveUploadUrl;
  next();
});

// ---------- game status model ----------
// Wishlist is NOT a status — it's a per-game option (wishlistEnabled) that can be
// switched on for any stage of development.
const STATUSES = {
  development: 'In Development',
  prototype: 'Prototype',
  demo: 'Demo Available',
  released: 'Released',
  archived: 'Archived',
};

// Adds the derived fields the views rely on, and quietly migrates older records
// (the previous version used a "wishlist" status, which is now a flag).
function normalizeGame(g) {
  const legacyWishlistStatus = g.status === 'wishlist';
  const status = STATUSES[g.status] ? g.status : legacyWishlistStatus ? 'development' : 'development';

  const wishlistEnabled =
    typeof g.wishlistEnabled === 'boolean' ? g.wishlistEnabled : status !== 'released';

  // Pricing only ever applies to a finished, released game.
  const isReleased = status === 'released';
  const isDemo = status === 'demo';

  // Media gallery: videos first, then cover, then uploaded shots, then linked images.
  const media = [];
  const posterFor = g.coverImage ? resolveUploadUrl('covers', g.coverImage) : '';

  [g.trailerUrl, ...(g.videoLinks || [])].filter(Boolean).forEach((v) => {
    const resolved = resolveVideo(v);
    if (resolved) media.push({ type: 'video', mode: resolved.mode, src: resolved.src, poster: posterFor });
  });
  if (g.coverImage) media.push({ type: 'image', mode: 'image', src: posterFor });
  (g.screenshots || []).forEach((s) => media.push({ type: 'image', mode: 'image', src: resolveUploadUrl('screenshots', s) }));
  (g.imageLinks || []).forEach((u) => {
    const src = normalizeImageUrl(u);
    if (src) media.push({ type: 'image', mode: 'image', src });
  });

  const coverFocus = readFocus(g.coverFocus);

  let fStatus = g.fundraiserStatus;
  if (!fStatus) {
    fStatus = g.fundraiserEnabled ? 'open' : 'closed';
  }
  const fundraiserGoal = Math.max(0, Number(g.fundraiserGoal) || 0);
  const fStats = fundraiserStats(g.id, fundraiserGoal);
  const fundraiser = {
    status: fStatus,
    enabled: fStatus === 'open' || fStatus === 'warn',
    isOpen: fStatus === 'open',
    isWarn: fStatus === 'warn',
    goal: fundraiserGoal,
    title: g.fundraiserTitle || 'Development Fundraiser',
    pitch: g.fundraiserPitch || '',
    paypalUrl: (g.fundraiserPaypalUrl || '').trim(),
    ...fStats,
  };

  return {
    ...g,
    status,
    statusLabel: STATUSES[status],
    wishlistEnabled,
    isReleased,
    isDemo,
    showPrice: isReleased,
    fundraiser,
    tags: g.tags || [],
    screenshots: g.screenshots || [],
    imageLinks: g.imageLinks || [],
    videoLinks: g.videoLinks || [],
    coverFocus,
    coverPos: focusToCss(coverFocus),
    media,
  };
}

// ---------- helpers ----------
// Raw records straight off disk — use this for anything that writes.
function getGamesRaw() {
  return db.read('games', []);
}
// Display-ready records with derived fields — use this for rendering.
function getGames() {
  return getGamesRaw().map(normalizeGame);
}
function saveGames(games) {
  db.write('games', games);
}
function getWishlist() {
  return db.read('wishlist', []);
}
function wishlistCountFor(gameId) {
  return getWishlist().filter((w) => w.gameId === gameId).length;
}
function withCounts(games) {
  return games.map((g) => ({ ...g, wishlistCount: wishlistCountFor(g.id) }));
}

function getDonationsRaw() {
  return db.read('donations', []);
}
function getDonations() {
  return getDonationsRaw();
}
// Only money that actually arrived counts toward a fundraiser total. A record is
// 'completed' when PayPal confirmed the capture, or when you logged a real off-site
// contribution by hand in the admin panel. Anything else — a pending bank debit,
// an abandoned checkout — is kept for the record but never inflates the bar.
function donationsForGame(gameId) {
  return getDonations().filter((d) => d.gameId === gameId && d.status === 'completed');
}

// The single funnel every completed PayPal capture goes through, whether it
// arrived via the donor's browser or via the webhook. Figures out from our own
// reference id whether it was a donation or a game purchase, records it (the
// recorders are idempotent, so a double delivery does nothing), and sends the
// receipt exactly once — from whichever path got there first.
function recordCapture(order, source) {
  const capture = payments.extractCapture(order);
  const kind = payments.refKind(capture && capture.ref) || 'donation';

  if (kind === 'purchase') {
    const result = payments.recordOrderFromCapture(order);
    if (result.created) {
      console.log(`[paypal] Order recorded via ${source} — ${result.order.gameTitle} ${result.order.currency} ${result.order.amount}`);
    }
    return result;
  }

  const result = payments.recordDonationFromCapture(order);
  if (result.created) {
    const d = result.donation;
    console.log(`[paypal] Donation recorded via ${source} — ${d.currency} ${d.amount} for ${d.gameTitle || 'the studio'} from ${d.donorName}`);
    if (result.reason === 'recorded-without-pending') {
      console.warn(`[paypal] No pending record matched ref "${d.ref}" — recorded from PayPal's data alone. Check Admin → Donations.`);
    }
    sendDonationReceipt(d);
  }
  return result;
}

// Send a donor their receipt. Used by both the webhook and the browser return;
// whichever records the donation first is the one that sends the email, so nobody
// gets thanked twice for one contribution.
function sendDonationReceipt(donation) {
  if (!donation || !donation.donorEmail || !isValidEmail(donation.donorEmail)) return;
  const siteUrl = process.env.SITE_URL || '';
  const studio = db.read('studio', {});
  sendDonationThankYou({
    to: donation.donorEmail,
    donorName: donation.donorName,
    gameTitle: donation.gameTitle,
    amount: donation.amount,
    siteUrl,
    studioName: studio.name || 'Howl A/G Studio',
  }).catch((err) => console.error('[email] Donation thank-you error:', err.message));
}
function fundraiserStats(gameId, goalAmount) {
  const dons = donationsForGame(gameId);
  const totalRaised = dons.reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
  const goal = Math.max(0, Number(goalAmount) || 0);
  const percentFunded = goal > 0 ? Math.min(100, Math.round((totalRaised / goal) * 100)) : 0;
  const recentDonors = dons
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 50)
    .map((d) => ({
      name: d.isAnonymous ? 'Anonymous Supporter' : (d.donorName || 'Anonymous Supporter'),
      amount: Number(d.amount) || 0,
      message: d.message || '',
      date: d.date,
    }));
  return {
    totalRaised,
    goal,
    percentFunded,
    donorCount: dons.length,
    recentDonors,
  };
}

function uniqueSlug(title, excludeId) {
  const base = slugify(title, { lower: true, strict: true }) || 'game';
  const games = getGames();
  let slug = base;
  let i = 2;
  while (games.some((g) => g.slug === slug && g.id !== excludeId)) {
    slug = `${base}-${i++}`;
  }
  return slug;
}
function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// ---------- devlog + team voices ----------
function getDevlogRaw() {
  return db.read('devlog', []);
}
/** Newest first, with game + media resolved. Pass {all:true} to include drafts. */
function getDevlog(opts = {}) {
  const games = getGames();
  return getDevlogRaw()
    .filter((e) => (opts.all ? true : e.published !== false))
    .map((e) => normalizeDevlog(e, games))
    .sort((a, b) => new Date(b.date) - new Date(a.date) || String(b.id).localeCompare(String(a.id)));
}
function devlogForGame(gameId, opts = {}) {
  return getDevlog(opts).filter((e) => e.gameId === gameId);
}

function getVoicesRaw() {
  return db.read('voices', []);
}
function getVoices() {
  const games = getGames();
  return getVoicesRaw().map((v) => normalizeVoice(v, games));
}
function voicesForGame(gameId) {
  return getVoices().filter((v) => v.gameId === gameId);
}

// ---------- news / comments / reactions / feedback ----------
function getPostsRaw() { return db.read('news', []); }
function getComments() { return db.read('comments', []); }
function getReactions() { return db.read('reactions', []); }
function getFeedbackRaw() { return db.read('feedback', []); }

function getPosts(opts = {}) {
  const games = getGames();
  const comments = getComments();
  const reactions = getReactions();
  return getPostsRaw()
    .filter((p) => (opts.all ? true : p.published !== false))
    .map((p) => normalizePost(p, games, comments, reactions))
    .sort((a, b) => new Date(b.date) - new Date(a.date) || String(b.id).localeCompare(String(a.id)));
}

function feedbackForGame(gameId) {
  return getFeedbackRaw()
    .filter((f) => f.gameId === gameId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// =====================================================================
// PUBLIC SITE
// =====================================================================

app.get('/', (req, res) => {
  const games = withCounts(getGames());
  const featured = games.find((g) => g.status !== 'archived') || games[0] || null;
  const totalWishlist = getWishlist().length;
  res.render('index', { games, featured, totalWishlist, title: 'Home' });
});

app.get('/about', (req, res) => {
  res.render('about', { title: 'About Us' });
});

app.get('/team', (req, res) => {
  const team = db.read('team', []);
  res.render('team', { team, title: 'Our Team' });
});

app.get('/work', (req, res) => {
  const games = withCounts(getGames());
  res.render('work', { games, title: 'Our Work' });
});

app.get('/wishlist', (req, res) => {
  // Only games where the studio has switched the wishlist option on.
  const games = withCounts(getGames()).filter((g) => g.status !== 'archived' && g.wishlistEnabled);
  const totalWishlist = getWishlist().length;
  res.render('wishlist', { games, totalWishlist, title: 'Wishlist' });
});

// ---------- devlog (public) ----------
app.get('/devlog', (req, res) => {
  const entries = getDevlog();
  const games = getGames();

  // Optional ?game=slug filter, so a publisher can read one project's history.
  const filterSlug = (req.query.game || '').trim();
  const activeGame = filterSlug ? games.find((g) => g.slug === filterSlug) : null;
  const shown = activeGame ? entries.filter((e) => e.gameId === activeGame.id) : entries;

  // Only offer filters for games that actually have posts.
  const withPosts = games.filter((g) => entries.some((e) => e.gameId === g.id));

  res.render('devlog', {
    entries: shown, gamesWithPosts: withPosts, activeGame, title: 'Devlog',
  });
});

// A dedicated page per project, so "the devlog for this game" is a real place
// you can link to rather than a query string.
app.get('/devlog/game/:slug', (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  const entries = getDevlog();
  res.render('devlog', {
    entries: entries.filter((e) => e.gameId === game.id),
    gamesWithPosts: games.filter((g) => entries.some((e) => e.gameId === g.id)),
    activeGame: game,
    title: `${game.title} devlog`,
  });
});

app.get('/devlog/:id', (req, res) => {
  const entries = getDevlog();
  const entry = entries.find((e) => e.id === req.params.id);
  if (!entry) return res.status(404).render('404', { title: 'Not found' });
  const more = entries.filter((e) => e.id !== entry.id && e.gameId === entry.gameId).slice(0, 3);
  res.render('devlog-entry', { entry, more, title: entry.title });
});

// ---------- news / media (public) ----------
app.get('/news', (req, res) => {
  const posts = getPosts();
  const cat = (req.query.category || '').trim();
  const shown = CATEGORIES[cat] ? posts.filter((p) => p.category === cat) : posts;
  const usedCategories = Object.keys(CATEGORIES).filter((k) => posts.some((p) => p.category === k));
  res.render('news', {
    posts: shown, categories: CATEGORIES, usedCategories,
    activeCategory: CATEGORIES[cat] ? cat : '', title: 'News',
  });
});

app.get('/news/:id', (req, res) => {
  const post = getPosts().find((p) => p.id === req.params.id);
  if (!post) return res.status(404).render('404', { title: 'Not found' });
  res.render('news-entry', { post, myVote: myVoteFor(req, post.id), title: post.title });
});

function myVoteFor(req, postId) {
  const key = voterKey(req);
  const found = getReactions().find((r) => r.postId === postId && r.voter === key);
  return found ? found.value : 0;
}

app.post('/news/:id/comment', (req, res) => {
  const posts = getPostsRaw();
  const post = posts.find((p) => p.id === req.params.id);
  if (!post || post.published === false) return res.status(404).render('404', { title: 'Not found' });

  if (post.commentsOpen === false) {
    req.flash('error', 'Comments are closed on this post.');
    return res.redirect(`/news/${post.id}`);
  }

  const data = parseComment(req.body);
  if (!data.body) {
    req.flash('error', 'Write something before posting.');
    return res.redirect(`/news/${post.id}#comments`);
  }

  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (!checkRateLimit(`comment:${ip}`)) {
    req.flash('error', "You're posting very quickly — give it a minute and try again.");
    return res.redirect(`/news/${post.id}#comments`);
  }

  const comments = getComments();
  // Same person posting the identical text twice usually means a double-click.
  const dupe = comments.some(
    (c) => c.postId === post.id && c.voter === voterKey(req) && c.body === data.body
  );
  if (!dupe) {
    comments.push({
      id: `c_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
      postId: post.id,
      ...data,
      voter: voterKey(req),
      date: new Date().toISOString(),
      hidden: false,
    });
    db.write('comments', comments);
  }

  req.flash('success', 'Comment posted — thanks!');
  res.redirect(`/news/${post.id}#comments`);
});

app.post('/news/:id/react', (req, res) => {
  const post = getPostsRaw().find((p) => p.id === req.params.id);
  if (!post || post.published === false) return res.status(404).render('404', { title: 'Not found' });

  const value = req.body.value === 'up' ? 1 : req.body.value === 'down' ? -1 : 0;
  const key = voterKey(req);
  const reactions = getReactions();
  const existing = reactions.find((r) => r.postId === post.id && r.voter === key);

  if (!existing) {
    if (value) reactions.push({ postId: post.id, voter: key, value, date: new Date().toISOString() });
  } else if (existing.value === value) {
    // Clicking the same button again takes the vote back.
    reactions.splice(reactions.indexOf(existing), 1);
  } else {
    existing.value = value;
    existing.date = new Date().toISOString();
  }
  db.write('reactions', reactions);

  const mine = reactions.filter((r) => r.postId === post.id);
  const summary = {
    likes: mine.filter((r) => r.value === 1).length,
    dislikes: mine.filter((r) => r.value === -1).length,
    myVote: (mine.find((r) => r.voter === key) || {}).value || 0,
  };

  // The page updates in place when JS is on. Without it we fall back to a redirect —
  // and deliberately WITHOUT a #fragment: redirecting to a URL that differs only by
  // its fragment is treated as a same-page anchor jump, so the browser never refetches
  // and the new count never appears.
  if (req.xhr || (req.get('accept') || '').includes('application/json')) {
    return res.json(summary);
  }
  res.redirect(`/news/${post.id}`);
});

// ---------- per-game feedback (public) ----------
app.post('/games/:slug/feedback', (req, res) => {
  const game = getGames().find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  const data = parseFeedback({ ...req.body, gameId: game.id });
  if (!data.message) {
    req.flash('error', 'Tell us a little about what you think before sending.');
    return res.redirect(`/games/${game.slug}#feedback`);
  }
  if (data.canReply && data.email && !isValidEmail(data.email)) {
    req.flash('error', 'That email address does not look right.');
    return res.redirect(`/games/${game.slug}#feedback`);
  }

  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (!checkRateLimit(`feedback:${ip}`)) {
    req.flash('error', "You've sent a few already — give it a few minutes.");
    return res.redirect(`/games/${game.slug}#feedback`);
  }

  const all = getFeedbackRaw();
  all.push({
    id: `f_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    ...data,
    gameTitle: game.title,
    voter: voterKey(req),
    date: new Date().toISOString(),
  });
  db.write('feedback', all);

  req.flash('success', 'Thanks — feedback like this genuinely shapes the game.');
  res.redirect(`/games/${game.slug}#feedback`);
});

app.get('/games/:slug', (req, res) => {
  const games = withCounts(getGames());
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });
  const otherGames = games.filter((g) => g.id !== game.id && g.status !== 'archived').slice(0, 4);
  const fb = feedbackForGame(game.id);
  res.render('game', {
    game,
    otherGames,
    devlog: devlogForGame(game.id).slice(0, 3),
    devlogTotal: devlogForGame(game.id).length,
    voices: voicesForGame(game.id),
    feedbackTopics: FEEDBACK_TOPICS,
    feedbackStats: feedbackStats(fb),
    title: game.title,
  });
});

// Wishlist signup (used on both the game page and the dedicated wishlist page)
app.post('/games/:slug/wishlist', (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  if (!game.wishlistEnabled) {
    req.flash('error', 'Wishlisting is not open for this game.');
    return res.redirect(`/games/${game.slug}`);
  }

  const { email } = req.body;
  if (!isValidEmail(email)) {
    req.flash('error', 'Please enter a valid email address.');
    return res.redirect(req.get('Referer') || `/games/${game.slug}`);
  }

  // Soft rate-limit: a handful of signups per IP per 10 minutes is plenty for a
  // real visitor wishlisting a few games, but stops a script from hammering the form.
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || '';
  if (!checkRateLimit(ip)) {
    req.flash('error', "You're doing that a lot — please wait a few minutes and try again.");
    return res.redirect(req.get('Referer') || `/games/${game.slug}`);
  }

  const details = parseDetails(req.body);
  const normalized = normalizeEmailForDedup(email);
  const wishlist = getWishlist();
  const existing = wishlist.find(
    (w) => w.gameId === game.id && (w.normalizedEmail || normalizeEmailForDedup(w.email)) === normalized
  );

  if (existing) {
    // Someone (or something) trying the same email on the same game again. Rather than
    // silently dropping it, log it against the entry — a pile of repeat attempts is a
    // useful signal for you, even though it never inflates the public wishlist count.
    existing.duplicateAttempts = (existing.duplicateAttempts || 0) + 1;
    existing.lastAttemptAt = new Date().toISOString();
    // ...but if they filled in more about themselves this time, keep that. A returning
    // fan adding their name and a comment makes the record stronger, not spammier.
    const gained = enrich(existing, details);
    if (gained) existing.updatedAt = new Date().toISOString();
    db.write('wishlist', wishlist);
    req.flash('success', gained
      ? "You were already on the list — thanks, we've added your details!"
      : "You're already on the list — thanks for the love!");
    return res.redirect(req.get('Referer') || `/games/${game.slug}`);
  }

  wishlist.push({
    id: `w_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    gameId: game.id,
    gameTitle: game.title,
    email: email.trim(),
    normalizedEmail: normalized,
    ...details,
    date: new Date().toISOString(),
    updatedAt: null,
    ip,
    flagged: isDisposableEmail(email),
    duplicateAttempts: 0,
    lastAttemptAt: null,
  });
  db.write('wishlist', wishlist);

  const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const studioName = res.locals.studio && res.locals.studio.name ? res.locals.studio.name : 'Howl A/G Studio';
  sendWishlistConfirmation({
    to: email.trim(),
    name: details.name || '',
    gameTitle: game.title,
    gameSlug: game.slug,
    notifyNews: details.notifyNews,
    notifyDevlog: details.notifyDevlog,
    siteUrl,
    studioName,
  }).catch((err) => console.error('[email] Wishlist confirmation send error:', err.message));

  req.flash('success', `You're on the wishlist for ${game.title}! 🐺`);
  res.redirect(req.get('Referer') || `/games/${game.slug}`);
});

// ---------- fundraiser donation flow ----------
app.post('/games/:slug/donate', async (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  if (!game.fundraiser || !game.fundraiser.enabled || game.fundraiser.status === 'closed') {
    req.flash('error', 'Fundraising is not currently active for this game.');
    return res.redirect(`/games/${game.slug}`);
  }

  if (game.fundraiser.status === 'warn') {
    req.flash('error', 'Donations are currently on hold while the fundraiser system is under development.');
    return res.redirect(`/games/${game.slug}#fundraiser`);
  }

  const {
    donorName, donorEmail, amount, message, isAnonymous, paymentMethod,
  } = req.body;
  // Strict on purpose. The old code did Math.max(1, Number(amount) || 0), which
  // silently turned a typo into a $1 donation and made the check below dead code.
  const numAmount = payments.parseAmount(amount);
  if (numAmount === null) {
    req.flash('error', `Please enter a donation amount between $${payments.MIN_AMOUNT} and $${payments.MAX_AMOUNT.toLocaleString('en-US')}.`);
    return res.redirect(`/games/${game.slug}#fundraiser`);
  }

  const cleanName = (donorName || '').trim() || 'Anonymous';
  const cleanEmail = (donorEmail || '').trim();
  const cleanMsg = (message || '').trim().slice(0, 400);
  const anon = isAnonymous === 'on' || isAnonymous === 'true';
  const chosenMethod = payments.isKnownMethod(paymentMethod) ? paymentMethod : 'paypal';
  const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const studioName = res.locals.studio && res.locals.studio.name ? res.locals.studio.name : 'Howl A/G Studio';

  // No PayPal credentials means there is no way to take money. If a plain
  // PayPal.me / Ko-fi link is configured, send the donor there — that money goes
  // straight to your account, but this site never hears about it, so nothing is
  // recorded and you log it by hand in Admin → Donations once it lands.
  if (!payments.isConfigured()) {
    if (game.fundraiser.paypalUrl) return res.redirect(game.fundraiser.paypalUrl);
    console.error('[paypal] Donation attempted but PayPal credentials are not set. See PAYMENTS-SETUP.md.');
    req.flash('error', 'Donations are temporarily unavailable. Nothing has been charged — please try again shortly.');
    return res.redirect(`/games/${game.slug}#fundraiser`);
  }

  // Write the donor's details down BEFORE leaving for PayPal. PayPal's custom_id
  // field is only 127 characters — far too small to carry a name, email and
  // message — so all it carries is this reference id, and the record it points
  // at holds the rest. It stays 'pending' (and out of every total) until a real
  // capture completes.
  const ref = payments.newRef('don');
  payments.createPendingDonation({
    ref,
    gameId: game.id,
    gameTitle: game.title,
    gameSlug: game.slug,
    donorName: cleanName,
    donorEmail: cleanEmail,
    amount: numAmount,
    message: cleanMsg,
    isAnonymous: anon,
    paymentMethod: chosenMethod,
  });

  try {
    const order = await payments.createOrder({
      ref,
      amount: numAmount,
      method: chosenMethod,
      brandName: studioName,
      description: `${game.fundraiser.title || 'Development Fundraiser'} — ${game.title}`,
      returnUrl: `${siteUrl}/games/${game.slug}/donate/success?ref=${encodeURIComponent(ref)}`,
      cancelUrl: `${siteUrl}/games/${game.slug}/donate/cancel?ref=${encodeURIComponent(ref)}`,
    });

    if (!order.approveUrl) throw new Error('PayPal did not return an approval link.');
    return res.redirect(303, order.approveUrl);
  } catch (err) {
    // The donor never even reached PayPal, so nothing was charged. Mark the
    // pending record failed so it can't linger, and say so plainly.
    console.error('[paypal] Could not create donation order:', err.message);
    payments.markDonationFailed(ref, 'Order could not be created');
    req.flash('error', 'We could not reach PayPal just now. Nothing has been charged — please try again in a moment.');
    return res.redirect(`/games/${game.slug}#fundraiser`);
  }
});

app.get('/games/:slug/donate/success', async (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  // Where PayPal sends the donor back after they approve. This is the step that
  // actually captures the money, so it matters — but it is not the only one.
  // If the donor never makes it back here, the CHECKOUT.ORDER.APPROVED webhook
  // captures the same order instead. Both funnel through recordCapture, which is
  // idempotent, so whichever arrives first wins and the other is a no-op.
  //
  // Nothing here trusts the query string: the token names an order, and we ask
  // PayPal what that order's real state is.
  const orderId = req.query.token;
  let paid = false;

  if (orderId && payments.isConfigured()) {
    try {
      const captured = await payments.captureOrder(orderId, req.query.ref);
      const result = recordCapture(captured, 'browser return');
      paid = result.created || result.reason === 'already-recorded';
    } catch (err) {
      // The capture may still have gone through, or the webhook will retry it.
      // Don't tell the donor it failed when we simply don't know.
      console.error('[paypal] Could not capture order on return:', err.message);
    }
  }

  if (paid) {
    req.flash('success', `Thank you so much for backing ${game.title}! 🐺 Your donation was received.`);
  } else {
    req.flash('success', `Thanks for backing ${game.title}! 🐺 If PayPal takes a moment to confirm, your name will appear on the backer wall as soon as it does.`);
  }
  res.redirect(`/games/${game.slug}#fundraiser`);
});

// The donor backed out on PayPal's page. No money moved. Clear the pending
// record so it doesn't sit around looking like an unpaid obligation.
app.get('/games/:slug/donate/cancel', (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  if (req.query.ref) payments.markDonationFailed(req.query.ref, 'Cancelled by donor at PayPal');

  req.flash('error', 'Donation cancelled — nothing was charged.');
  res.redirect(`/games/${game.slug}#fundraiser`);
});

// Purchase / download flow — handles free vs paid, with graceful fallbacks.
app.get('/games/:slug/buy', async (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  // Demos are always a free download — no checkout, no price.
  if (game.isDemo) {
    if (game.downloadFile) return res.redirect(`/uploads/builds/${game.downloadFile}`);
    if (game.externalStoreUrl) return res.redirect(game.externalStoreUrl);
    req.flash('error', 'The demo download link is coming soon.');
    return res.redirect(`/games/${game.slug}`);
  }

  if (!game.isReleased) {
    req.flash('error', 'This game is not out yet — wishlist it to get notified!');
    return res.redirect(`/games/${game.slug}`);
  }

  // FREE games: direct download if we have a file, else external link, else nothing to do.
  if (game.pricingType === 'free') {
    if (game.downloadFile) return res.redirect(`/uploads/builds/${game.downloadFile}`);
    if (game.externalStoreUrl) return res.redirect(game.externalStoreUrl);
    req.flash('error', 'Download link coming soon.');
    return res.redirect(`/games/${game.slug}`);
  }

  // PAID games: use PayPal if configured, otherwise fall back to an external store link.
  if (payments.isConfigured()) {
    const priceAmount = payments.parseAmount(game.price);
    if (priceAmount === null) {
      console.error(`[paypal] "${game.title}" is marked paid but its price (${game.price}) is not a chargeable amount.`);
      req.flash('error', 'This game’s price isn’t set up correctly yet — please check back soon.');
      return res.redirect(`/games/${game.slug}`);
    }

    // The 'ord_' prefix is what tells recordCapture this is a purchase and not
    // a donation, so it never lands on the fundraiser progress bar.
    const ref = payments.newRef('ord');
    payments.createPendingOrder({
      ref, gameId: game.id, gameTitle: game.title, gameSlug: game.slug, amount: priceAmount,
    });

    try {
      const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
      const studioName = res.locals.studio && res.locals.studio.name ? res.locals.studio.name : 'Howl A/G Studio';
      const order = await payments.createOrder({
        ref,
        amount: priceAmount,
        method: 'paypal',
        brandName: studioName,
        description: game.tagline || game.title,
        returnUrl: `${siteUrl}/games/${game.slug}/buy/success?ref=${encodeURIComponent(ref)}`,
        cancelUrl: `${siteUrl}/games/${game.slug}?purchase=cancelled`,
      });

      if (!order.approveUrl) throw new Error('PayPal did not return an approval link.');
      return res.redirect(303, order.approveUrl);
    } catch (err) {
      // Don't silently hand over a paid game because checkout broke.
      console.error('[paypal] Could not create purchase order:', err.message);
      req.flash('error', 'We could not reach PayPal just now. Nothing has been charged — please try again in a moment.');
      return res.redirect(`/games/${game.slug}`);
    }
  }

  if (game.externalStoreUrl) return res.redirect(game.externalStoreUrl);

  req.flash('error', 'Checkout isn’t connected yet — add your PayPal credentials or a store link from the admin panel.');
  res.redirect(`/games/${game.slug}`);
});

// Where a paid buyer lands after Checkout. Records the order (idempotently — the
// webhook may have beaten us to it) and hands over the download.
app.get('/games/:slug/buy/success', async (req, res) => {
  const games = getGames();
  const game = games.find((g) => g.slug === req.params.slug);
  if (!game) return res.status(404).render('404', { title: 'Not found' });

  const orderId = req.query.token;
  let paid = false;

  if (orderId && payments.isConfigured()) {
    try {
      const captured = await payments.captureOrder(orderId, req.query.ref);
      const result = recordCapture(captured, 'browser return');
      paid = result.created || result.reason === 'already-recorded';
    } catch (err) {
      console.error('[paypal] Could not capture purchase on return:', err.message);
    }
  }

  if (!paid) {
    req.flash('error', 'We could not confirm that payment yet. If you were charged, your download link is on its way — contact us if it doesn’t arrive.');
    return res.redirect(`/games/${game.slug}`);
  }

  req.flash('success', `Thank you for buying ${game.title}! 🐺 Your download is starting.`);
  if (game.downloadFile) return res.redirect(`/uploads/builds/${game.downloadFile}`);
  if (game.externalStoreUrl) return res.redirect(game.externalStoreUrl);
  return res.redirect(`/games/${game.slug}`);
});

// =====================================================================
// ADMIN AUTH
// =====================================================================

app.get(`${A}/login`, (req, res) => {
  if (req.session.userId) return res.redirect(`${A}`);
  res.render('admin/login', { title: 'Admin Login', layout: false });
});

// Slow down password guessing. Five tries per IP per 15 minutes, then a cooldown —
// enough that a real person who forgot their password barely notices, but far too
// slow for anyone working through a wordlist.
const loginAttempts = new Map();
const LOGIN_MAX = 5;
const LOGIN_WINDOW = 15 * 60 * 1000;

function loginAllowed(ip) {
  const now = Date.now();
  const recent = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW);
  loginAttempts.set(ip, recent);
  if (loginAttempts.size > 2000) {
    for (const [k, v] of loginAttempts) if (!v.length) loginAttempts.delete(k);
  }
  return recent.length < LOGIN_MAX;
}
function noteFailedLogin(ip) {
  const list = loginAttempts.get(ip) || [];
  list.push(Date.now());
  loginAttempts.set(ip, list);
}

app.post(`${A}/login`, (req, res) => {
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';

  if (!loginAllowed(ip)) {
    console.warn(`[security] Too many failed logins from ${ip}`);
    req.flash('error', 'Too many attempts. Wait 15 minutes and try again.');
    return res.redirect(`${A}/login`);
  }

  const { username, password } = req.body;
  const account = verifyLogin(username, password);
  if (!account) {
    noteFailedLogin(ip);
    req.flash('error', 'Incorrect username or password.');
    return res.redirect(`${A}/login`);
  }

  loginAttempts.delete(ip);

  // Read this BEFORE regenerating — regenerate() throws the old session away,
  // returnTo included, so grabbing it afterwards would always come back empty.
  const dest = req.session.returnTo || A;

  // A fresh session id on login stops a pre-set cookie being reused as yours.
  return req.session.regenerate((err) => {
    if (err) {
      req.flash('error', 'Could not start a session. Try again.');
      return res.redirect(`${A}/login`);
    }
    req.session.userId = account.id;
    // Only ever bounce back to our own admin area, never to a URL someone supplied.
    res.redirect(String(dest).startsWith(A) ? dest : A);
  });
});

app.post(`${A}/logout`, (req, res) => {
  req.session.destroy(() => res.redirect(`${A}/login`));
});

// =====================================================================
// ADMIN / MODERATOR DASHBOARD
// =====================================================================

app.get(`${A}`, requireAuth, (req, res) => {
  const games = withCounts(getGames());
  const wishlist = getWishlist();
  const team = db.read('team', []);
  res.render('admin/dashboard', {
    title: 'Dashboard',
    layout: false,
    tab: 'overview',
    games,
    wishlist,
    team,
  });
});

app.get(`${A}/games`, requireAuth, (req, res) => {
  const games = withCounts(getGames());
  res.render('admin/dashboard', { title: 'Games', layout: false, tab: 'games', games, editingGame: null });
});

app.get(`${A}/games/new`, requireAuth, (req, res) => {
  const games = withCounts(getGames());
  res.render('admin/dashboard', { title: 'New Game', layout: false, tab: 'games', games, editingGame: {} });
});

app.get(`${A}/games/:id/edit`, requireAuth, (req, res) => {
  const games = withCounts(getGames());
  const editingGame = games.find((g) => g.id === req.params.id);
  if (!editingGame) {
    req.flash('error', 'Game not found.');
    return res.redirect(`${A}/games`);
  }
  res.render('admin/dashboard', { title: 'Edit Game', layout: false, tab: 'games', games, editingGame });
});

const gameMediaUpload = uploadCover.fields([{ name: 'cover', maxCount: 1 }]);

// A bad cover file must never lose the rest of the form silently.
const coverUploadOnCreate = handleUploadErrors(gameMediaUpload, `${A}/games/new`, 'covers');
const coverUploadOnEdit = handleUploadErrors(gameMediaUpload, (req) => `${A}/games/${req.params.id}/edit`, 'covers');

app.post(`${A}/games`, requireAuth, coverUploadOnCreate, (req, res) => {
  const games = getGamesRaw();
  const now = new Date().toISOString();
  const {
    title, tagline, description, genre, platforms, status,
    pricingType, price, externalStoreUrl, trailerUrl,
    releaseDate, developer, publisher, tags, features, sysMin, sysRec,
    imageLinks, videoLinks, wishlistEnabled, coverImage,
    fundraiserStatus, fundraiserEnabled, fundraiserGoal, fundraiserTitle, fundraiserPitch, fundraiserPaypalUrl,
  } = req.body;

  if (!title || !title.trim()) {
    req.flash('error', 'A game title is required.');
    return res.redirect(`${A}/games/new`);
  }

  const safeStatus = STATUSES[status] ? status : 'development';
  const isReleased = safeStatus === 'released';

  let finalCover = (coverImage || '').trim();
  if (req.files && req.files.cover) {
    finalCover = req.files.cover[0].filename;
  }

  const fStatus = ['open', 'warn', 'closed'].includes(fundraiserStatus)
    ? fundraiserStatus
    : (fundraiserEnabled === 'on' || fundraiserEnabled === 'true' ? 'open' : 'closed');

  const game = {
    id: `g_${Date.now()}`,
    slug: uniqueSlug(title),
    title: title.trim(),
    tagline: (tagline || '').trim(),
    description: (description || '').trim(),
    genre: (genre || '').trim(),
    platforms: (platforms || '').split(',').map((p) => p.trim()).filter(Boolean),
    status: safeStatus,
    // Pricing only applies once a game is actually released.
    pricingType: isReleased && pricingType === 'paid' ? 'paid' : 'free',
    price: isReleased && pricingType === 'paid' ? Math.max(0, Number(price) || 0) : 0,
    wishlistEnabled: wishlistEnabled === 'on' || wishlistEnabled === 'true',
    fundraiserStatus: fStatus,
    fundraiserEnabled: fStatus === 'open' || fStatus === 'warn',
    fundraiserGoal: Math.max(0, Number(fundraiserGoal) || 0),
    fundraiserTitle: (fundraiserTitle || '').trim(),
    fundraiserPitch: (fundraiserPitch || '').trim(),
    fundraiserPaypalUrl: (fundraiserPaypalUrl || '').trim(),
    externalStoreUrl: (externalStoreUrl || '').trim(),
    coverImage: finalCover,
    coverFocus: parseFocus(req.body, 'cover'),
    screenshots: [],
    imageLinks: linesToArray(imageLinks),
    videoLinks: linesToArray(videoLinks),
    trailerUrl: (trailerUrl || '').trim(),
    downloadFile: '',
    releaseDate: (releaseDate || '').trim(),
    developer: (developer || '').trim(),
    publisher: (publisher || '').trim(),
    tags: (tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    features: (features || '').trim(),
    sysMin: (sysMin || '').trim(),
    sysRec: (sysRec || '').trim(),
    createdAt: now,
    updatedAt: now,
  };

  games.push(game);
  saveGames(games);
  req.flash('success', `${game.title} was created.`);
  res.redirect(`${A}/games/${game.id}/edit`);
});

app.post(`${A}/games/:id`, requireAuth, coverUploadOnEdit, (req, res) => {
  const games = getGamesRaw();
  const game = games.find((g) => g.id === req.params.id);
  if (!game) {
    req.flash('error', 'Game not found.');
    return res.redirect(`${A}/games`);
  }

  const {
    title, tagline, description, genre, platforms, status,
    pricingType, price, externalStoreUrl, trailerUrl,
    releaseDate, developer, publisher, tags, features, sysMin, sysRec,
    imageLinks, videoLinks, wishlistEnabled, coverImage,
    fundraiserStatus, fundraiserEnabled, fundraiserGoal, fundraiserTitle, fundraiserPitch, fundraiserPaypalUrl,
  } = req.body;

  if (title && title.trim() && title.trim() !== game.title) {
    game.slug = uniqueSlug(title, game.id);
  }

  const safeStatus = STATUSES[status] ? status : game.status || 'development';
  const isReleased = safeStatus === 'released';

  const fStatusUpdate = ['open', 'warn', 'closed'].includes(fundraiserStatus)
    ? fundraiserStatus
    : (fundraiserEnabled === 'on' || fundraiserEnabled === 'true' ? 'open' : 'closed');

  Object.assign(game, {
    title: (title || game.title).trim(),
    tagline: (tagline || '').trim(),
    description: (description || '').trim(),
    genre: (genre || '').trim(),
    platforms: (platforms || '').split(',').map((p) => p.trim()).filter(Boolean),
    status: safeStatus,
    // Pricing only applies once a game is actually released.
    pricingType: isReleased && pricingType === 'paid' ? 'paid' : 'free',
    price: isReleased && pricingType === 'paid' ? Math.max(0, Number(price) || 0) : 0,
    wishlistEnabled: wishlistEnabled === 'on' || wishlistEnabled === 'true',
    fundraiserStatus: fStatusUpdate,
    fundraiserEnabled: fStatusUpdate === 'open' || fStatusUpdate === 'warn',
    fundraiserGoal: Math.max(0, Number(fundraiserGoal) || 0),
    fundraiserTitle: (fundraiserTitle || '').trim(),
    fundraiserPitch: (fundraiserPitch || '').trim(),
    fundraiserPaypalUrl: (fundraiserPaypalUrl || '').trim(),
    imageLinks: linesToArray(imageLinks),
    videoLinks: linesToArray(videoLinks),
    externalStoreUrl: (externalStoreUrl || '').trim(),
    trailerUrl: (trailerUrl || '').trim(),
    releaseDate: (releaseDate || '').trim(),
    developer: (developer || '').trim(),
    publisher: (publisher || '').trim(),
    tags: (tags || '').split(',').map((t) => t.trim()).filter(Boolean),
    features: (features || '').trim(),
    sysMin: (sysMin || '').trim(),
    sysRec: (sysRec || '').trim(),
    updatedAt: new Date().toISOString(),
  });

  if (typeof coverImage === 'string' && coverImage.trim()) {
    game.coverImage = coverImage.trim();
  }

  game.coverFocus = parseFocus(req.body, 'cover');

  if (req.files && req.files.cover) {
    game.coverImage = req.files.cover[0].filename;
    // New artwork means the old framing no longer describes anything — re-centre.
    game.coverFocus = { x: 50, y: 50 };
  }

  saveGames(games);
  req.flash('success', `${game.title} was updated.`);
  res.redirect(`${A}/games/${game.id}/edit`);
});

app.post(`${A}/games/:id/screenshots`, requireAuth,
  handleUploadErrors(uploadScreenshots.array('screenshots', 24), (req) => `${A}/games/${req.params.id}/edit`, 'screenshots'),
  (req, res) => {
  const games = getGamesRaw();
  const game = games.find((g) => g.id === req.params.id);
  if (!game) {
    req.flash('error', 'Game not found.');
    return res.redirect(`${A}/games`);
  }
  const newFiles = (req.files || []).map((f) => f.filename);
  game.screenshots = [...(game.screenshots || []), ...newFiles];
  game.updatedAt = new Date().toISOString();
  saveGames(games);
  req.flash('success', `Added ${newFiles.length} screenshot(s).`);
  res.redirect(`${A}/games/${game.id}/edit`);
});

app.post(`${A}/games/:id/screenshots/:filename/delete`, requireAuth, (req, res) => {
  const games = getGamesRaw();
  const game = games.find((g) => g.id === req.params.id);
  if (game) {
    game.screenshots = (game.screenshots || []).filter((s) => s !== req.params.filename);
    saveGames(games);
    const filePath = path.join(__dirname, 'public', 'uploads', 'screenshots', req.params.filename);
    fs.unlink(filePath, () => {});
  }
  res.redirect(`${A}/games/${req.params.id}/edit`);
});

app.post(`${A}/games/:id/build`, requireAuth,
  handleUploadErrors(uploadBuild.single('build'), (req) => `${A}/games/${req.params.id}/edit`, 'builds'),
  (req, res) => {
  const games = getGamesRaw();
  const game = games.find((g) => g.id === req.params.id);
  if (!game) {
    req.flash('error', 'Game not found.');
    return res.redirect(`${A}/games`);
  }
  if (req.file) {
    game.downloadFile = req.file.filename;
    game.updatedAt = new Date().toISOString();
    saveGames(games);
    req.flash('success', 'Build file uploaded.');
  }
  res.redirect(`${A}/games/${game.id}/edit`);
});

app.post(`${A}/games/:id/delete`, requireAuth, (req, res) => {
  let games = getGamesRaw();
  games = games.filter((g) => g.id !== req.params.id);
  saveGames(games);
  req.flash('success', 'Game deleted.');
  res.redirect(`${A}/games`);
});

// ---------- team ----------
app.get(`${A}/team`, requireAuth, (req, res) => {
  const team = db.read('team', []);
  res.render('admin/dashboard', { title: 'Team', layout: false, tab: 'team', team, editingMember: null });
});

app.get(`${A}/team/:id/edit`, requireAuth, (req, res) => {
  const team = db.read('team', []);
  const member = team.find((t) => t.id === req.params.id);
  if (!member) {
    req.flash('error', 'That team member no longer exists.');
    return res.redirect(`${A}/team`);
  }
  res.render('admin/dashboard', {
    title: member.name, layout: false, tab: 'team', team, editingMember: member,
  });
});

app.post(`${A}/team`, requireAuth, (req, res) => {
  const team = db.read('team', []);
  const { name, role, bio, x, linkedin, itch, photo } = req.body;
  if (!name || !name.trim()) {
    req.flash('error', 'Name is required.');
    return res.redirect(`${A}/team`);
  }
  const id = `t_${Date.now()}`;
  team.push({
    id,
    name: name.trim(),
    role: (role || '').trim(),
    bio: (bio || '').trim(),
    photo: (photo || '').trim(),
    photoFocus: parseFocus(req.body),
    socials: { x: (x || '').trim(), linkedin: (linkedin || '').trim(), itch: (itch || '').trim() },
  });
  db.write('team', team);
  if (photo && photo.trim()) {
    req.flash('success', 'Team member added. Drag the marker to frame their photo.');
    return res.redirect(`${A}/team/${id}/edit`);
  }
  req.flash('success', 'Team member added.');
  res.redirect(`${A}/team`);
});

app.post(`${A}/team/:id`, requireAuth, (req, res) => {
  const team = db.read('team', []);
  const member = team.find((t) => t.id === req.params.id);
  if (!member) {
    req.flash('error', 'That team member no longer exists.');
    return res.redirect(`${A}/team`);
  }

  const { name, role, bio, x, linkedin, itch, photo } = req.body;
  if (!name || !name.trim()) {
    req.flash('error', 'Name is required.');
    return res.redirect(`${A}/team/${req.params.id}/edit`);
  }

  member.name = name.trim();
  member.role = (role || '').trim();
  member.bio = (bio || '').trim();
  member.socials = { x: (x || '').trim(), linkedin: (linkedin || '').trim(), itch: (itch || '').trim() };
  if (typeof photo === 'string') {
    member.photo = photo.trim();
  }
  member.photoFocus = parseFocus(req.body);

  db.write('team', team);
  req.flash('success', `${member.name} updated.`);
  res.redirect(`${A}/team/${member.id}/edit`);
});

app.post(`${A}/team/:id/delete`, requireAuth, (req, res) => {
  let team = db.read('team', []);
  team = team.filter((t) => t.id !== req.params.id);
  db.write('team', team);
  req.flash('success', 'Team member removed.');
  res.redirect(`${A}/team`);
});

// ---------- devlog (admin) ----------
app.get(`${A}/devlog`, requireAuth, (req, res) => {
  res.render('admin/dashboard', {
    title: 'Devlog', layout: false, tab: 'devlog',
    entries: getDevlog({ all: true }), games: getGames(), editingEntry: null,
  });
});

app.get(`${A}/devlog/new`, requireAuth, (req, res) => {
  res.render('admin/dashboard', {
    title: 'New post', layout: false, tab: 'devlog',
    entries: getDevlog({ all: true }), games: getGames(),
    editingEntry: { date: toDateInput(), published: true, gameId: req.query.game || '' },
  });
});

app.get(`${A}/devlog/:id/edit`, requireAuth, (req, res) => {
  const entry = getDevlogRaw().find((e) => e.id === req.params.id);
  if (!entry) {
    req.flash('error', 'That post no longer exists.');
    return res.redirect(`${A}/devlog`);
  }
  res.render('admin/dashboard', {
    title: entry.title, layout: false, tab: 'devlog',
    entries: getDevlog({ all: true }), games: getGames(),
    editingEntry: { ...entry, date: toDateInput(entry.date) },
  });
});

app.post(`${A}/devlog`, requireAuth, (req, res) => {
  const data = parseDevlog(req.body);
  if (!data.title) {
    req.flash('error', 'Give the post a title.');
    return res.redirect(`${A}/devlog/new`);
  }
  if (!data.gameId) {
    req.flash('error', 'Pick which game this post is about.');
    return res.redirect(`${A}/devlog/new`);
  }

  const entries = getDevlogRaw();
  const game = getGames().find((g) => g.id === data.gameId);
  const id = `d_${Date.now()}`;
  entries.push({
    id,
    ...data,
    gameTitle: game ? game.title : '',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  db.write('devlog', entries);
  req.flash('success', data.published ? 'Post published.' : 'Draft saved.');
  res.redirect(`${A}/devlog/${id}/edit`);
});

app.post(`${A}/devlog/:id`, requireAuth, (req, res) => {
  const entries = getDevlogRaw();
  const entry = entries.find((e) => e.id === req.params.id);
  if (!entry) {
    req.flash('error', 'That post no longer exists.');
    return res.redirect(`${A}/devlog`);
  }
  const data = parseDevlog(req.body);
  if (!data.title) {
    req.flash('error', 'Give the post a title.');
    return res.redirect(`${A}/devlog/${entry.id}/edit`);
  }
  const game = getGames().find((g) => g.id === data.gameId);
  Object.assign(entry, data, {
    gameTitle: game ? game.title : entry.gameTitle,
    updatedAt: new Date().toISOString(),
  });
  db.write('devlog', entries);
  req.flash('success', 'Post updated.');
  res.redirect(`${A}/devlog/${entry.id}/edit`);
});

app.post(`${A}/devlog/:id/delete`, requireAuth, (req, res) => {
  const entries = getDevlogRaw().filter((e) => e.id !== req.params.id);
  db.write('devlog', entries);
  req.flash('success', 'Post deleted.');
  res.redirect(`${A}/devlog`);
});

// ---------- team voices (admin) ----------
app.get(`${A}/voices`, requireAuth, (req, res) => {
  res.render('admin/dashboard', {
    title: 'Team voices', layout: false, tab: 'voices',
    voices: getVoices(), games: getGames(), team: db.read('team', []), editingVoice: null,
  });
});

app.get(`${A}/voices/new`, requireAuth, (req, res) => {
  res.render('admin/dashboard', {
    title: 'New voice', layout: false, tab: 'voices',
    voices: getVoices(), games: getGames(), team: db.read('team', []),
    editingVoice: { gameId: req.query.game || '' },
  });
});

app.get(`${A}/voices/:id/edit`, requireAuth, (req, res) => {
  const voice = getVoicesRaw().find((v) => v.id === req.params.id);
  if (!voice) {
    req.flash('error', 'That entry no longer exists.');
    return res.redirect(`${A}/voices`);
  }
  res.render('admin/dashboard', {
    title: voice.name, layout: false, tab: 'voices',
    voices: getVoices(), games: getGames(), team: db.read('team', []), editingVoice: voice,
  });
});

app.post(`${A}/voices`, requireAuth, (req, res) => {
  const data = parseVoice(req.body);
  if (!data.name) {
    req.flash('error', 'Whose voice is this? Add a name.');
    return res.redirect(`${A}/voices/new`);
  }
  if (!data.gameId) {
    req.flash('error', 'Pick which game this is about.');
    return res.redirect(`${A}/voices/new`);
  }

  const voices = getVoicesRaw();
  const game = getGames().find((g) => g.id === data.gameId);
  const id = `v_${Date.now()}`;
  voices.push({
    id, ...data,
    gameTitle: game ? game.title : '',
    createdAt: new Date().toISOString(),
  });
  db.write('voices', voices);
  req.flash('success', `${data.name}'s clip added.`);
  res.redirect(`${A}/voices`);
});

app.post(`${A}/voices/:id`, requireAuth, (req, res) => {
  const voices = getVoicesRaw();
  const voice = voices.find((v) => v.id === req.params.id);
  if (!voice) {
    req.flash('error', 'That entry no longer exists.');
    return res.redirect(`${A}/voices`);
  }
  const data = parseVoice(req.body);
  if (!data.name) {
    req.flash('error', 'Whose voice is this? Add a name.');
    return res.redirect(`${A}/voices/${voice.id}/edit`);
  }
  const game = getGames().find((g) => g.id === data.gameId);
  Object.assign(voice, data, { gameTitle: game ? game.title : voice.gameTitle });
  db.write('voices', voices);
  req.flash('success', 'Entry updated.');
  res.redirect(`${A}/voices`);
});

app.post(`${A}/voices/:id/delete`, requireAuth, (req, res) => {
  db.write('voices', getVoicesRaw().filter((v) => v.id !== req.params.id));
  req.flash('success', 'Entry removed.');
  res.redirect(`${A}/voices`);
});

// ---------- news (admin) ----------
app.get(`${A}/news`, requireAuth, (req, res) => {
  res.render('admin/dashboard', {
    title: 'News', layout: false, tab: 'news',
    posts: getPosts({ all: true }), games: getGames(), categories: CATEGORIES,
    comments: getComments(), editingPost: null,
  });
});

app.get(`${A}/news/new`, requireAuth, (req, res) => {
  res.render('admin/dashboard', {
    title: 'New post', layout: false, tab: 'news',
    posts: getPosts({ all: true }), games: getGames(), categories: CATEGORIES,
    comments: getComments(),
    editingPost: {
      date: new Date().toISOString().slice(0, 10),
      published: true, commentsOpen: true, category: 'news',
    },
  });
});

app.get(`${A}/news/:id/edit`, requireAuth, (req, res) => {
  const post = getPostsRaw().find((p) => p.id === req.params.id);
  if (!post) {
    req.flash('error', 'That post no longer exists.');
    return res.redirect(`${A}/news`);
  }
  res.render('admin/dashboard', {
    title: post.title, layout: false, tab: 'news',
    posts: getPosts({ all: true }), games: getGames(), categories: CATEGORIES,
    comments: getComments(), editingPost: post,
  });
});

app.post(`${A}/news`, requireAuth, (req, res) => {
  const data = parsePost(req.body);
  if (!data.title) {
    req.flash('error', 'Give the post a title.');
    return res.redirect(`${A}/news/new`);
  }
  const posts = getPostsRaw();
  const id = `n_${Date.now()}`;
  posts.push({ id, ...data, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  db.write('news', posts);
  req.flash('success', data.published ? 'Post published.' : 'Draft saved.');
  res.redirect(`${A}/news/${id}/edit`);
});

app.post(`${A}/news/:id`, requireAuth, (req, res) => {
  const posts = getPostsRaw();
  const post = posts.find((p) => p.id === req.params.id);
  if (!post) {
    req.flash('error', 'That post no longer exists.');
    return res.redirect(`${A}/news`);
  }
  const data = parsePost(req.body);
  if (!data.title) {
    req.flash('error', 'Give the post a title.');
    return res.redirect(`${A}/news/${post.id}/edit`);
  }
  Object.assign(post, data, { updatedAt: new Date().toISOString() });
  db.write('news', posts);
  req.flash('success', 'Post updated.');
  res.redirect(`${A}/news/${post.id}/edit`);
});

app.post(`${A}/news/:id/delete`, requireAuth, (req, res) => {
  db.write('news', getPostsRaw().filter((p) => p.id !== req.params.id));
  // Orphaned comments and votes would otherwise linger forever.
  db.write('comments', getComments().filter((c) => c.postId !== req.params.id));
  db.write('reactions', getReactions().filter((r) => r.postId !== req.params.id));
  req.flash('success', 'Post and its comments deleted.');
  res.redirect(`${A}/news`);
});

// ---------- comment moderation ----------
app.get(`${A}/comments`, requireAuth, (req, res) => {
  const posts = getPosts({ all: true });
  const comments = getComments()
    .slice()
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .map((c) => ({ ...c, post: posts.find((p) => p.id === c.postId) || null }));
  res.render('admin/dashboard', {
    title: 'Comments', layout: false, tab: 'comments', comments, posts,
  });
});

app.post(`${A}/comments/:id/hide`, requireAuth, (req, res) => {
  const comments = getComments();
  const c = comments.find((x) => x.id === req.params.id);
  if (c) {
    c.hidden = !c.hidden;
    db.write('comments', comments);
    req.flash('success', c.hidden ? 'Comment hidden from the site.' : 'Comment restored.');
  }
  res.redirect(`${A}/comments`);
});

app.post(`${A}/comments/:id/delete`, requireAuth, (req, res) => {
  db.write('comments', getComments().filter((c) => c.id !== req.params.id));
  req.flash('success', 'Comment deleted.');
  res.redirect(`${A}/comments`);
});

// ---------- feedback (admin) ----------
app.get(`${A}/feedback`, requireAuth, (req, res) => {
  const games = getGames();
  const all = getFeedbackRaw().slice().sort((a, b) => new Date(b.date) - new Date(a.date));

  const groups = games
    .map((g) => {
      const items = all.filter((f) => f.gameId === g.id);
      return { game: g, items, stats: feedbackStats(items) };
    })
    .filter((grp) => grp.items.length)
    .sort((a, b) => b.items.length - a.items.length);

  res.render('admin/dashboard', {
    title: 'Feedback', layout: false, tab: 'feedback',
    groups, overall: feedbackStats(all), games,
  });
});

app.post(`${A}/feedback/:id/delete`, requireAuth, (req, res) => {
  db.write('feedback', getFeedbackRaw().filter((f) => f.id !== req.params.id));
  req.flash('success', 'Feedback removed.');
  res.redirect(`${A}/feedback`);
});

app.get(`${A}/feedback/export.csv`, requireAuth, (req, res) => {
  const all = getFeedbackRaw();
  const cols = [
    ['game', (f) => f.gameTitle], ['name', (f) => f.name], ['email', (f) => f.email],
    ['topic', (f) => f.topic], ['rating', (f) => f.rating || ''],
    ['message', (f) => f.message], ['ok_to_reply', (f) => (f.canReply ? 'yes' : 'no')],
    ['sent', (f) => f.date],
  ];
  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="feedback.csv"');
  res.send(`${cols.map(([n]) => n).join(',')}\n${all.map((f) => cols.map(([, g]) => esc(g(f))).join(',')).join('\n')}`);
});

// ---------- wishlist / export ----------
app.get(`${A}/wishlist`, requireAuth, (req, res) => {
  const wishlist = getWishlist();
  const games = getGames();

  // Group signups by game — "for the specific game itself", not one flat mixed list —
  // newest signup first inside each group.
  const byGame = new Map();
  wishlist.forEach((w) => {
    if (!byGame.has(w.gameId)) byGame.set(w.gameId, []);
    byGame.get(w.gameId).push(w);
  });

  const groups = Array.from(byGame.entries()).map(([gameId, entries]) => {
    const game = games.find((g) => g.id === gameId);
    const sorted = entries.slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    return {
      game: game || { id: gameId, title: entries[0].gameTitle || 'Deleted game', slug: null, statusLabel: 'Removed', wishlistEnabled: false },
      orphaned: !game,
      entries: sorted,
      count: sorted.length,
      duplicateAttempts: sorted.reduce((sum, w) => sum + (w.duplicateAttempts || 0), 0),
      flaggedCount: sorted.filter((w) => w.flagged).length,
      stats: buildStats(sorted),
      newestDate: sorted[0] ? sorted[0].date : null,
    };
  });

  // Also surface games that have the wishlist option open but zero signups yet —
  // useful to see at a glance which games have no traction, not just the ones that do.
  games.forEach((g) => {
    if (g.wishlistEnabled && !byGame.has(g.id)) {
      groups.push({
        game: g, entries: [], count: 0, duplicateAttempts: 0, flaggedCount: 0,
        stats: buildStats([]), newestDate: null,
      });
    }
  });

  groups.sort((a, b) => b.count - a.count);

  res.render('admin/dashboard', {
    title: 'Wishlist', layout: false, tab: 'wishlist',
    wishlist, groups, overall: buildStats(wishlist), games,
  });
});

// Delete one signup — e.g. a test entry or an obviously fake/flagged address.
app.post(`${A}/wishlist/:id/delete`, requireAuth, (req, res) => {
  const wishlist = getWishlist();
  const next = wishlist.filter((w) => w.id !== req.params.id);
  if (next.length === wishlist.length) {
    req.flash('error', 'That signup was already removed.');
  } else {
    db.write('wishlist', next);
    req.flash('success', 'Signup removed.');
  }
  res.redirect(`${A}/wishlist`);
});

// Clear every signup for one game in a single click — handy for wiping out test data,
// or clearing out a group left behind by a game that was later deleted.
app.post(`${A}/wishlist/game/:gameId/delete`, requireAuth, (req, res) => {
  const wishlist = getWishlist();
  const next = wishlist.filter((w) => w.gameId !== req.params.gameId);
  const removed = wishlist.length - next.length;
  db.write('wishlist', next);
  req.flash('success', removed === 1 ? '1 signup removed.' : `${removed} signups removed.`);
  res.redirect(`${A}/wishlist`);
});

// ---------- fundraisers & donations (admin) ----------
app.get(`${A}/donations`, requireAuth, (req, res) => {
  const donations = getDonationsRaw().slice().sort((a, b) => new Date(b.date) - new Date(a.date));
  const games = getGames();
  // Totals must match the public progress bars: only money that actually
  // arrived. Pending, failed, cancelled and refunded records are still listed
  // below so you can see what happened, they just don't count.
  const counts = (d) => d.status === 'completed';
  const totalRaised = donations.filter(counts).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);

  const byGame = games.map((g) => {
    const gameDons = donations.filter((d) => d.gameId === g.id);
    const raised = gameDons.filter(counts).reduce((sum, d) => sum + (Number(d.amount) || 0), 0);
    return {
      game: g,
      donations: gameDons,
      raised,
      goal: g.fundraiser ? g.fundraiser.goal : 0,
      percent: g.fundraiser && g.fundraiser.goal > 0 ? Math.min(100, Math.round((raised / g.fundraiser.goal) * 100)) : 0,
      count: gameDons.length,
    };
  });

  res.render('admin/dashboard', {
    title: 'Fundraisers & Donations',
    layout: false,
    tab: 'donations',
    donations,
    games,
    byGame,
    totalRaised,
  });
});

app.post(`${A}/donations`, requireAuth, (req, res) => {
  const { gameId, donorName, donorEmail, amount, message, isAnonymous, paymentMethod } = req.body;
  const games = getGames();
  const game = games.find((g) => g.id === gameId);
  const numAmount = Math.max(0.01, Number(amount) || 0);

  const donations = getDonationsRaw();
  donations.push({
    id: `don_${Date.now()}_${Math.round(Math.random() * 1e6)}`,
    gameId: game ? game.id : (gameId || ''),
    gameTitle: game ? game.title : 'Studio Project Fund',
    donorName: (donorName || 'Anonymous').trim(),
    donorEmail: (donorEmail || '').trim(),
    amount: numAmount,
    message: (message || '').trim(),
    isAnonymous: isAnonymous === 'on' || isAnonymous === 'true',
    date: new Date().toISOString(),
    paymentMethod: paymentMethod || 'manual',
    status: 'completed',
  });
  db.write('donations', donations);
  req.flash('success', 'Donation logged successfully.');
  res.redirect(`${A}/donations`);
});

app.post(`${A}/donations/:id/delete`, requireAuth, (req, res) => {
  let donations = getDonationsRaw();
  donations = donations.filter((d) => d.id !== req.params.id);
  db.write('donations', donations);
  req.flash('success', 'Donation entry removed.');
  res.redirect(`${A}/donations`);
});

// A per-game page written to be shown to (or printed for) a publisher. It deliberately
// states what the numbers do and do NOT prove — overstating it would be the fastest way
// to lose a publisher's trust.
app.get(`${A}/wishlist/game/:gameId/report`, requireAuth, (req, res) => {
  const entries = getWishlist()
    .filter((w) => w.gameId === req.params.gameId)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
  const game = getGames().find((g) => g.id === req.params.gameId);

  if (!game && !entries.length) {
    req.flash('error', 'No wishlist data for that game.');
    return res.redirect(`${A}/wishlist`);
  }

  res.render('admin/wishlist-report', {
    title: 'Publisher report',
    layout: false,
    game: game || { id: req.params.gameId, title: entries[0].gameTitle || 'Deleted game', statusLabel: 'Removed' },
    entries,
    stats: buildStats(entries),
    generatedAt: new Date(),
  });
});

app.get(`${A}/wishlist/export.csv`, requireAuth, (req, res) => {
  let wishlist = getWishlist();
  let filename = 'wishlist.csv';

  if (req.query.game) {
    wishlist = wishlist.filter((w) => w.gameId === req.query.game);
    const g = getGames().find((x) => x.id === req.query.game);
    filename = `wishlist-${(g ? g.slug : req.query.game)}.csv`;
  }

  const cols = [
    ['email', (w) => w.email],
    ['name', (w) => w.name],
    ['game', (w) => w.gameTitle],
    ['country', (w) => w.country],
    ['platform', (w) => w.platform],
    ['heard_about_us_via', (w) => w.source],
    ['comment', (w) => w.comment],
    ['ok_to_contact', (w) => (w.contactConsent ? 'yes' : 'no')],
    ['signed_up', (w) => w.date],
    ['details_added', (w) => w.updatedAt],
    ['repeat_attempts', (w) => w.duplicateAttempts || 0],
    ['flagged_disposable', (w) => (w.flagged ? 'yes' : 'no')],
  ];

  const esc = (v) => `"${String(v === undefined || v === null ? '' : v).replace(/"/g, '""')}"`;
  const body = wishlist.map((w) => cols.map(([, get]) => esc(get(w))).join(',')).join('\n');

  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`${cols.map(([name]) => name).join(',')}\n${body}`);
});

// ---------- settings ----------
app.get(`${A}/settings`, requireAuth, (req, res) => {
  const studio = db.read('studio', {});
  const emailConfigured = Boolean(require('./lib/email').getTransporter());
  res.render('admin/dashboard', {
    title: 'Settings', layout: false, tab: 'settings', studio, emailConfigured,
  });
});

app.post(`${A}/settings/test-email`, requireAuth, async (req, res) => {
  const { testEmail } = req.body;
  if (!testEmail || !isValidEmail(testEmail)) {
    req.flash('error', 'Please enter a valid email address for the test.');
    return res.redirect(`${A}/settings`);
  }

  const { sendWishlistConfirmation } = require('./lib/email');
  const siteUrl = process.env.SITE_URL || `${req.protocol}://${req.get('host')}`;
  const studio = db.read('studio', {});
  try {
    await sendWishlistConfirmation({
      to: testEmail.trim(),
      name: 'Admin Tester',
      gameTitle: 'Alpha Preview',
      gameSlug: 'alpha-preview',
      notifyNews: true,
      notifyDevlog: true,
      siteUrl,
      studioName: studio.name || 'Howl A/G Studio',
    });
    req.flash('success', `Test email triggered for ${testEmail.trim()}! Check your inbox (and spam folder).`);
  } catch (err) {
    req.flash('error', `Email test failed: ${err.message}`);
  }
  res.redirect(`${A}/settings`);
});

app.post(`${A}/settings/studio`, requireAuth, (req, res) => {
  const {
    name, tagline, pitch, story, email, x, discord, youtube, instagram,
    heroLine, goalsIntro, goals, honesty,
  } = req.body;
  db.write('studio', {
    name: (name || '').trim(),
    tagline: (tagline || '').trim(),
    pitch: (pitch || '').trim(),
    story: (story || '').trim(),
    heroLine: (heroLine || '').trim(),
    goalsIntro: (goalsIntro || '').trim(),
    // "Goal — the detail after a pipe" per line, so each goal can carry a sentence.
    goals: linesToArray(goals).map((line) => {
      const [label, ...rest] = line.split('|');
      return { label: label.trim(), detail: rest.join('|').trim() };
    }),
    honesty: (honesty || '').trim(),
    email: (email || '').trim(),
    socials: { x: (x || '').trim(), discord: (discord || '').trim(), youtube: (youtube || '').trim(), instagram: (instagram || '').trim() },
  });
  req.flash('success', 'Studio info updated.');
  res.redirect(`${A}/settings`);
});

app.post(`${A}/settings/password`, requireAuth, (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body;
  const account = db.read('admin', []).find((a) => a.id === req.session.userId);
  const valid = account && verifyLogin(account.username, currentPassword);
  if (!valid) {
    req.flash('error', 'Current password is incorrect.');
    return res.redirect(`${A}/settings`);
  }
  if (!newPassword || newPassword.length < 8) {
    req.flash('error', 'New password must be at least 8 characters.');
    return res.redirect(`${A}/settings`);
  }
  if (newPassword !== confirmPassword) {
    req.flash('error', 'New passwords do not match.');
    return res.redirect(`${A}/settings`);
  }
  updatePassword(account.id, newPassword);
  req.flash('success', 'Password updated.');
  res.redirect(`${A}/settings`);
});

// =====================================================================

app.use((req, res) => {
  // An unmatched /admin/ request almost always means one thing: the running Node
  // process is older than the files on disk (Node only reads server.js once, at boot).
  // Rather than a generic 404 that sends you hunting, say exactly what's wrong.
  if (req.path.startsWith(A + '/') || req.path === A) {
    console.warn(`[stale?] No route for ${req.method} ${req.path} — is this server running old code? Running v${APP_VERSION}.`);
    return res.status(404).render('admin-404', {
      title: 'Restart needed',
      method: req.method,
      attemptedPath: req.path,
      layout: false,
    });
  }
  res.status(404).render('404', { title: 'Not found' });
});

// Last line of defence: no stack traces in the browser, ever. Anything that slips
// through lands here as a readable page, and the real detail goes to the console.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('\n[error]', err && err.stack ? err.stack : err, '\n');

  const isWriteProblem = err && (err.code === 'EACCES' || err.code === 'EPERM' || err.code === 'EROFS' || err.code === 'ENOSPC');
  const hint = isWriteProblem
    ? 'The server could not write to its data folder. Check that the project folder is not read-only, not mid-sync (OneDrive/Dropbox), and that you have free disk space.'
    : 'Your last action did not complete. Nothing was saved.';

  res.status(500).send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Something went wrong</title>
<style>
  body{margin:0;background:#06080a;color:#f3f6f4;font-family:Inter,system-ui,sans-serif;
       display:grid;place-items:center;min-height:100vh;padding:24px;line-height:1.6}
  .card{max-width:560px;background:#0f1317;box-shadow:inset 0 0 0 1px #232b33;padding:40px}
  h1{font-family:'Barlow Condensed',Impact,sans-serif;text-transform:uppercase;font-size:2.2rem;margin:0 0 .4em;letter-spacing:.01em}
  p{color:#9aa5a0;margin:0 0 1em}
  code{background:#151a1f;padding:2px 6px;font-size:.85em;color:#b4f230}
  a{display:inline-block;margin-top:14px;background:#b4f230;color:#0a0d10;padding:13px 26px;
    font-weight:700;text-transform:uppercase;letter-spacing:.14em;font-size:.78rem;text-decoration:none}
</style></head><body><div class="card">
  <h1>Something went wrong</h1>
  <p>${hint}</p>
  <p>The technical details were printed in the black server window — if you're stuck, copy that text.</p>
  <a href="/admin">Back to the admin panel</a>
</div></body></html>`);
});

// Storage has to be ready before anything reads from it.
db.init()
  .then((info) => {
    ensureAdmin();

    const server = app.listen(PORT, () => {
      const storageLabel = {
        firebase: `Firebase Firestore (${info.collections || 0} collections loaded)`,
        postgres: 'Postgres (data is safe across restarts)',
        files: 'local JSON files',
      }[info.mode] || info.mode;
      const uploadsLabel = USE_FIREBASE_STORAGE ? 'Firebase Storage (cloud)' : 'local disk';

      const pay = payments.describeConfig();

      console.log(`\n  Howl A/G Studio  v${APP_VERSION}`);
      console.log(`  Storage:     ${storageLabel}`);
      console.log(`  Uploads:     ${uploadsLabel}`);
      console.log(`  Payments:    ${pay.summary}`);
      console.log(`  Site:        http://localhost:${PORT}`);
      console.log(`  Admin panel: http://localhost:${PORT}${A}`);

      // Money is the one thing worth shouting about when it's misconfigured —
      // a silent failure here means real donations quietly go missing.
      if (!pay.ready) {
        console.warn('\n  [payments] Donations and purchases will be REFUSED until PAYPAL_CLIENT_ID');
        console.warn('             and PAYPAL_CLIENT_SECRET are set. See PAYMENTS-SETUP.md');
      } else if (!payments.hasWebhookId()) {
        console.warn('\n  [payments] PAYPAL_WEBHOOK_ID is missing. Payments still work, but if a donor');
        console.warn('             approves on PayPal and closes the tab, the money is never captured');
        console.warn('             and the donation is lost. See PAYMENTS-SETUP.md.');
      } else if (payments.isLiveMode() && !process.env.SITE_URL) {
        console.warn('\n  [payments] Live PayPal credentials are in use but SITE_URL is not set.');
        console.warn('             Return URLs are being guessed from request headers — set SITE_URL.');
      }

      console.log(`\n  Keep this window open. Restart it after any code change.\n`);
    });

    // Hosts stop a process with SIGTERM. Flush pending writes before we go.
    const shutdown = (sig) => () => {
      console.log(`\n[server] ${sig} received — saving and shutting down.`);
      server.close(() => {
        db.close().then(() => process.exit(0)).catch(() => process.exit(0));
      });
      setTimeout(() => process.exit(0), 8000).unref();
    };
    process.on('SIGTERM', shutdown('SIGTERM'));
    process.on('SIGINT', shutdown('SIGINT'));
  })
  .catch((err) => {
    console.error('\n[server] Could not start — storage failed to initialise.');
    console.error('        ' + err.message + '\n');
    process.exit(1);
  });
