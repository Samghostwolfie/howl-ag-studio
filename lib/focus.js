// Focal point ("what part of this picture actually matters") handling.
//
// Why a focal point instead of a real crop: the same image is shown at several
// different shapes across the site — a square team card, a wide hero, a 16:10
// game card, a tall capsule. One hard-cropped file can't satisfy all of them.
// Storing the point that must stay visible lets every one of those shapes crop
// around it, and it's non-destructive: the original file is never touched, so
// the framing can be changed again later.

const DEFAULT_FOCUS = { x: 50, y: 50 };

function clampPct(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, Math.round(n * 10) / 10));
}

/** Reads focusX / focusY off a submitted form, falling back to dead centre. */
function parseFocus(body, prefix = '') {
  const xKey = prefix ? `${prefix}FocusX` : 'focusX';
  const yKey = prefix ? `${prefix}FocusY` : 'focusY';
  return {
    x: clampPct(body[xKey], DEFAULT_FOCUS.x),
    y: clampPct(body[yKey], DEFAULT_FOCUS.y),
  };
}

/** Always returns a usable focus object, even for records saved before this existed. */
function readFocus(focus) {
  if (!focus || typeof focus !== 'object') return { ...DEFAULT_FOCUS };
  return {
    x: clampPct(focus.x, DEFAULT_FOCUS.x),
    y: clampPct(focus.y, DEFAULT_FOCUS.y),
  };
}

/** The CSS value that does the actual work: `object-position: 50% 30%`. */
function focusToCss(focus) {
  const f = readFocus(focus);
  return `${f.x}% ${f.y}%`;
}

module.exports = { DEFAULT_FOCUS, parseFocus, readFocus, focusToCss, clampPct };
