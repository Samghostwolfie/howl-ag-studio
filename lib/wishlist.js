// Wishlist field handling + the stats that turn a list of emails into something
// a publisher can actually evaluate.

const PLATFORMS = ['PC', 'Steam Deck', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Mac', 'Linux', 'Mobile'];

const SOURCES = [
  'Friend / word of mouth',
  'YouTube',
  'TikTok',
  'Twitter / X',
  'Reddit',
  'Discord',
  'Itch.io',
  'Games press / article',
  'Festival or event',
  'Other',
];

const COMMENT_MAX = 600;
const FIELD_MAX = 80;

function clean(value, max = FIELD_MAX) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, max);
}

/** Pulls the optional detail fields off a submitted form, safely bounded. */
function parseDetails(body) {
  return {
    name: clean(body.name),
    country: clean(body.country, 56),
    platform: PLATFORMS.includes(clean(body.platform)) ? clean(body.platform) : '',
    source: SOURCES.includes(clean(body.source)) ? clean(body.source) : '',
    comment: String(body.comment || '').trim().slice(0, COMMENT_MAX),
    contactConsent: body.contactConsent === 'on' || body.contactConsent === 'true',
    notifyNews: body.notifyNews === 'on' || body.notifyNews === 'true' || typeof body.notifyNews === 'undefined',
    notifyDevlog: body.notifyDevlog === 'on' || body.notifyDevlog === 'true' || typeof body.notifyDevlog === 'undefined',
  };
}

/**
 * When someone who already signed up submits again with MORE information,
 * that's not spam worth throwing away — it's a free upgrade to the record.
 * We only ever fill in blanks; we never overwrite something they told us before.
 * Returns true if anything was actually added.
 */
function enrich(entry, details) {
  let changed = false;
  ['name', 'country', 'platform', 'source', 'comment'].forEach((key) => {
    if (!entry[key] && details[key]) {
      entry[key] = details[key];
      changed = true;
    }
  });
  // Consent can only ever be granted by a later submission, never revoked by silence.
  if (details.contactConsent && !entry.contactConsent) {
    entry.contactConsent = true;
    changed = true;
  }
  if (typeof details.notifyNews === 'boolean') {
    entry.notifyNews = details.notifyNews;
    changed = true;
  }
  if (typeof details.notifyDevlog === 'boolean') {
    entry.notifyDevlog = details.notifyDevlog;
    changed = true;
  }
  return changed;
}

function tally(entries, key) {
  const counts = new Map();
  entries.forEach((e) => {
    const v = e[key];
    if (v) counts.set(v, (counts.get(v) || 0) + 1);
  });
  return Array.from(counts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

/** Everything a publisher-facing summary needs, computed from raw entries. */
function buildStats(entries) {
  const total = entries.length;
  const contactable = entries.filter((e) => e.contactConsent).length;
  const withComment = entries.filter((e) => e.comment).length;
  const named = entries.filter((e) => e.name).length;
  const flagged = entries.filter((e) => e.flagged).length;
  const repeatAttempts = entries.reduce((s, e) => s + (e.duplicateAttempts || 0), 0);

  const dates = entries.map((e) => new Date(e.date)).filter((d) => !isNaN(d)).sort((a, b) => a - b);

  return {
    total,
    contactable,
    contactablePct: total ? Math.round((contactable / total) * 100) : 0,
    withComment,
    named,
    namedPct: total ? Math.round((named / total) * 100) : 0,
    flagged,
    repeatAttempts,
    countries: tally(entries, 'country'),
    platforms: tally(entries, 'platform'),
    sources: tally(entries, 'source'),
    firstSignup: dates[0] || null,
    lastSignup: dates[dates.length - 1] || null,
  };
}

module.exports = { PLATFORMS, SOURCES, COMMENT_MAX, parseDetails, enrich, buildStats };
