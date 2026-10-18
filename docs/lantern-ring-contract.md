# Lantern Ring — module contract

Build notes for the Lantern Ring page (`public/lantern/`). Every module follows this contract so the
modules can be built separately and fit together.

## Platform

- Plain ES modules, no build step. `public/lantern/index.html` declares an import map:
  - `three` → `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`
  - `three/addons/` → `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/`
  - `@mediapipe/tasks-vision` → `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs`
- Modules live in `public/lantern/js/` and import each other with relative paths (`./hands.js`).
- Target: Chrome on Android (mid-range phone), plus desktop Chrome. Served over https (GitHub Pages,
  repo root = the `public/lantern/` folder) and from the Express site at `/lantern/`. Every URL is
  relative (no leading `/`).
- No other network hosts (MediaPipe wasm from jsDelivr and the hand model from
  `storage.googleapis.com` are the only exceptions, already used today).
- Optional user-supplied models load from `./models/ring.glb` and `./models/lantern.glb` (GLTFLoader +
  `three/addons/libs/meshopt_decoder.module.js`). A 404 or any error keeps the procedural model, silently.
- Code style: 2-space indent, semicolons, single quotes, short comments that explain *why*, `const`/`let`,
  plain JS (no TypeScript), named exports. Each module stays under ~700 lines. Reuse scratch vectors and
  quaternions in hot paths; don't allocate per frame. No `console.log` spam (warn once on fallbacks).
- Legal: the emblem, ring and lantern are ORIGINAL designs (no DC lantern logo). Never put the full
  Green Lantern oath in code, UI or docs; voice matching uses a few short key phrases only.

## Two modes

1. **AR mode** (preferred when `navigator.xr.isSessionSupported('immersive-ar')`): WebXR `immersive-ar`
   with `hit-test` (real surfaces), optional `camera-access` (camera image for hand tracking),
   `dom-overlay` (HTML HUD), `anchors`, `light-estimation`. 6 degrees of freedom: virtual things stay put
   in the room while you walk around. The browser draws the camera picture. Back camera only. Must be
   started from a real tap. No EffectComposer (bloom) in XR: glow comes from additive halo sprites/shells
   that every glowing module draws itself.
2. **Camera mode** (fallback, and "mirror mode" with the front camera): `getUserMedia` + the picture drawn
   inside three.js as a background, selective bloom, 3DoF motion sensor for the back camera, surfaces
   found with the hand as a probe.

Every glowing thing must look good **without** bloom (AR mode); bloom is a bonus in camera mode.

## Units and coordinate frames

- three.js world space in **metres**, Y up.
- **Camera space** = three.js camera convention: +x right, +y up, −z forward.
- Camera mode: the 3D camera sits at the origin. Selfie camera / webcam: never rotates. Back camera +
  motion sensor: `gyro.js` rotates it (turning only). AR mode: the XR camera moves with the phone.
- Camera space → world: `camera.matrixWorld`. Screen → ray: NDC `(2x/W − 1, 1 − 2y/H)` unprojected with
  `camera.projectionMatrixInverse` (works for off-centre XR projections too).
- Focal length in CSS px: `fPx = (H / 2) * camera.projectionMatrix.elements[5]`.

## Shared constants (`js/config.js`)

```js
export const BLOOM_LAYER = 1;          // objects that glow in camera mode's selective bloom
export const EMERALD = 0x3dff7f;       // energy / light colour
export const EMERALD_HOT = 0xb8ffd0;   // hot core / edges
export const EMERALD_DEEP = 0x0d6b33;  // metal / shadows
export const RAW_HFOV_REAR = 67;       // degrees across the long side of the raw back-camera frame
export const RAW_HFOV_FRONT = 63;      // ... front camera / webcam
export const MODEL_RING = './models/ring.glb';
export const MODEL_LANTERN = './models/lantern.glb';
```

## Module APIs

### `camera.js` — `CameraFeed` (camera mode)
```js
const feed = new CameraFeed(videoEl);
await feed.start(facingMode /* 'user' | 'environment' */);   // falls back to any camera
feed.ready; feed.facingMode; feed.mirrored /* selfie: shown flipped like a mirror */; feed.video
feed.texture                 // THREE.VideoTexture (SRGB)
feed.coverRect(W, H)         // { s, ox, oy, vw, vh } object-fit: cover
feed.toScreen(nx, ny, W, H)  // normalized UNFLIPPED video coords -> {x, y} CSS px (applies mirroring)
feed.fovY(W, H)              // vertical FOV (deg) of the displayed, cropped view, from RAW_HFOV_*
feed.stop()                  // stops tracks (needed before AR starts)
```

### `gyro.js` — `Gyro`
```js
const gyro = new Gyro();
await gyro.requestPermission();   // iOS needs it from a tap; no-op elsewhere
gyro.available; gyro.enabled /* user toggle */; gyro.recenter();
gyro.apply(camera, useIt)         // sets camera.quaternion (identity when off), updates matrixWorld; never NaN
```

### `fx.js` — `Stage`
```js
const stage = new Stage(canvasEl);
stage.scene, stage.camera /* PerspectiveCamera for camera mode */, stage.renderer /* alpha, antialias, xr.enabled = true */
stage.setFeed(feed | null)        // camera mode background (null in AR mode: transparent clear)
stage.resize()
stage.update(dt, xrActive)        // camera mode: camera.fov = feed.fovY; light estimation from the video
stage.render(xrActive)            // camera mode: background -> scene -> selective bloom -> output; AR: renderer.render(scene, xrCamera)
stage.viewCamera(xrActive)        // the camera to use for rays/projection this frame (XR: renderer.xr.getCamera().cameras[0] when presenting)
stage.lightLevel                  // 0..1 brightness of the room
stage.setLightEstimate({ intensity, color })   // AR mode light probe feeds this
stage.bloomEnabled                // auto-off if frame time stays > 45 ms
stage.envMap                      // PMREM texture from a generated soft room, for metal reflections
```
- Selective bloom (camera mode): objects on `BLOOM_LAYER` glow; everything else, including the camera
  background, is black in the bloom pass. Bloom at half resolution, pixel ratio ≤ 1.5.
- Light estimation (camera mode): every ~6 frames draw the video into a 24×24 canvas, average it, drive
  hemisphere/ambient light colour + intensity and `lightLevel`.
- `stage.renderer.setAnimationLoop(tick)` drives both modes; `tick(timeMs, xrFrame)`.

### `filters.js` — `OneEuro`, `OneEuroVec2`, `OneEuroVec3`
Standard One Euro filter: `new OneEuro({ minCutoff, beta, dCutoff })`, `filter(value, tSeconds)`, `reset()`.

### `hands.js` — `HandTracker`
```js
const tracker = new HandTracker();
await tracker.init();                 // HandLandmarker, VIDEO mode, numHands 2, GPU then CPU fallback
tracker.swapHands = false;            // user toggle
const hands = tracker.update(input);  // HandFrame[] (0..2)
// input = { image /* TexImageSource MediaPipe reads: <video> or ImageData */, timestamp /* ms, strictly increasing */,
//           mirrored /* display is mirrored vs image */, toScreen(nx, ny) /* -> {x,y} CSS px */,
//           camera /* camera for rays + matrixWorld */, width, height /* CSS px viewport */ }
```
The MediaPipe call must be written exactly as `this.landmarker.detectForVideo(input.image, input.timestamp)`
(tests swap that expression for synthetic hands). When `input.image` is the same video frame as last time
(video.currentTime unchanged), skip detection and return the last frames.

`HandFrame`:
```js
{
  side: 'right' | 'left',  // the person's real hand
  sure: bool,              // side decided (log-odds |L| > 2); the ring waits for this
  screen: [{x, y}] * 21,   // CSS px, filtered, mirrored like the picture
  cam:    [Vector3] * 21,  // metres, camera space, filtered; projects onto `screen`
  world:  [Vector3] * 21,  // metres, world space
  palmWidth, distance,     // metres
  palmCenter: Vector3,     // world, mean of 0,5,9,13,17
  forward: Vector3,        // world unit, wrist(0) -> middle knuckle(9)
  back: Vector3,           // world unit, out of the back of the hand
  velocity: Vector3,       // world m/s of palmCenter (filtered)
  fist, fistAmount,        // bool with hysteresis + 0..1 smoothed
  pinch, pinchAmount,      // thumb tip 4 to index tip 8, relative to palm width, with hysteresis
  pointer: {x, y},         // index fingertip on screen
  palmFlat: bool,          // open, fingers straight, back of hand facing up (world) within ~35°
  knock: bool,             // ONE frame: fist moving fast (> 0.6 m/s mostly downward/forward) stops within ~120 ms
}
```
- **Handedness** (verified for tasks-vision ≥ 0.10.5 with unflipped frames): `categoryName === 'Right'`
  is the person's right hand. P(right) = score if 'Right' else 1 − score. Add a geometric vote from RAW
  `worldLandmarks` (before any axis flips): n = (L5−L0)×(L17−L0); s = Σ over joints
  {6,7,8,10,11,12,14,15,16,18,19,20} of (Lj − centroid(L0,L5,L17))·n̂; s > 0 → right. Per tracked hand
  (matched to last frame by nearest wrist on screen) keep log-odds `L = 0.85L + logit(clamp(p,.03,.97)) +
  (|s| > 0.08 ? sign(s) : 0)`; change side only when |L| > 2. Two hands on the same side → higher L is
  right. `swapHands` flips the final answer.
- Metric 3D: depth of landmark 9 = `fPx * metricLen / pixelLen` with the least foreshortened bone among
  (0-5, 0-17, 5-17, 0-9, 9-10, 5-9, 13-17). Landmark i depth = that + (raw world z_i − z_9). `cam[i]` =
  the screen ray of `screen[i]` scaled to depth i, so `cam[i]` projects exactly onto `screen[i]`.
- Raw world landmarks: x right, y down, z away, in the UNFLIPPED image. Camera space: (x, −y, −z), and
  negate x when `input.mirrored`.
- Filtering: One Euro on screen points (minCutoff ≈ 1.2, beta ≈ 0.02 for px) and on depth
  (minCutoff ≈ 0.8, beta ≈ 0.5). Reset filters when a hand is lost for > 300 ms.
- Skip a hand whose world landmarks contain NaN.

### `occluder.js` — `HandOccluder`
```js
const occ = new HandOccluder(scene);
occ.update(hands);   // depth-only capsules on each bone (radius ≈ 0.11 × palmWidth, a bit thinner toward tips) + palm slab
```
`colorWrite: false`, `depthWrite: true`, `renderOrder = -10`, hidden when no hands. So virtual things behind
your real fingers are hidden by them.

### `energy.js` — shared energy look
```js
makeEnergyMaterial({ color, opacity, rim, scan, fill })
//   ShaderMaterial: fresnel rim, scanlines + faint hex grid in object space, flicker, additive, no depth write.
//   uniforms: uTime, uProgress (0 gone .. 1 solid; noise dissolve with a hot edge band), uIntensity, uColor.
makeEdgeLines(geometry, color)       // glowing edges; uProgress draws them in (by edge position along a sweep axis)
makeHalo(color, size)                // additive sprite with a radial gradient: the no-bloom glow
class Beam { constructor(scene); set(a, b); update(dt); visible; intensity; width }
//   flickering energy beam: bright core + soft outer, crackle noise, travelling pulses, halo at both ends
class Sparks { constructor(scene, max = 600); emit(pos, vel, n, opts); flow(from, to, n, opts); update(dt) }
//   pooled additive points (one THREE.Points, custom shader, size attenuation), opts: { life, size, color, spread, gravity }
```
Every glowing object enables `BLOOM_LAYER` AND carries its own halo, so it glows in AR mode too.

### `ring.js` — `PowerRing`
```js
const ring = new PowerRing(scene, stage.envMap);
await ring.loadModel(MODEL_RING);
ring.update(hand /* right HandFrame | null */, dt, { glow /*0..1*/, power /*0..100*/, charging /*bool*/ });
ring.visible; ring.gemWorld /* Vector3 face centre */; ring.faceNormal /* Vector3 */; ring.flash() /* burst for "charged" */
```
- Placement: centre on the proximal phalanx at `lerp(cam[9], cam[10], 0.38)` → world; axis along 9→10; face
  toward `hand.back` (orthogonalized). Finger radius ≈ 0.11 × palmWidth; inner radius = finger radius.
  Smooth: position lerp 0.65, slerp 0.55 per frame at 30 fps (frame-rate independent).
- Model (procedural, original): bevelled band from a LatheGeometry profile with an inner comfort curve;
  shoulders that rise into a chunky rounded-square bezel; inset emerald crystal face (faceted, emissive)
  with an original emblem (e.g. a ring-and-flame / stylised lantern flame) as raised glowing inlay; fine
  engraved grooves; metal = MeshStandardMaterial metalness 0.85 roughness 0.25 with `envMap`.
- Glow: emblem + face emissive ramp with `glow`, halo sprite, faint flicker; at `power < 20` flicker and
  dimmer; `charging` → pulsing.
- Hidden when no sure right hand.

### `lantern.js` — `PowerLantern`
```js
const lantern = new PowerLantern(scene, stage.envMap);
await lantern.loadModel(MODEL_LANTERN);
lantern.summon(position, up);   // ~1.4 s build-in: green light lines draw it from the surface up, then it solidifies with a flash
lantern.dismiss();              // ~0.8 s break-up
lantern.update(dt, { charging, power, camera });
lantern.placed; lantern.visible; lantern.core /* Vector3 world */; lantern.surfaceY
```
- Original power-battery lantern ~24 cm tall: round stepped base, four curved pillars, glass chamber
  (transparent, slight fresnel) with a floating emerald core, top cap, carrying handle. Contact shadow
  (multiply-ish dark radial on the surface) and a green light pool on the surface (additive). Idle: slow
  pulse + rising motes. Charging: brighter, faster pulse, rotating rings of light.

### `surface.js` — `SurfaceFinder` (camera mode)
```js
const finder = new SurfaceFinder(scene);
finder.start();  finder.stop();
const s = finder.update(hands, camera, dt);   // { status: 'searching' | 'holding' | 'found', hold, position, up }
```
- Hand as depth probe: an open hand laid flat (`palmFlat`) and steady (< 3 cm/s) for 0.7 s → surface at
  palm centre minus 1.5 cm along up. up = world up (camera mode assumes the camera is level when the
  motion sensor is off).
- Reticle: glowing circle + crosshair on the plane under the palm; fills while holding.
- After 8 s without a flat hand: fallback spot 0.6 m ahead, 0.3 m below the camera.

### `xr.js` — `ARSession`
```js
ARSession.supported()            // Promise<bool>
const ar = new ARSession(stage, overlayRoot);
await ar.start();                // from a tap; caller stops getUserMedia first
ar.active; ar.cameraAccess /* bool */; ar.onEnd = () => {};
ar.update(timeMs, xrFrame);      // call first thing in tick when active
ar.handInput()                   // next HandTracker input {image: ImageData, timestamp, mirrored: false, toScreen, camera, width, height} or null
ar.hit                           // { position, up, quaternion } at the screen centre, or null
ar.showReticle = bool            // ring-shaped reticle on the hit surface
ar.planeAt(point)                // last known surface plane near a point { point, up } or null (for "hit the ring on a surface")
ar.anchor(position, quaternion)  // Promise<handle>; handle.pose() -> {position, quaternion} | null (falls back to fixed pose)
ar.end()
```
- Request: `requiredFeatures: ['local', 'hit-test']`, `optionalFeatures: ['camera-access', 'dom-overlay',
  'anchors', 'light-estimation']`, `domOverlay: { root: overlayRoot }`. Skip `camera-access` on Chrome 147
  and 148 (tab crash with projection layers).
- Camera image → ImageData: inside the XR frame, `renderer.state.unbindTexture()`, `binding.getCameraImage(view.camera)`,
  draw it into a ~288 px wide FBO with a flipped-Y shader, read back via PBO + fence (one frame late), then
  `const rt = renderer.getRenderTarget(); renderer.resetState(); renderer.setRenderTarget(rt);`.
  `binding = renderer.xr.getBinding() || new XRWebGLBinding(session, gl)`.
- toScreen for AR = `(nx * W, ny * H)` (the image matches the view). Camera = `renderer.xr.getCamera().cameras[0]`.
- `beforexrselect` preventDefault on the overlay so HUD taps don't fire XR select.
- Light estimation → `stage.setLightEstimate`.
- `webglcontextlost` or session end → `onEnd` so main falls back to camera mode.

### `constructs.js` — `Constructs`
```js
const cons = new Constructs(scene, sparks);
cons.shapes                     // ['cube', 'ball', 'shield', 'sword', 'hammer', 'wall']
cons.build(shape, ring, hand)   // build-in transition; false if one is active
cons.release()                  // break-up transition
cons.update(dt, ring, hand)     // follows the fist; beam from ring.gemWorld
cons.active; cons.held; cons.shape
```
- Look: translucent emerald energy, glowing edges, scanlines, flicker, halo, bloom; a flickering beam
  from the ring face to the construct with sparks running along it.
- Placement: in front of the fist along `hand.forward` (0.16–0.3 m depending on size); if forward points
  toward the camera (cam-space z > 0.4 component), bend it upward so the construct never covers the lens.
  Follows position (critically damped) and rotation (hand basis) smoothly. If the hand is lost for > 0.5 s
  → release.
- Build-in (~0.9 s): sparks flow from the ring to the shape's vertices, edges draw in along a sweep, the
  surface fills with a scanning dissolve front, flash. Break-up (~0.7 s): flicker, dissolve outward with a
  hot edge, edges fade, shards (small energy tetrahedra) burst and fade.

### `voice.js` — `Voice`
```js
const voice = new Voice();
voice.supported; voice.listening; voice.enabled /* user toggle */
voice.start();                   // first call from a tap; auto-restarts in onend while enabled
voice.onCommand = (cmd) => {};   // { type: 'construct', shape } | { type: 'release' } | { type: 'status' } | { type: 'oath', progress, complete }
voice.onHeard = (text) => {};    // interim transcript, for the HUD
voice.say(text, { interrupt });  // ring voice: speechSynthesis, en voice, pitch 0.8, rate 1.0, de-duplicated within 3 s
```
- continuous + interimResults, lang 'en-US'. Restart in `onend` with backoff (300 ms, up to 5 s after errors);
  stop retrying on 'not-allowed' / 'service-not-allowed'. Act on a command word once per utterance.
- Shape words: cube/box/block/square, ball/sphere/orb/circle, shield, sword/blade, hammer, wall/barrier.
  "release"/"drop"/"let go" → release. "power"/"status"/"battery"/"charge level"/"how much" → status.
- Oath: short key phrases only — "brightest day", "blackest night", "evil's might"/"evil might",
  "beware my power", "lantern's light"/"lanterns light" (+ fuzzy word matches). `progress` = phrases heard
  (within 20 s) / 4; `complete` when "beware my power" or "lantern's light" is heard after another
  phrase, or 3+ phrases.
- Must never throw if unsupported (Firefox, iOS WebViews).

### `power.js` — `PowerCell`
```js
const cell = new PowerCell();   // level persisted in localStorage (try/catch), default 100
cell.level; cell.use(amount); cell.drain(perSecond, dt); cell.charge(perSecond, dt); cell.fill();
cell.onWarning = (level, threshold) => {};   // once each time 20, 10, 5, 0 are crossed going down (re-arms after charging above)
```

### `audio.js` — `Sfx` (WebAudio, synthesized, no files)
```js
const sfx = new Sfx();  sfx.unlock();   // from a tap
sfx.ringOn(); sfx.charge(on /* bool: looping hum */); sfx.charged(); sfx.build(); sfx.hold(on); sfx.break();
sfx.warning(); sfx.knock(); sfx.click(); sfx.summon(); sfx.dismiss();
```

### `ui.js` — `Hud`, `HandClicker`
```js
const hud = new Hud(rootEl);   // builds its DOM inside rootEl (the XR dom-overlay root)
hud.setPower(level); hud.setListening(bool); hud.setHeard(text); hud.setHint(text); hud.setMode('ar' | 'camera');
hud.banner(text, { tone: 'charged' | 'warning' | 'info' });   // big centre message with glow-in/out
hud.subtitle(text);                                            // what the ring says
hud.oath(progress);                                            // thin meter while the oath is being spoken
hud.buttons                    // { lantern, cube, ball, shield, sword, hammer, wall, mic, flip, swap, motion, exitAr }
hud.showConstructButtons(bool)
const clicker = new HandClicker();
clicker.update(pointer /* {x,y}|null */, pinch /* bool */, dt, buttons /* HTMLElement[] visible */);
// glowing cursor dot; hover highlight; fires el.click() on pinch (edge) while hovered or after 1.0 s dwell
```
- Power meter: vertical cell at the left edge, segments, % text, colour shifts amber < 20, red < 10, pulses
  when low; fills with a sweep when charged.
- LANTERN button: large, top-right, lantern icon; "active" state when the lantern is out.
- Footer line (small): "Fan-made tribute. Not affiliated with DC."
- Everything respects safe-area insets; works at 360 px wide.

## Game rules (`main.js`)

- Start screen: "Start AR" (if supported) and "Mirror mode" (front camera). AR start is a tap.
- Ring on the sure right hand only. Fist → ring glows (+ `sfx.ringOn` on the edge).
- Fist + shape word (or construct button while a fist is held / voice unsupported) → construct; costs 4%;
  drains 1.2%/s while held; open hand → break-up. At 0% → break-up + "Power depleted."
- Warnings (voice + subtitle + banner): 20% "Warning. Ring power at twenty percent.", 10% "Ring power low.
  Please recharge.", 5% "Power critical. Five percent remaining.", 0% "Power depleted."
- Status ("power" word, or hitting the ring on a surface: knock gesture in camera mode; ring within 3 cm
  of an AR plane with a sudden stop in AR mode) → "Power level at N percent."
- LANTERN button (hand click via pinch/dwell, or tap):
  - AR: if `ar.hit` → summon on that surface (anchored); else hint "Point the camera at a table or the floor".
  - Camera mode: SurfaceFinder → summon at the found spot.
  - Pressed again → dismiss.
- Charging: ring within 12 cm of `lantern.core` → charging (+6%/s), beam lantern → ring, hum, oath
  listening highlighted. **Oath while charging → 100% at once → banner + voice "Ring charged."**
  Oath without charging: lantern out → "Hold the ring to the lantern."; no lantern → "Summon the lantern
  first."
