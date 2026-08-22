// News posts, public comments, like/dislike reactions and per-game feedback.
//
// Everything here is public-facing and unauthenticated, so each function is written
// defensively: bounded lengths, one vote per visitor, and a lightweight spam gate.

const crypto = require('crypto');
const { normalizeImageUrl, resolveVideo, linesToArray } = require('./media');

const CATEGORIES = {
  news: 'News',
  update: 'Update',
  media: 'Media',
  release: 'Release',
};

const TITLE_MAX = 140;
const BODY_MAX = 12000;
const COMMENT_MAX = 1500;
const NAME_MAX = 60;

function clean(v, max) {
  return String(v || '').trim().slice(0, max);
}

/**
 * A stable-ish id for one visitor, used to stop the same person voting twice.
 * It is a hash — we never store a raw IP against a vote — and it is deliberately
 * only a speed bump: someone determined can clear cookies and vote again.
 */
function voterKey(req) {
  const cookie = req.cookies && req.cookies.visitor;
  if (cookie) return `c:${cookie}`;
  const ip = req.ip || (req.socket && req.socket.remoteAddress) || 'unknown';
  const ua = req.get('user-agent') || '';
  return `h:${crypto.createHash('sha256').update(ip + ua).digest('hex').slice(0, 24)}`;
}

function newVisitorId() {
  return crypto.randomBytes(12).toString('hex');
}

// ---------- news posts ----------

function parsePost(body) {
  const category = CATEGORIES[body.category] ? body.category : 'news';
  return {
    title: clean(body.title, TITLE_MAX),
    category,
    date: (function () {
      const d = body.date ? new Date(body.date) : new Date();
      return isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
    })(),
    gameId: clean(body.gameId, 64),
    body: clean(body.body, BODY_MAX),
    imageLinks: linesToArray(body.imageLinks),
    videoLinks: linesToArray(body.videoLinks),
    commentsOpen: body.commentsOpen === 'on' || body.commentsOpen === 'true',
    published: body.published === 'on' || body.published === 'true',
  };
}

function normalizePost(post, games, comments, reactions) {
  const media = [];
  (post.videoLinks || []).forEach((v) => {
    const r = resolveVideo(v);
    if (r) media.push({ type: 'video', mode: r.mode, src: r.src });
  });
  (post.imageLinks || []).forEach((u) => {
    const src = normalizeImageUrl(u);
    if (src) media.push({ type: 'image', mode: 'image', src });
  });

  const game = (games || []).find((g) => g.id === post.gameId) || null;
  const mine = (reactions || []).filter((r) => r.postId === post.id);
  const postComments = (comments || [])
    .filter((c) => c.postId === post.id && !c.hidden)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  const d = new Date(post.date);

  return {
    ...post,
    game,
    gameTitle: game ? game.title : '',
    gameSlug: game ? game.slug : null,
    categoryLabel: CATEGORIES[post.category] || 'News',
    media,
    cover: media.find((m) => m.type === 'image') || null,
    hasVideo: media.some((m) => m.type === 'video'),
    likes: mine.filter((r) => r.value === 1).length,
    dislikes: mine.filter((r) => r.value === -1).length,
    commentCount: postComments.length,
    comments: postComments,
    dateLabel: isNaN(d) ? '' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
    dateInput: isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10),
    excerpt: String(post.body || '').replace(/\s+/g, ' ').slice(0, 190),
  };
}

// ---------- comments ----------

function parseComment(body) {
  return {
    name: clean(body.name, NAME_MAX) || 'Anonymous',
    body: clean(body.body, COMMENT_MAX),
  };
}

// ---------- per-game feedback ----------

const FEEDBACK_TOPICS = ['General', 'Story', 'Gameplay', 'Art & visuals', 'Audio', 'Performance', 'Bug report'];

function parseFeedback(body) {
  const rating = Number(body.rating);
  return {
    gameId: clean(body.gameId, 64),
    name: clean(body.name, NAME_MAX),
    email: clean(body.email, 160),
    topic: FEEDBACK_TOPICS.includes(clean(body.topic, 40)) ? clean(body.topic, 40) : 'General',
    rating: Number.isFinite(rating) && rating >= 1 && rating <= 5 ? Math.round(rating) : 0,
    message: clean(body.message, COMMENT_MAX),
    canReply: body.canReply === 'on' || body.canReply === 'true',
  };
}

function feedbackStats(items) {
  const rated = items.filter((f) => f.rating > 0);
  const avg = rated.length ? rated.reduce((s, f) => s + f.rating, 0) / rated.length : 0;
  const byTopic = {};
  items.forEach((f) => { byTopic[f.topic] = (byTopic[f.topic] || 0) + 1; });
  return {
    total: items.length,
    rated: rated.length,
    average: Math.round(avg * 10) / 10,
    contactable: items.filter((f) => f.canReply && f.email).length,
    topics: Object.entries(byTopic).map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count),
  };
}

module.exports = {
  CATEGORIES, FEEDBACK_TOPICS, COMMENT_MAX,
  voterKey, newVisitorId,
  parsePost, normalizePost,
  parseComment,
  parseFeedback, feedbackStats,
};
