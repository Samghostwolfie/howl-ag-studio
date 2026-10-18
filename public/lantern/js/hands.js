// Hand tracking: MediaPipe HandLandmarker -> HandFrame[] with the person's real side, metric 3D
// points that line up with the picture, and gestures (fist, pinch, flat palm, knock).
import * as THREE from 'three';
import { FilesetResolver, HandLandmarker } from '@mediapipe/tasks-vision';
import { OneEuro, OneEuroVec2, OneEuroVec3 } from './filters.js';

const WASM_BASE = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm';
const HAND_MODEL = 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

const N = 21;
const MAX_HANDS = 2;
const MAX_TRACKS = 4;          // 2 live + 2 recently lost, so a hand that blinks out keeps its side vote
const LOST_MS = 300;           // lost longer than this: filters and side vote start over
const MIN_DEPTH = 0.06;        // metres; anything outside is a bad estimate, not a hand
const MAX_DEPTH = 4;

const SCREEN_FILTER = { minCutoff: 1.2, beta: 0.02, dCutoff: 1 };  // CSS px
const DEPTH_FILTER = { minCutoff: 0.8, beta: 0.5, dCutoff: 1 };    // metres
const ZREL_FILTER = { minCutoff: 2, beta: 3, dCutoff: 1 };         // per-joint depth relative to landmark 9
const VEL_FILTER = { minCutoff: 1.2, beta: 0.3, dCutoff: 1 };      // m/s; quiet enough to judge "steady"
const KNOCK_VEL_FILTER = { minCutoff: 4, beta: 0.05, dCutoff: 1 }; // m/s; quick, so a knock's stop shows fast
const KNOCK_DEPTH_FILTER = { minCutoff: 3, beta: 1.5, dCutoff: 1 }; // faster depth, only for knock detection

// Handedness: geometric vote joints, and the vote's dead zone (metres summed over 12 joints).
const CHIRAL_JOINTS = [6, 7, 8, 10, 11, 12, 14, 15, 16, 18, 19, 20];
const CHIRAL_MIN = 0.08;
const SIDE_SURE = 2;

// Depth: palm and first finger joints are the most rigid, reliable points for the solve.
const SOLVE_IDS = [0, 1, 5, 6, 9, 10, 13, 14, 17, 18];
const SCALE_BONES = [0, 5, 0, 17, 5, 17, 0, 9, 9, 10, 5, 9, 13, 17];

// Gestures. Curl of a finger = how far tip-to-wrist / knuckle-to-wrist has dropped from straight
// to fist (per finger: the pinky is shorter).
const FINGER_MCP = [5, 9, 13, 17];
const FINGER_TIP = [8, 12, 16, 20];
const CURL_STRAIGHT = [1.9, 2.0, 1.9, 1.7];
const CURL_FIST = [0.85, 0.8, 0.85, 0.9];
const FIST_ON = 0.65, FIST_OFF = 0.4;
const PINCH_ON = 0.32, PINCH_OFF = 0.45;           // thumb-index tip gap / palm width
const PINCH_NEAR = 0.15, PINCH_FAR = 0.6;          // pinchAmount 1 .. 0
const FLAT_CURL_ON = 0.3, FLAT_CURL_OFF = 0.45;    // every finger at most this curled
const FLAT_UP_ON = Math.cos(THREE.MathUtils.degToRad(35));
const FLAT_UP_OFF = Math.cos(THREE.MathUtils.degToRad(45));
const AMOUNT_TAU = 0.06;                           // s, smoothing of fistAmount / pinchAmount
const KNOCK_SPEED = 0.6;                           // m/s, mostly downward or away from the camera
const KNOCK_STOP = 0.15;                           // m/s, "stopped"
const KNOCK_WINDOW = 0.16;                         // s from the last fast sample to the stop (~120 ms + filter lag)
const KNOCK_COOLDOWN = 0.35;

const warned = new Set();
function warnOnce(key, ...args) {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(...args);
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

function finiteLandmarks(list) {
  for (let i = 0; i < N; i++) {
    const p = list[i];
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return false;
  }
  return true;
}

function dist3(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Screen point (CSS px) -> camera-space ray scaled to z = -1, so ray * depth sits at that depth.
// Uses the inverse projection, so off-centre XR projections work too.
function rayInto(out, x, y, W, H, projInv) {
  out.set((2 * x) / W - 1, 1 - (2 * y) / H, 0).applyMatrix4(projInv);
  return out.multiplyScalar(-1 / out.z);
}

// Geometric chirality on RAW world landmarks (x right, y down, z away, unflipped image):
// fingers bend toward the palm, and which side of the (5-0)x(17-0) plane that is tells the hand.
function chirality(w) {
  const o = w[0], a = w[5], b = w[17];
  const ax = a.x - o.x, ay = a.y - o.y, az = a.z - o.z;
  const bx = b.x - o.x, by = b.y - o.y, bz = b.z - o.z;
  let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const len = Math.hypot(nx, ny, nz);
  if (!(len > 1e-9)) return 0;
  nx /= len; ny /= len; nz /= len;
  const cx = (o.x + a.x + b.x) / 3, cy = (o.y + a.y + b.y) / 3, cz = (o.z + a.z + b.z) / 3;
  let s = 0;
  for (let k = 0; k < CHIRAL_JOINTS.length; k++) {
    const p = w[CHIRAL_JOINTS[k]];
    s += (p.x - cx) * nx + (p.y - cy) * ny + (p.z - cz) * nz;
  }
  return s;
}

function makeFrame() {
  const screen = [], cam = [], world = [];
  for (let i = 0; i < N; i++) {
    screen.push({ x: 0, y: 0 });
    cam.push(new THREE.Vector3());
    world.push(new THREE.Vector3());
  }
  return {
    id: 0,
    side: 'right',
    sure: false,
    logOdds: 0,
    screen, cam, world,
    palmWidth: 0.065,
    distance: 0,
    depth: 0,
    palmCenter: new THREE.Vector3(),
    forward: new THREE.Vector3(0, 1, 0),
    back: new THREE.Vector3(0, 0, 1),
    velocity: new THREE.Vector3(),
    fist: false, fistAmount: 0,
    pinch: false, pinchAmount: 0,
    pointer: { x: 0, y: 0 },
    palmFlat: false,
    knock: false,
    curl: [0, 0, 0, 0],      // per finger (index..pinky), 0 straight .. 1 curled
  };
}

class Track {
  constructor() {
    this.active = false;
    this.lastSeen = 0;
    this.wrist = { x: 0, y: 0 };
    this.L = 0;
    this.side = 'right';
    this.rays = [];
    this.screenF = [];
    this.zF = [];
    for (let i = 0; i < N; i++) {
      this.rays.push(new THREE.Vector3());
      this.screenF.push(new OneEuroVec2(SCREEN_FILTER));
      this.zF.push(new OneEuro(ZREL_FILTER));
    }
    this.depthF = new OneEuro(DEPTH_FILTER);
    this.velF = new OneEuroVec3(VEL_FILTER);
    this.prevPalm = new THREE.Vector3();
    // Knock needs a sharp stop, also for motion along the view axis, which the smooth depth filter
    // smears: it gets its own palm velocity with a faster depth filter.
    this.knockDepthF = new OneEuro(KNOCK_DEPTH_FILTER);
    this.knockVelF = new OneEuroVec3(KNOCK_VEL_FILTER);
    this.knockPos = new THREE.Vector3();
    this.prevKnockPos = new THREE.Vector3();
    this.knockVel = new THREE.Vector3();
    this.frame = makeFrame();
    this.start(0, 0);
  }

  start(id, tMs) {
    this.id = id;
    this.active = true;
    this.lastSeen = tMs;
    this.fresh = true;
    this.L = 0;
    for (let i = 0; i < N; i++) { this.screenF[i].reset(); this.zF[i].reset(); }
    this.depthF.reset();
    this.velF.reset();
    this.knockDepthF.reset();
    this.knockVelF.reset();
    this.knockVel.set(0, 0, 0);
    this.prevT = -1;
    this.palmWidth = 0;
    this.fistAmount = 0; this.fist = false;
    this.pinchAmount = 0; this.pinch = false;
    this.palmFlat = false;
    this.knockArmT = -1; this.knockPeak = 0; this.lastKnockT = -1e9;
    const f = this.frame;
    f.id = id; f.knock = false; f.fist = f.pinch = f.palmFlat = false;
    f.velocity.set(0, 0, 0);
  }
}

const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _camFwd = new THREE.Vector3();

export class HandTracker {
  constructor() {
    this.landmarker = null;
    this.delegate = null;
    this.swapHands = false;
    this.depthMethod = 'solve';   // 'solve' (least squares over the palm) or 'bone' (single least-foreshortened bone)
    this.hands = [];              // the returned HandFrame[] (reused every frame)
    this._tracks = [];
    for (let i = 0; i < MAX_TRACKS; i++) { this._tracks.push(new Track()); this._tracks[i].active = false; }
    this._dets = [];
    for (let i = 0; i < MAX_HANDS; i++) {
      const screen = [];
      for (let j = 0; j < N; j++) screen.push({ x: 0, y: 0 });
      this._dets.push({ screen, lm: null, wl: null, cat: null, track: null, side: 'right', sure: false });
    }
    this._nextId = 1;
    this._lastTs = -Infinity;
    this._lastVideoTime = -1;
    this._fileset = null;
    this._model = HAND_MODEL;
    this._switching = false;
  }

  get ready() { return !!this.landmarker; }

  // opts.wasmBase / opts.modelPath override the CDN locations (local testing).
  async init(opts = {}) {
    this._fileset = await FilesetResolver.forVisionTasks(opts.wasmBase || WASM_BASE);
    this._model = opts.modelPath || HAND_MODEL;
    try {
      this.landmarker = await this._create('GPU');
    } catch (err) {
      warnOnce('gpu', 'HandTracker: GPU delegate failed, using CPU.', err);
      this.landmarker = await this._create('CPU');
    }
  }

  _create(delegate) {
    return HandLandmarker.createFromOptions(this._fileset, {
      baseOptions: { modelAssetPath: this._model, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    }).then((lm) => { this.delegate = delegate; return lm; });
  }

  // Some phones create the GPU graph fine but fail on the first frames: rebuild on CPU once.
  _detectFailed(err) {
    if (this.delegate === 'GPU' && !this._switching && this._fileset) {
      this._switching = true;
      warnOnce('gpu-run', 'HandTracker: GPU detection failed, switching to CPU.', err);
      const old = this.landmarker;
      this.landmarker = null;
      try { old.close(); } catch (e) { /* already gone */ }
      this._create('CPU').then((lm) => { this.landmarker = lm; })
        .catch((e) => warnOnce('cpu', 'HandTracker: CPU fallback failed.', e));
      return;
    }
    warnOnce('detect', 'HandTracker: detection failed.', err);
  }

  // Forget every tracked hand (e.g. after switching cameras).
  reset() {
    for (const tr of this._tracks) tr.active = false;
    this.hands.length = 0;
    this._lastVideoTime = -1;
  }

  close() {
    if (this.landmarker) { try { this.landmarker.close(); } catch (e) { /* ignore */ } }
    this.landmarker = null;
    this.reset();
  }

  update(input) {
    const out = this.hands;
    if (!this.landmarker || !input || !input.image || !input.camera || !(input.width > 0) || !(input.height > 0)) {
      out.length = 0;
      return out;
    }
    const img = input.image;
    if (typeof img.currentTime === 'number') {         // <video>
      if (img.readyState < 2 || !img.videoWidth) { out.length = 0; return out; }
      if (img.currentTime === this._lastVideoTime) {
        // Same picture as last time: same answer, but one-frame events must not fire twice.
        for (let i = 0; i < out.length; i++) out[i].knock = false;
        return out;
      }
      this._lastVideoTime = img.currentTime;
    }
    // MediaPipe throws on a timestamp that does not increase.
    if (!(input.timestamp > this._lastTs)) input.timestamp = this._lastTs + 1;
    this._lastTs = input.timestamp;
    let result;
    try {
      result = this.landmarker.detectForVideo(input.image, input.timestamp);
    } catch (err) {
      this._detectFailed(err);
      out.length = 0;
      return out;
    }
    return this._process(result, input);
  }

  _process(res, input) {
    const out = this.hands;
    out.length = 0;
    const tMs = input.timestamp, t = tMs / 1000;
    const W = input.width, H = input.height;
    const lms = (res && res.landmarks) || [];
    const wls = (res && res.worldLandmarks) || [];
    const hds = (res && (res.handedness || res.handednesses)) || [];

    // 1. Usable detections, in screen px.
    let nd = 0;
    for (let i = 0; i < lms.length && nd < MAX_HANDS; i++) {
      const lm = lms[i], wl = wls[i];
      if (!lm || !wl || lm.length < N || wl.length < N) continue;
      if (!finiteLandmarks(wl) || !finiteLandmarks(lm)) continue;
      const det = this._dets[nd];
      let ok = true;
      for (let j = 0; j < N; j++) {
        const p = input.toScreen(lm[j].x, lm[j].y);
        if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) { ok = false; break; }
        det.screen[j].x = p.x; det.screen[j].y = p.y;
      }
      if (!ok) continue;
      // MediaPipe occasionally reports one hand twice: drop a near-identical second copy.
      if (nd === 1) {
        const a = this._dets[0].screen, b = det.screen, tol = 0.03 * Math.max(W, H);
        if (Math.hypot(a[0].x - b[0].x, a[0].y - b[0].y) < tol && Math.hypot(a[9].x - b[9].x, a[9].y - b[9].y) < tol) continue;
      }
      det.lm = lm; det.wl = wl; det.cat = hds[i] && hds[i][0];
      nd++;
    }

    // 2. Match detections to tracked hands by nearest wrist.
    this._match(nd, tMs, 0.35 * Math.max(W, H));

    // 3. Side per hand: label + geometric vote, smoothed as log-odds; sticky until |L| > 2.
    for (let d = 0; d < nd; d++) {
      const det = this._dets[d], tr = det.track, cat = det.cat;
      let p = 0.5;
      if (cat && Number.isFinite(cat.score)) p = cat.categoryName === 'Right' ? cat.score : 1 - cat.score;
      p = Math.min(0.97, Math.max(0.03, p));
      const s = chirality(det.wl);
      tr.L = 0.85 * tr.L + Math.log(p / (1 - p)) + (Math.abs(s) > CHIRAL_MIN ? Math.sign(s) : 0);
      if (tr.fresh || Math.abs(tr.L) > SIDE_SURE) tr.side = tr.L >= 0 ? 'right' : 'left';
      tr.fresh = false;
      det.side = tr.side;
    }
    // Two hands on one side: the more right-looking one is the right hand.
    if (nd === 2 && this._dets[0].side === this._dets[1].side) {
      const r = this._dets[0].track.L >= this._dets[1].track.L ? 0 : 1;
      this._dets[r].side = 'right';
      this._dets[1 - r].side = 'left';
    }
    for (let d = 0; d < nd; d++) {
      const det = this._dets[d], L = det.track.L;
      det.sure = Math.abs(L) > SIDE_SURE && (L > 0) === (det.side === 'right');
      if (this.swapHands) det.side = det.side === 'right' ? 'left' : 'right';
    }

    // 4. Geometry, filters, gestures.
    for (let d = 0; d < nd; d++) {
      const det = this._dets[d];
      if (this._build(det, input, t)) out.push(det.track.frame);
    }
    if (out.length === 2 && out[0].side === 'left' && out[1].side === 'right') {
      const tmp = out[0]; out[0] = out[1]; out[1] = tmp;
    }
    return out;
  }

  _match(nd, tMs, gate) {
    const tracks = this._tracks;
    for (let k = 0; k < MAX_TRACKS; k++) {
      if (tracks[k].active && tMs - tracks[k].lastSeen > LOST_MS) tracks[k].active = false;
    }
    if (nd === 0) return;
    // Brute force over (at most) 5 x 5 assignments; k = -1 means "a new hand", costing `gate`.
    let best = Infinity, b0 = -1, b1 = -1;
    for (let k0 = -1; k0 < MAX_TRACKS; k0++) {
      const c0 = this._cost(0, k0, gate);
      if (c0 === Infinity) continue;
      if (nd < 2) {
        if (c0 < best) { best = c0; b0 = k0; }
        continue;
      }
      for (let k1 = -1; k1 < MAX_TRACKS; k1++) {
        if (k1 >= 0 && k1 === k0) continue;
        const c1 = this._cost(1, k1, gate);
        if (c0 + c1 < best) { best = c0 + c1; b0 = k0; b1 = k1; }
      }
    }
    let claimed = (b0 >= 0 ? 1 << b0 : 0) | (nd > 1 && b1 >= 0 ? 1 << b1 : 0);
    for (let d = 0; d < nd; d++) {
      const det = this._dets[d];
      let k = d === 0 ? b0 : b1;
      if (k < 0) {
        k = this._freeTrack(claimed);
        claimed |= 1 << k;
        tracks[k].start(this._nextId++, tMs);
      }
      const tr = tracks[k];
      tr.lastSeen = tMs;
      tr.wrist.x = det.screen[0].x; tr.wrist.y = det.screen[0].y;
      det.track = tr;
    }
  }

  _cost(d, k, gate) {
    if (k < 0) return gate;
    const tr = this._tracks[k];
    if (!tr.active) return Infinity;
    const w = this._dets[d].screen[0];
    const dist = Math.hypot(w.x - tr.wrist.x, w.y - tr.wrist.y);
    return dist < gate ? dist : Infinity;
  }

  // Index of an inactive track, else of the longest-lost one this frame has not claimed.
  _freeTrack(claimed) {
    let pick = -1;
    for (let k = 0; k < MAX_TRACKS; k++) {
      if (claimed & (1 << k)) continue;
      const tr = this._tracks[k];
      if (!tr.active) return k;
      if (pick < 0 || tr.lastSeen < this._tracks[pick].lastSeen) pick = k;
    }
    return pick;
  }

  // Least squares: the metric world landmarks, moved as a rigid body, should project onto the screen
  // rays. Per joint i: x_i + Tx = u_i * depth_i with depth_i = D + z_i (and the same for y), linear in
  // (Tx, Ty, D). Perspective-correct for tilted and off-centre hands, where a single bone's length is
  // foreshortened. Returns the depth of landmark 9, or NaN.
  _solveDepth(rays, wl, sx) {
    let n = 0, su = 0, sv = 0, sbx = 0, sby = 0, suu = 0, sub = 0;
    for (let k = 0; k < SOLVE_IDS.length; k++) {
      const i = SOLVE_IDS[k], r = rays[i], w = wl[i];
      const u = r.x, v = r.y;
      const bx = u * w.z - sx * w.x;   // camera-space x of the joint is sx * w.x
      const by = v * w.z + w.y;        // camera-space y is -w.y
      n++; su += u; sv += v; sbx += bx; sby += by;
      suu += u * u + v * v; sub += u * bx + v * by;
    }
    const den = suu - (su * su + sv * sv) / n;
    if (!(den > 1e-7)) return NaN;
    return ((su * sbx + sv * sby) / n - sub) / den + wl[9].z;
  }

  // The contract's single-bone estimate: least foreshortened bone, depth = fPx * metres / px.
  _boneDepth(screen, wl, fPx) {
    let best = 0, bi = -1;
    for (let k = 0; k < SCALE_BONES.length; k += 2) {
      const a = SCALE_BONES[k], b = SCALE_BONES[k + 1];
      const m = dist3(wl[a], wl[b]);
      if (m < 0.005) continue;
      const r = Math.hypot(screen[a].x - screen[b].x, screen[a].y - screen[b].y) / m;
      if (r > best) { best = r; bi = k; }
    }
    if (bi < 0 || !(fPx > 0)) return NaN;
    const a = SCALE_BONES[bi], b = SCALE_BONES[bi + 1];
    // The bone's depth is at its midpoint; shift to landmark 9 with the metric z.
    return fPx / best + wl[9].z - (wl[a].z + wl[b].z) / 2;
  }

  _build(det, input, t) {
    const tr = det.track, f = tr.frame, wl = det.wl, raw = det.screen;
    const camera = input.camera, W = input.width, H = input.height;
    const sx = input.mirrored ? -1 : 1;
    const projInv = camera.projectionMatrixInverse;

    // Metric depth of landmark 9.
    let d9 = NaN;
    if (this.depthMethod !== 'bone') {
      for (let k = 0; k < SOLVE_IDS.length; k++) {
        const i = SOLVE_IDS[k];
        rayInto(tr.rays[i], raw[i].x, raw[i].y, W, H, projInv);
      }
      d9 = this._solveDepth(tr.rays, wl, sx);
    }
    if (!(d9 > MIN_DEPTH && d9 < MAX_DEPTH)) {
      d9 = this._boneDepth(raw, wl, (H / 2) * camera.projectionMatrix.elements[5]);
    }
    if (!(d9 > MIN_DEPTH && d9 < MAX_DEPTH)) return false;

    const dt = tr.prevT >= 0 ? t - tr.prevT : 0;
    const depth9 = tr.depthF.filter(d9, t);
    const depthFast = tr.knockDepthF.filter(d9, t);
    const z9 = wl[9].z;
    // cam[i] = the ray through the filtered screen point, at depth9 + (z_i - z_9): it projects exactly
    // onto screen[i] whatever the depth error.
    for (let j = 0; j < N; j++) {
      const s = tr.screenF[j].filter(raw[j], t, f.screen[j]);
      const dz = j === 9 ? 0 : tr.zF[j].filter(wl[j].z - z9, t);
      rayInto(f.cam[j], s.x, s.y, W, H, projInv).multiplyScalar(Math.max(MIN_DEPTH, depth9 + dz));
    }
    for (let j = 0; j < N; j++) {
      const c = f.cam[j];
      if (!Number.isFinite(c.x) || !Number.isFinite(c.y) || !Number.isFinite(c.z)) {
        tr.depthF.reset();
        return false;
      }
    }

    const mw = camera.matrixWorld;
    for (let j = 0; j < N; j++) f.world[j].copy(f.cam[j]).applyMatrix4(mw);

    f.side = det.side;
    f.sure = det.sure;
    f.logOdds = tr.L;
    f.depth = depth9;
    f.distance = f.cam[9].length();
    f.pointer.x = f.screen[8].x; f.pointer.y = f.screen[8].y;

    const pw = dist3(wl[5], wl[17]);
    tr.palmWidth = tr.palmWidth > 0 ? tr.palmWidth + (pw - tr.palmWidth) * Math.min(1, dt / 0.3) : pw;
    f.palmWidth = tr.palmWidth;

    const w = f.world, c = f.cam;
    // Palm centre in camera space; the knock copy rescales it to the fast depth (same rays).
    _v.copy(c[0]).add(c[5]).add(c[9]).add(c[13]).add(c[17]).multiplyScalar(0.2);
    f.palmCenter.copy(_v).applyMatrix4(mw);
    tr.knockPos.copy(_v).multiplyScalar(depthFast / depth9).applyMatrix4(mw);
    f.forward.subVectors(w[9], w[0]).normalize();
    // Back of the hand. In display camera space a real right hand looks like a right hand unless the
    // picture is mirrored; for that geometry the back is (17-0) x (5-0).
    _a.subVectors(c[5], c[0]);
    _b.subVectors(c[17], c[0]);
    if ((f.side === 'right') !== !!input.mirrored) f.back.crossVectors(_b, _a);
    else f.back.crossVectors(_a, _b);
    f.back.normalize().transformDirection(mw);

    // Velocity of the palm centre (world m/s).
    if (dt > 0 && dt < 0.2) {
      _v.subVectors(f.palmCenter, tr.prevPalm).multiplyScalar(1 / dt);
      tr.velF.filter(_v, t, f.velocity);
      _v.subVectors(tr.knockPos, tr.prevKnockPos).multiplyScalar(1 / dt);
      tr.knockVelF.filter(_v, t, tr.knockVel);
    } else if (dt !== 0 || tr.prevT < 0) {
      tr.velF.reset();
      tr.knockVelF.reset();
      f.velocity.set(0, 0, 0);
      tr.knockVel.set(0, 0, 0);
    }
    tr.prevPalm.copy(f.palmCenter);
    tr.prevKnockPos.copy(tr.knockPos);
    tr.prevT = t;

    this._gestures(tr, f, wl, t, dt, camera);
    return true;
  }

  _gestures(tr, f, wl, t, dt, camera) {
    const first = dt <= 0;
    const k = first ? 1 : 1 - Math.exp(-dt / AMOUNT_TAU);

    // Fist: mostly the mean curl, but the least curled finger counts too, so pointing is not a fist.
    let sum = 0, min = 1, max = 0;
    const d0 = wl[0];
    for (let i = 0; i < 4; i++) {
      const r = dist3(wl[FINGER_TIP[i]], d0) / Math.max(1e-6, dist3(wl[FINGER_MCP[i]], d0));
      const c = clamp01((CURL_STRAIGHT[i] - r) / (CURL_STRAIGHT[i] - CURL_FIST[i]));
      f.curl[i] = c;
      sum += c;
      if (c < min) min = c;
      if (c > max) max = c;
    }
    const fistRaw = 0.6 * (sum / 4) + 0.4 * min;
    tr.fistAmount += (fistRaw - tr.fistAmount) * k;
    tr.fist = tr.fist ? tr.fistAmount > FIST_OFF : tr.fistAmount > FIST_ON;

    // Pinch: thumb tip to index tip, relative to palm width; not while a fist tucks the thumb in.
    const ratio = dist3(wl[4], wl[8]) / Math.max(1e-6, dist3(wl[5], wl[17]));
    tr.pinchAmount += (clamp01((PINCH_FAR - ratio) / (PINCH_FAR - PINCH_NEAR)) - tr.pinchAmount) * k;
    tr.pinch = tr.pinch ? ratio < PINCH_OFF && !tr.fist : ratio < PINCH_ON && fistRaw < 0.5;

    // Flat palm: fingers straight and the back of the hand facing up.
    const up = f.back.y;
    tr.palmFlat = tr.palmFlat
      ? max < FLAT_CURL_OFF && up > FLAT_UP_OFF && !tr.fist
      : max < FLAT_CURL_ON && up > FLAT_UP_ON && !tr.fist;

    // Knock: a fist moving fast, mostly down or away from the camera, that stops abruptly.
    f.knock = false;
    const v = tr.knockVel, speed = v.length();
    _camFwd.set(0, 0, -1).transformDirection(camera.matrixWorld);
    const toward = Math.max(-v.y, v.dot(_camFwd));
    if (tr.fist && toward > KNOCK_SPEED && toward > 0.7 * speed) {
      tr.knockArmT = t;
      if (speed > tr.knockPeak) tr.knockPeak = speed;
    } else if (tr.knockArmT >= 0) {
      if (t - tr.knockArmT > KNOCK_WINDOW) {
        tr.knockArmT = -1; tr.knockPeak = 0;          // slowed down gradually: just moving
      } else if (speed < Math.max(KNOCK_STOP, 0.25 * tr.knockPeak)) {
        if (tr.fist && t - tr.lastKnockT > KNOCK_COOLDOWN) { f.knock = true; tr.lastKnockT = t; }
        tr.knockArmT = -1; tr.knockPeak = 0;
      }
    }

    f.fist = tr.fist; f.fistAmount = tr.fistAmount;
    f.pinch = tr.pinch; f.pinchAmount = tr.pinchAmount;
    f.palmFlat = tr.palmFlat;
  }
}
