// Turns whatever link someone pastes (Google Drive, YouTube, Vimeo, Dropbox, a plain
// image URL...) into something the browser can actually display or embed.
//
// Paste the normal "share" link you get from the site — this figures out the rest.

function extractDriveId(url) {
  // https://drive.google.com/file/d/FILEID/view?usp=sharing
  let m = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  // https://drive.google.com/open?id=FILEID  |  .../uc?id=FILEID  |  ...?id=FILEID
  m = url.match(/drive\.google\.com\/(?:open|uc|thumbnail)[^?]*\?(?:[^&]*&)*id=([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  return null;
}

/**
 * Normalize a video link into something that works inside an <iframe>.
 * Supports YouTube (watch / youtu.be / shorts / embed), Vimeo, Google Drive.
 * Anything else is returned untouched.
 */
function normalizeVideoUrl(input) {
  const url = String(input || '').trim();
  if (!url) return '';

  // --- Google Drive ---
  const driveId = extractDriveId(url);
  if (driveId) return `https://drive.google.com/file/d/${driveId}/preview`;

  // --- YouTube ---
  let m = url.match(/youtube\.com\/embed\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = url.match(/youtube\.com\/.*[?&]v=([a-zA-Z0-9_-]+)/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;
  m = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
  if (m) return `https://www.youtube.com/embed/${m[1]}`;

  // --- Vimeo ---
  m = url.match(/player\.vimeo\.com\/video\/(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;
  m = url.match(/vimeo\.com\/(?:channels\/[^/]+\/)?(\d+)/);
  if (m) return `https://player.vimeo.com/video/${m[1]}`;

  // --- Streamable / anything else: use as given ---
  return url;
}

/**
 * Normalize an image link into something usable in an <img src>.
 * Google Drive share links become direct thumbnail URLs; Dropbox links get raw=1.
 */
function normalizeImageUrl(input) {
  const url = String(input || '').trim();
  if (!url) return '';

  const driveId = extractDriveId(url);
  if (driveId) return `https://drive.google.com/thumbnail?id=${driveId}&sz=w1920`;

  if (/dropbox\.com/.test(url)) {
    const clean = url.replace(/[?&]dl=\d/, '').replace(/[?&]raw=\d/, '');
    return clean + (clean.includes('?') ? '&' : '?') + 'raw=1';
  }

  return url;
}

/**
 * Work out how a video link should be played:
 *   mode 'video'  -> a direct file (.mp4/.webm/.ogv), use a native <video> player
 *   mode 'iframe' -> an embed (YouTube, Vimeo, Drive, ...)
 */
function resolveVideo(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  if (/\.(mp4|webm|ogv|ogg|mov)(\?.*)?$/i.test(raw)) return { src: raw, mode: 'video' };
  return { src: normalizeVideoUrl(raw), mode: 'iframe' };
}

/** Split a textarea value into a clean array of one-per-line links. */
function linesToArray(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

module.exports = { normalizeVideoUrl, normalizeImageUrl, resolveVideo, linesToArray };
