// Devlog entries and team voices — both are "a bit of writing plus some linked
// media, attached to one game", so they share the same media handling.

const { normalizeImageUrl, resolveVideo, linesToArray } = require('./media');

const TITLE_MAX = 140;
const BODY_MAX = 12000;
const NAME_MAX = 80;
const QUOTE_MAX = 1200;

function clean(v, max) {
  return String(v || '').trim().slice(0, max);
}

/** YYYY-MM-DD for <input type="date">, tolerant of junk. */
function toDateInput(value) {
  const d = value ? new Date(value) : new Date();
  if (isNaN(d)) return new Date().toISOString().slice(0, 10);
  return d.toISOString().slice(0, 10);
}

function formatDate(value) {
  const d = new Date(value);
  if (isNaN(d)) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

/** Turns the stored link lists into things a template can render directly. */
function buildMedia(entry) {
  const media = [];
  (entry.videoLinks || []).forEach((v) => {
    const r = resolveVideo(v);
    if (r) media.push({ type: 'video', mode: r.mode, src: r.src });
  });
  (entry.imageLinks || []).forEach((u) => {
    const src = normalizeImageUrl(u);
    if (src) media.push({ type: 'image', mode: 'image', src });
  });
  return media;
}

// ---------- devlog ----------

function parseDevlog(body) {
  return {
    gameId: clean(body.gameId, 64),
    title: clean(body.title, TITLE_MAX),
    date: toDateInput(body.date),
    author: clean(body.author, NAME_MAX),
    body: clean(body.body, BODY_MAX),
    imageLinks: linesToArray(body.imageLinks),
    videoLinks: linesToArray(body.videoLinks),
    published: body.published === 'on' || body.published === 'true',
  };
}

function normalizeDevlog(entry, games) {
  const game = (games || []).find((g) => g.id === entry.gameId);
  const media = buildMedia(entry);
  return {
    ...entry,
    game: game || null,
    gameTitle: game ? game.title : entry.gameTitle || 'Untitled project',
    gameSlug: game ? game.slug : null,
    media,
    cover: media.find((m) => m.type === 'image') || null,
    dateLabel: formatDate(entry.date),
    dateInput: toDateInput(entry.date),
    excerpt: String(entry.body || '').replace(/\s+/g, ' ').slice(0, 190),
  };
}

// ---------- team voices ----------

function parseVoice(body) {
  return {
    gameId: clean(body.gameId, 64),
    name: clean(body.name, NAME_MAX),
    role: clean(body.role, NAME_MAX),
    quote: clean(body.quote, QUOTE_MAX),
    videoUrl: clean(body.videoUrl, 500),
    photoUrl: clean(body.photoUrl, 500),
  };
}

function normalizeVoice(voice, games) {
  const game = (games || []).find((g) => g.id === voice.gameId);
  const video = voice.videoUrl ? resolveVideo(voice.videoUrl) : null;
  return {
    ...voice,
    game: game || null,
    gameTitle: game ? game.title : voice.gameTitle || '',
    gameSlug: game ? game.slug : null,
    video,
    photo: voice.photoUrl ? normalizeImageUrl(voice.photoUrl) : '',
  };
}

module.exports = {
  TITLE_MAX, BODY_MAX, QUOTE_MAX,
  toDateInput, formatDate,
  parseDevlog, normalizeDevlog,
  parseVoice, normalizeVoice,
};
