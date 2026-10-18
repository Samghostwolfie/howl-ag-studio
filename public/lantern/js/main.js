// Lantern Ring: wires the modules together and holds the game rules.
// See docs/lantern-ring-contract.md for what each module does.
import * as THREE from 'three';
import { MODEL_RING, MODEL_LANTERN } from './config.js';
import { CameraFeed } from './camera.js';
import { Gyro } from './gyro.js';
import { Stage } from './fx.js';
import { HandTracker } from './hands.js';
import { HandOccluder } from './occluder.js';
import { Beam, Sparks } from './energy.js';
import { PowerRing } from './ring.js';
import { PowerLantern } from './lantern.js';
import { SurfaceFinder } from './surface.js';
import { Constructs } from './constructs.js';
import { ARSession } from './xr.js';
import { Voice } from './voice.js';
import { PowerCell } from './power.js';
import { Sfx } from './audio.js';
import { Hud, HandClicker } from './ui.js';

// ---------- rules ----------
const CONSTRUCT_COST = 4;        // % to make a construct
const CONSTRUCT_DRAIN = 1.2;     // %/s while one is held
const CHARGE_RATE = 6;           // %/s while the ring touches the lantern
const CHARGE_REACH = 0.12;       // m from the lantern's core that counts as touching it
const SHAPE_WAIT = 1.6;          // s a spoken shape waits for a fist
const STATUS_COOLDOWN = 2.5;     // s between power reports
const PLANE_TOUCH = 0.035;       // m: ring this close to a known AR surface counts as hitting it

const WARNINGS = {
  20: 'Warning. Ring power at twenty percent.',
  10: 'Ring power low. Please recharge.',
  5: 'Power critical. Five percent remaining.',
  0: 'Power depleted.',
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const startScreen = $('startScreen');
const overlay = $('overlay');

// ---------- modules ----------
const stage = new Stage($('scene'));
const feed = new CameraFeed($('video'));
const gyro = new Gyro();
const tracker = new HandTracker();
const occluder = new HandOccluder(stage.scene);
const sparks = new Sparks(stage.scene);
const ring = new PowerRing(stage.scene, stage.envMap);
const lantern = new PowerLantern(stage.scene, stage.envMap);
const finder = new SurfaceFinder(stage.scene);
const constructs = new Constructs(stage.scene, sparks);
const chargeBeam = new Beam(stage.scene);
chargeBeam.visible = false;
const ar = new ARSession(stage, overlay);
const voice = new Voice();
const cell = new PowerCell();
const sfx = new Sfx();
let hud = null;
const clicker = new HandClicker();

ring.loadModel(MODEL_RING);
lantern.loadModel(MODEL_LANTERN);

// ---------- state ----------
let mode = 'idle';               // 'idle' | 'camera' | 'ar'
let trackerReady = false;
let hands = [];
let glow = 0;
let wasFist = false;
let placing = false;             // camera mode: waiting for a flat hand on a surface
let charging = false;
let wasCharging = false;
let queuedShape = null;
let queuedAt = 0;
let lastStatusAt = -Infinity;
let ringSpeed = 0;
const lastGem = new THREE.Vector3();
let lastGemValid = false;
let clock = 0;

function say(text, tone = 'info', banner = null) {
  voice.say(text, { interrupt: tone === 'warning' || tone === 'charged' });
  if (hud) {
    hud.subtitle(text);
    if (banner) hud.banner(banner, { tone });
  }
}

cell.onWarning = (level, threshold) => {
  const line = WARNINGS[threshold];
  if (!line) return;
  sfx.warning();
  say(line, 'warning', threshold === 0 ? 'POWER DEPLETED' : `POWER ${threshold}%`);
};

function reportPower() {
  if (clock - lastStatusAt < STATUS_COOLDOWN) return;
  lastStatusAt = clock;
  sfx.knock();
  const n = Math.round(cell.level);
  say(`Power level at ${n} percent.`, n <= 20 ? 'warning' : 'info', `RING AT ${n}%`);
}

function chargedFull() {
  cell.fill();
  ring.flash();
  sfx.charged();
  say('Ring charged.', 'charged', 'RING CHARGED');
}

// ---------- voice ----------
voice.onHeard = (text) => hud && hud.setHeard(text);
voice.onCommand = (cmd) => {
  if (cmd.type === 'construct') {
    queuedShape = cmd.shape;
    queuedAt = clock;
  } else if (cmd.type === 'release') {
    if (constructs.active) constructs.release();
  } else if (cmd.type === 'status') {
    reportPower();
  } else if (cmd.type === 'oath') {
    if (hud) hud.oath(cmd.complete ? 1 : cmd.progress);
    if (!cmd.complete) return;
    if (charging) chargedFull();
    else if (lantern.placed) say('Hold the ring to the lantern.');
    else say('Summon the lantern first.');
  }
};

// ---------- constructs ----------
function tryBuild(shape, right) {
  if (!right || !right.fist) {
    say('Make a fist first.');
    return;
  }
  if (cell.level <= 0) {
    say('Ring power depleted. Recharge at the lantern.', 'warning');
    return;
  }
  if (constructs.active) return;
  if (constructs.build(shape, ring, right)) {
    cell.use(CONSTRUCT_COST);
    sfx.build();
  }
}

// ---------- lantern ----------
function onLanternButton() {
  sfx.click();
  if (lantern.placed || lantern.visible) {
    lantern.dismiss();
    sfx.dismiss();
    placing = false;
    finder.stop();
    return;
  }
  if (mode === 'ar') {
    if (ar.hit) {
      lantern.summon(ar.hit.position, ar.hit.up);
      sfx.summon();
      say('Lantern summoned.');
    } else {
      hud.setHint('Point the camera at a table or the floor first');
      say('Point the camera at a surface.');
    }
    return;
  }
  if (placing) {
    placing = false;
    finder.stop();
    return;
  }
  placing = true;
  finder.start();
  say('Lay your hand flat on a surface.');
}

// ---------- HUD ----------
function setupHud() {
  const root = $('hud');
  root.hidden = false;
  hud = new Hud(root);
  hud.setMode(mode);
  hud.setPower(cell.level);
  const b = hud.buttons;
  b.lantern.addEventListener('click', onLanternButton);
  for (const shape of constructs.shapes) {
    if (b[shape]) b[shape].addEventListener('click', () => tryBuild(shape, rightHand()));
  }
  b.mic.addEventListener('click', () => {
    voice.enabled = !voice.enabled;
    if (voice.enabled) voice.start();
  });
  b.flip.addEventListener('click', async () => {
    if (mode !== 'camera') return;
    try { await feed.start(feed.facingMode === 'environment' ? 'user' : 'environment'); } catch (e) { console.warn(e); }
    gyro.recenter();
    resetWorld();
  });
  b.swap.addEventListener('click', () => {
    tracker.swapHands = !tracker.swapHands;
    say(tracker.swapHands ? 'Hands swapped.' : 'Hands back to normal.');
  });
  b.motion.addEventListener('click', () => {
    gyro.enabled = !gyro.enabled;
    gyro.recenter();
    resetWorld();
  });
  b.exitAr.addEventListener('click', () => ar.end());
  if (!voice.supported) hud.showConstructButtons(true);
}

function rightHand() {
  return hands.find((h) => h.side === 'right' && h.sure) || null;
}

// Things placed in the world don't make sense after the view jumps (camera flip, motion toggle, mode change).
function resetWorld() {
  if (constructs.active) constructs.release();
  if (lantern.placed || lantern.visible) lantern.dismiss();
  placing = false;
  finder.stop();
  lastGemValid = false;
}

// ---------- starting ----------
async function loadTracker() {
  if (trackerReady) return;
  statusEl.textContent = 'Loading hand tracking (the first time can take a few seconds)…';
  await tracker.init();
  trackerReady = true;
}

function unlockFromTap() {
  // These need the tap itself, so they run before anything is awaited.
  sfx.unlock();
  voice.start();
  gyro.requestPermission();
}

async function startCamera(facing) {
  unlockFromTap();
  disableChoices(true);
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('This browser can’t open the camera. Use a recent Chrome or Safari over https.');
    }
    statusEl.textContent = 'Starting camera…';
    await feed.start(facing);
    stage.setFeed(feed);
    await loadTracker();
    enter('camera');
  } catch (err) {
    fail(err);
  } finally {
    disableChoices(false);
  }
}

async function startAr() {
  unlockFromTap();
  disableChoices(true);
  try {
    feed.stop();
    stage.setFeed(null);
    // The AR request has to happen while the tap still counts, so it goes before the slow model load.
    await ar.start();
    enter('ar');
    if (!ar.cameraAccess) say('Hand tracking is not available in AR on this phone. Use camera mode for the ring.');
    await loadTracker();
  } catch (err) {
    console.warn(err);
    statusEl.textContent = 'AR could not start on this phone. Try camera mode.';
  } finally {
    disableChoices(false);
  }
}

ar.onEnd = () => {
  if (mode !== 'ar') return;
  resetWorld();
  mode = 'idle';
  startCamera('environment');
};

function enter(next) {
  mode = next;
  statusEl.textContent = '';
  startScreen.hidden = true;
  if (!hud) setupHud();
  hud.setMode(mode);
  resetWorld();
}

function fail(err) {
  console.error(err);
  statusEl.textContent = '⚠️ ' + (err && err.name === 'NotAllowedError'
    ? 'Camera permission was blocked. Allow it in your browser settings and try again.'
    : (err && err.message) || 'Something went wrong starting the camera.');
}

function disableChoices(on) {
  for (const id of ['startAr', 'startMirror', 'startBack']) $(id).disabled = on;
}

$('startAr').addEventListener('click', startAr);
$('startMirror').addEventListener('click', () => startCamera('user'));
$('startBack').addEventListener('click', () => startCamera('environment'));
ARSession.supported().then((ok) => { $('startAr').hidden = !ok; }).catch(() => {});

window.addEventListener('resize', () => stage.resize());

// ---------- frame loop ----------
let lastT = -1;
function tick(t, frame) {
  const dt = lastT < 0 ? 1 / 60 : Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  clock += dt;
  const xr = mode === 'ar' && ar.active;
  if (xr) ar.update(t, frame);

  if (!xr) gyro.apply(stage.camera, mode === 'camera' && feed.facingMode === 'environment' && gyro.enabled);
  stage.update(dt, xr);
  const view = stage.viewCamera(xr);

  // Hands
  if (trackerReady && mode !== 'idle') {
    let input = null;
    const W = window.innerWidth, H = window.innerHeight;
    if (xr) {
      input = ar.handInput();
    } else if (feed.ready) {
      input = {
        image: feed.video,
        timestamp: performance.now(),
        mirrored: feed.mirrored,
        toScreen: (nx, ny) => feed.toScreen(nx, ny, W, H),
        camera: view,
        width: W,
        height: H,
      };
    }
    if (input) hands = tracker.update(input);
  } else {
    hands = [];
  }
  occluder.update(hands);

  if (mode !== 'idle' && hud) play(dt, view, xr);

  stage.render(xr);
}

function play(dt, view, xr) {
  const right = rightHand();
  const fist = !!right && right.fist;

  // Fist powers the ring up.
  if (fist && !wasFist) sfx.ringOn();
  wasFist = fist;
  const target = fist && cell.level > 0 ? 1 : 0;
  glow += (target - glow) * Math.min(1, dt * (target ? 7 : 4));

  ring.update(right, dt, { glow, power: cell.level, charging });

  // Ring speed, for "hit the ring on a surface".
  if (ring.visible) {
    if (lastGemValid) ringSpeed = ringSpeed * 0.6 + (ring.gemWorld.distanceTo(lastGem) / Math.max(dt, 1e-3)) * 0.4;
    lastGem.copy(ring.gemWorld);
    lastGemValid = true;
  } else {
    lastGemValid = false;
    ringSpeed = 0;
  }
  if (right && right.knock) reportPower();
  if (xr && ring.visible && right && right.fist) {
    const plane = ar.planeAt(ring.gemWorld);
    if (plane) {
      const gap = Math.abs(_v.copy(ring.gemWorld).sub(plane.point).dot(plane.up));
      if (gap < PLANE_TOUCH && ringSpeed < 0.08 && peakSpeed > 0.5) reportPower();
    }
  }
  peakSpeed = Math.max(peakSpeed * Math.pow(0.02, dt), ringSpeed);

  // Constructs: a spoken shape waits a moment for the fist.
  if (queuedShape && clock - queuedAt > SHAPE_WAIT) {
    if (!fist) say('Make a fist, then name a shape.');
    queuedShape = null;
  }
  if (queuedShape && fist) {
    tryBuild(queuedShape, right);
    queuedShape = null;
  }
  if (constructs.active) {
    constructs.update(dt, ring, right);
    if (constructs.held) {
      if (!fist) constructs.release();
      else {
        cell.drain(CONSTRUCT_DRAIN, dt);
        if (cell.level <= 0) constructs.release();
      }
    }
  }
  if (!constructs.active && wasHolding) sfx.break();
  wasHolding = constructs.active;
  sfx.hold(constructs.held);

  // Lantern placement (camera mode uses the hand as the depth probe).
  if (placing && mode === 'camera') {
    const s = finder.update(hands, view, dt);
    if (s.status === 'found') {
      placing = false;
      finder.stop();
      lantern.summon(s.position, s.up);
      sfx.summon();
      say('Lantern summoned.');
    }
  }
  if (xr) ar.showReticle = !lantern.placed && !lantern.visible;

  // Charging: ring held to the lantern.
  charging = !!(lantern.placed && ring.visible && ring.gemWorld.distanceTo(lantern.core) < CHARGE_REACH);
  if (charging) {
    const before = cell.level;
    cell.charge(CHARGE_RATE, dt);
    chargeBeam.set(lantern.core, ring.gemWorld);
    if (before < 100 && cell.level >= 100) chargedFull();
  }
  if (charging !== wasCharging) {
    sfx.charge(charging);
    if (charging) say('Charging. Speak the oath.');
    else hud.oath(0);
  }
  wasCharging = charging;
  chargeBeam.visible = charging;
  chargeBeam.update(dt);
  lantern.update(dt, { charging, power: cell.level, camera: view });
  sparks.update(dt);

  // HUD
  hud.setPower(cell.level);
  hud.setListening(voice.listening);
  hud.showConstructButtons(!voice.supported || fist);
  hud.setHint(hintFor(right, fist));

  // Hand clicking: the hand that isn't making a fist points.
  const pointerHand = hands.find((h) => h.side === 'left' && h.sure) || (right && !right.fist ? right : null);
  clicker.update(pointerHand ? pointerHand.pointer : null, !!pointerHand && pointerHand.pinch, dt, visibleButtons());
}

const _v = new THREE.Vector3();
let peakSpeed = 0;
let wasHolding = false;

function visibleButtons() {
  return Object.values(hud.buttons).filter((el) => el && el.offsetParent !== null && !el.disabled);
}

function hintFor(right, fist) {
  if (mode === 'ar' && !ar.cameraAccess) return 'Tap Lantern to place it on a surface';
  if (placing) return 'Lay your hand flat on a table or the floor';
  if (mode === 'ar' && !lantern.placed && !ar.hit && !right) return 'Point the camera at a table or the floor';
  if (!hands.length) return 'Show your right hand';
  if (!right) return hands.some((h) => h.sure) ? 'The ring goes on your right hand' : 'Hold still…';
  if (charging) return 'Charging… speak the oath for a full charge';
  if (constructs.held) return 'Open your hand to let go';
  if (fist) return voice.supported ? 'Say a shape: cube, ball, shield, sword, hammer, wall' : 'Pick a shape';
  if (cell.level <= 20 && lantern.placed) return 'Hold the ring to the lantern to charge';
  return 'Make a fist to power up the ring';
}

// Inspection handle for testing and debugging, only when the page is opened with ?debug.
if (/[?&]debug\b/.test(location.search)) {
  window.__lantern = {
    stage, tracker, ring, lantern, constructs, cell, voice, ar, finder, clicker,
    hud: () => hud,
    hands: () => hands,
    state: () => ({ mode, glow, charging, placing, ringSpeed }),
  };
}

stage.renderer.setAnimationLoop(tick);
