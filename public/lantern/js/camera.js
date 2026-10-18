// Camera mode video feed: getUserMedia into a <video>, a VideoTexture for three.js, and the
// object-fit: cover maths that maps the raw frame onto the screen.
import * as THREE from 'three';
import { RAW_HFOV_FRONT, RAW_HFOV_REAR } from './config.js';

const DEG = Math.PI / 180;

export class CameraFeed {
  constructor(video) {
    this.video = video;
    this.stream = null;
    this.ready = false;
    this.facingMode = 'user';
    this.mirrored = true;

    // iOS only plays inline, muted video without a gesture per frame.
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.autoplay = true;

    this.texture = new THREE.VideoTexture(video);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.minFilter = THREE.LinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.generateMipmaps = false;

    this._rect = { s: 1, ox: 0, oy: 0, vw: 1, vh: 1 };
    this._startId = 0;
    // Rotating a phone swaps the stream's width and height: drop the GPU copy so it is re-allocated.
    video.addEventListener('resize', () => this.texture.dispose());
  }

  async start(facingMode = 'user') {
    this.stop(); // bumps _startId, so an older start() still waiting on getUserMedia gives up
    const id = this._startId;
    const md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) throw new Error('This browser can\'t open the camera. Use a recent Chrome or Safari over https.');

    let stream;
    try {
      stream = await md.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: facingMode }, width: { ideal: 1280 }, height: { ideal: 720 } },
      });
    } catch (err) {
      // A blocked permission fails the same way again; anything else: take any camera at all.
      if (err && (err.name === 'NotAllowedError' || err.name === 'SecurityError')) throw err;
      stream = await md.getUserMedia({ audio: false, video: true });
    }
    if (id !== this._startId) { // a newer start() (or stop) won the race
      stream.getTracks().forEach((t) => t.stop());
      return;
    }
    this.stream = stream;

    const track = stream.getVideoTracks()[0];
    const settings = (track && track.getSettings && track.getSettings()) || {};
    this.facingMode = resolveFacing(settings.facingMode, track ? track.label : '', facingMode);
    this.mirrored = this.facingMode !== 'environment';

    const video = this.video;
    video.srcObject = stream;
    try {
      await video.play();
    } catch (err) {
      // Autoplay policies: the muted video normally plays; keep going and let the first frame decide.
      if (err && err.name !== 'AbortError') console.warn('Camera video did not autoplay:', err.message || err);
    }
    await waitForSize(video, 4000);
    if (id !== this._startId) return;
    this.texture.dispose(); // new stream, maybe a new size
    this.texture.needsUpdate = true;
    this.ready = video.videoWidth > 0;
  }

  // object-fit: cover. Returns a shared object (pass `out` to keep your own copy).
  coverRect(W, H, out = this._rect) {
    const vw = this.video.videoWidth || W || 1;
    const vh = this.video.videoHeight || H || 1;
    const s = Math.max(W / vw, H / vh);
    out.s = s;
    out.ox = (W - vw * s) / 2;
    out.oy = (H - vh * s) / 2;
    out.vw = vw;
    out.vh = vh;
    return out;
  }

  // Normalized, UNFLIPPED video coordinates -> CSS px on screen, mirrored like the picture.
  toScreen(nx, ny, W, H, out) {
    const r = this.coverRect(W, H);
    let x = r.ox + nx * r.vw * r.s;
    const y = r.oy + ny * r.vh * r.s;
    if (this.mirrored) x = W - x;
    if (out) { out.x = x; out.y = y; return out; }
    return { x, y };
  }

  // Vertical field of view (degrees) of what is actually on screen after the cover crop.
  fovY(W, H) {
    const vw = this.video.videoWidth || W || 1;
    const vh = this.video.videoHeight || H || 1;
    const hfov = (this.facingMode === 'environment' ? RAW_HFOV_REAR : RAW_HFOV_FRONT) * DEG;
    const fRaw = (Math.max(vw, vh) / 2) / Math.tan(hfov / 2);
    const fPx = fRaw * Math.max(W / vw, H / vh);
    return 2 * Math.atan((H / 2) / fPx) / DEG;
  }

  stop() {
    this._startId++;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.ready = false;
    if (this.video.srcObject) {
      this.video.pause();
      this.video.srcObject = null;
    }
  }
}

// Desktop webcams often report no facingMode: they are selfie cams unless the label says otherwise.
function resolveFacing(reported, label, requested) {
  if (reported === 'environment' || reported === 'user') return reported;
  if (/back|rear|environment/i.test(label || '')) return 'environment';
  if (/front|user|face|selfie/i.test(label || '')) return 'user';
  const touch = typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0;
  return touch ? requested : 'user';
}

function waitForSize(video, timeoutMs) {
  if (video.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('loadedmetadata', check);
      video.removeEventListener('resize', check);
      resolve();
    };
    const check = () => { if (video.videoWidth > 0) done(); };
    const timer = setTimeout(done, timeoutMs);
    video.addEventListener('loadedmetadata', check);
    video.addEventListener('resize', check);
  });
}
