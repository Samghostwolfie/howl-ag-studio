// Lightweight, dependency-free spam & duplicate protection for wishlist signups.
// No database or external service needed — this is plenty for a small studio site,
// and it's honest about its limits: a restart clears the rate-limit memory. That's
// fine, it's a speed bump against casual spam/bots, not a hard security wall.

// A short list of well-known disposable/throwaway email providers. Not exhaustive —
// new ones pop up constantly — but it catches the obvious, lazy spam attempts.
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.info', 'guerrillamail.biz',
  '10minutemail.com', '10minutemail.net', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'getnada.com', 'fakeinbox.com',
  'sharklasers.com', 'maildrop.cc', 'mintemail.com', 'dispostable.com', 'mailnesia.com',
  'moakt.com', 'tempmailo.com', 'emailondeck.com', 'discard.email', 'spamgourmet.com',
]);

// Collapses "player+giveaway@gmail.com" and "p.l.a.y.e.r@gmail.com" down to the same
// identity as "player@gmail.com" — the two easiest tricks for one person to look like
// several signups. Gmail specifically ignores dots and anything after a "+"; most other
// providers at least respect the "+tag" convention the same way.
function normalizeEmailForDedup(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  let domain = email.slice(at + 1);
  let cleanLocal = local.split('+')[0];
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') cleanLocal = cleanLocal.replace(/\./g, '');
  return `${cleanLocal}@${domain}`;
}

function isDisposableEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  const at = email.lastIndexOf('@');
  if (at === -1) return false;
  return DISPOSABLE_DOMAINS.has(email.slice(at + 1));
}

// Simple sliding-window rate limiter, per IP, kept in memory.
const hits = new Map(); // ip -> [timestamps]
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const MAX_PER_WINDOW = 6; // generous — a real fan wishlisting a few games in 10 min is fine

function checkRateLimit(ip) {
  const key = ip || 'unknown';
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < WINDOW_MS);
  recent.push(now);
  hits.set(key, recent);

  // Housekeeping so this map can't grow forever on a long-running server.
  if (hits.size > 5000) {
    for (const [k, v] of hits) {
      if (!v.some((t) => now - t < WINDOW_MS)) hits.delete(k);
    }
  }
  return recent.length <= MAX_PER_WINDOW;
}

module.exports = { normalizeEmailForDedup, isDisposableEmail, checkRateLimit };
