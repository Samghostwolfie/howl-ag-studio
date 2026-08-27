// Turns whatever link someone pastes (Google Drive, YouTube, Vimeo, Dropbox, Imgur, Loom, Streamable, a plain
// image URL...) into something the browser can actually display or embed.

function extractDriveId(url) {
  if (!url) return null;
  // https://drive.google.com/file/d/FILEID/view?usp=sharing or /preview
  let m = url.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i);
  if (m) return m[1];
  // https://drive.google.com/open?id=FILEID | .../uc?id=FILEID | .../thumbnail?id=FILEID
  m = url.match(/drive\.google\.com\/(?:open|uc|thumbnail)[^?]*\?(?:[^&]*&)*id=([a-zA-Z0-9_-]+)/i);
  if (m) return m[1];
  // https://lh3.googleusercontent.com/d/FILEID
  m = url.match(/googleusercontent\.com\/d\/([a-zA-Z0-9_-]+)/i);
  if (m) return m[1];
  return null;
}

/**
 * Normalize a video link into something that works inside an <iframe>.
 * Supports YouTube (watch, youtu.be, shorts, embed, live), Vimeo, Google Drive, Loom, Streamable, Dailymotion.
 * Direct media files are returned untouched.
 */
function normalizeVideoUrl(input) {
  const url = String(input || '').trim();
  if (!url) return '';

  // --- Google Drive Video ---
  const driveId = extractDriveId(url);
  if (driveId) return `https://drive.google.com/file/d/${driveId}/preview`;

  // --- YouTube ---
  const ytMatch = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|shorts\/|watch\?(?:.*&)?v=|v\/|live\/))([a-zA-Z0-9_-]{11})/i);
  if (ytMatch) return `https://www.youtube.com/embed/${ytMatch[1]}`;

  // --- Vimeo ---
  const vimeoMatch = url.match(/(?:vimeo\.com\/(?:channels\/(?:\w+\/)?|groups\/[^\/]+\/videos\/|video\/|album\/\d+\/video\/|))(\d+)/i);
  if (vimeoMatch) return `https://player.vimeo.com/video/${vimeoMatch[1]}`;

  // --- Loom ---
  const loomMatch = url.match(/loom\.com\/share\/([a-zA-Z0-9_-]+)/i);
  if (loomMatch) return `https://www.loom.com/embed/${loomMatch[1]}`;

  // --- Streamable ---
  const streamableMatch = url.match(/streamable\.com\/([a-zA-Z0-9]+)/i);
  if (streamableMatch) return `https://streamable.com/e/${streamableMatch[1]}`;

  // --- Dailymotion ---
  const dailyMatch = url.match(/dailymotion\.com\/video\/([a-zA-Z0-9]+)/i);
  if (dailyMatch) return `https://www.dailymotion.com/embed/video/${dailyMatch[1]}`;

  return url;
}

/**
 * Normalize an image link into something usable in an <img src>.
 * Google Drive share links become direct CDN URLs (lh3.googleusercontent.com/d/ID);
 * Dropbox links get raw=1; Imgur single page links get direct .png URLs.
 */
function normalizeImageUrl(input) {
  let url = String(input || '').trim();
  if (!url) return '';

  // Remove surrounding backticks or quotes if any were stored
  url = url.replace(/^[`"']+|[`"']+$/g, '').trim();

  // --- Google Drive Image ---
  const driveId = extractDriveId(url);
  if (driveId) {
    return `https://lh3.googleusercontent.com/d/${driveId}`;
  }

  // --- Dropbox ---
  if (/dropbox\.com/i.test(url)) {
    const clean = url.replace(/[?&](dl|raw)=\d+/gi, '');
    return clean + (clean.includes('?') ? '&' : '?') + 'raw=1';
  }

  // --- Imgur page link to direct image link ---
  const imgurPageMatch = url.match(/^https?:\/\/(?:www\.)?imgur\.com\/([a-zA-Z0-9]+)$/i);
  if (imgurPageMatch && imgurPageMatch[1] !== 'gallery' && imgurPageMatch[1] !== 'a') {
    return `https://i.imgur.com/${imgurPageMatch[1]}.png`;
  }

  return url;
}

/**
 * Work out how a video link should be played:
 *   mode 'video'  -> a direct file (.mp4/.webm/.ogv/.mov/.m4v), use a native <video> player
 *   mode 'iframe' -> an embed (YouTube, Vimeo, Drive, Loom, Streamable, ...)
 */
function resolveVideo(input) {
  const raw = String(input || '').trim().replace(/^[`"']+|[`"']+$/g, '').trim();
  if (!raw) return null;
  if (/\.(mp4|webm|ogv|ogg|mov|m4v)(\?.*)?$/i.test(raw)) {
    return { src: raw, mode: 'video' };
  }
  return { src: normalizeVideoUrl(raw), mode: 'iframe' };
}

/** Split a textarea value into a clean array of one-per-line links. */
function linesToArray(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.trim().replace(/^[`"']+|[`"']+$/g, '').trim())
    .filter(Boolean);
}

module.exports = { normalizeVideoUrl, normalizeImageUrl, resolveVideo, linesToArray };

