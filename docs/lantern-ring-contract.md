# Lantern Ring — module contract

Build notes for the Lantern Ring page (`public/lantern/`). Every module follows this
contract so the modules can be built separately and fit together.

## Platform

- Plain ES modules, no build step. `index.html` declares an import map:
  - `three` → `https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js`
  - `three/addons/` → `https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/`
  - `@mediapipe/tasks-vision` → `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs`
- Modules live in `public/lantern/js/` and import each other with relative paths (`./hands.js`).
- Target: Chrome on Android (mid-range phone), plus desktop Chrome. Served over https (GitHub Pages)
  and also from the Express site at `/lantern/`. Every path must be relative (no leading `/`).
- No other network hosts. Optional user-supplied models load from `./models/ring.glb` and
  `./models/lantern.glb` if those files exist; on a 404 or any error, fall back to the procedural model
  silently.
- Code style: match the existing page — 2-space indent, semicolons, single quotes, short comments that
  explain *why*, `const`/`let`, no TypeScript, no classes from frameworks. Each module stays under ~600
  lines. Reuse scratch vectors and quaternions in hot paths; don't allocate per frame.

## Units and coordinate frames

- three.js world space in **metres**. Y up. The 3D camera sits at the origin.
- **Camera space** = three.js camera convention: +x right, +y up, −z forward (into the screen).
- Front (selfie) camera and laptop webcams: the 3D camera never rotates (identity quaternion).
  Camera space == world space.
- Back camera + motion sensor: `gyro.js` rotates the 3D camera (3 degrees of freedom: turning only)
  so placed objects stay where they were in the room while you turn the phone. Convert camera space
  to world space with `camera.matrixWorld`.
- The 3D camera's vertical FOV is set every frame from `CameraFeed.intrinsics()`, so an object of
  real size *s* metres at *d* metres lines up with real things in the picture. That is what lets the
  ring fit a real finger.

## Shared constants (`js/config.js`)

```js
export const BLOOM_LAYER = 1;                 // objects on this layer glow (selective bloom)
export const EMERALD = 0x3dff7f;              // main construct/ring light colour
export const EMERALD_DEEP = 0x0d6b33;
export const RAW_HFOV_REAR = 67;             // degrees across the long side of the raw back-camera frame
export const RAW_HFOV_FRONT = 63;            // ... front camera / webcam
```

## Module APIs

### `camera.js` — `CameraFeed`
```js
const feed = new CameraFeed(videoEl);
await feed.start(facingMode /* 'user' | 'environment' */);   // falls back to any camera
feed.ready            // bool: frames are flowing
feed.facingMode       // 'user' | 'environment' (desktop webcams with no facingMode report 'user')
feed.mirrored         // true for the selfie camera: the picture is shown flipped like a mirror
feed.video            // the <video>
feed.texture          // THREE.VideoTexture (colorSpace SRGB)
feed.coverRect(W, H)  // { s, ox, oy, vw, vh }: how the frame is scaled/cropped to fill W×H (object-fit: cover)
feed.toScreen(nx, ny, W, H)   // normalized video coords (0..1, unflipped) -> {x, y} CSS px on screen (applies mirroring)
feed.intrinsics(W, H) // { fovY /*deg*/, fPx /*focal length in CSS px*/ } of the DISPLAYED (cropped) view
feed.stop()
```

### `gyro.js` — `Gyro`
```js
const gyro = new Gyro();
await gyro.requestPermission();   // iOS needs this from a tap; no-op elsewhere
gyro.available                    // a deviceorientation event with numbers has arrived
gyro.enabled                      // user toggle (default true)
gyro.recenter()                   // make the current heading "forward"
gyro.apply(camera, useIt)         // sets camera.quaternion (identity when !useIt or !available), updates matrixWorld
```

### `fx.js` — `Stage` (renderer, background, glow, light)
```js
const stage = new Stage(canvasEl, feed);
stage.scene, stage.camera, stage.renderer
stage.resize()                     // call on window resize
stage.update(dt)                   // syncs camera FOV from feed.intrinsics, light estimation from the video
stage.render()                     // draws: camera picture (cover, mirrored when feed.mirrored) -> scene -> selective bloom on BLOOM_LAYER -> output
stage.lightLevel                   // 0..1 estimated brightness of the room picture
stage.ambient, stage.hemi          // lights the stage owns (light estimation drives them)
```
- The camera picture is drawn **inside** three.js as a full-screen background (not a <video> element on
  the page), so bloom and occlusion composite correctly with the real world.
- Selective bloom: objects that glow call `obj.layers.enable(BLOOM_LAYER)`. Non-glowing objects must be
  hidden from (darkened in) the bloom pass, and the camera picture must not bloom.
- Mobile performance: renderer pixel ratio ≤ 1.5; bloom at half resolution; must hold ~30 fps on a
  mid-range phone alongside MediaPipe.

### `filters.js` — `OneEuro`, `OneEuroVec3`
Standard One Euro filter (`minCutoff`, `beta`, `dCutoff`). `filter(value, tSeconds)`.

### `hands.js` — `HandTracker`
```js
const tracker = new HandTracker();
await tracker.init();                                  // MediaPipe HandLandmarker, GPU then CPU fallback
tracker.swapHands = false;                             // user toggle: "ring on the wrong hand? swap"
const hands = tracker.update(feed, stage.camera, W, H, nowMs);   // HandFrame[] (0..2)
```
The call into MediaPipe must be written exactly as `this.landmarker.detectForVideo(feed.video, nowMs)`
(tests replace that expression to feed synthetic hands).

`HandFrame`:
```js
{
  side: 'right' | 'left',      // the person's real hand, after handedness fix + swapHands
  screen: [{x, y}] * 21,       // CSS px, filtered (One Euro), mirrored like the picture
  cam:    [Vector3] * 21,      // metres, camera space, filtered; projects exactly onto `screen`
  world:  [Vector3] * 21,      // metres, world space (cam transformed by camera.matrixWorld)
  palmWidth,                   // metres, |5-17| from MediaPipe world landmarks
  distance,                    // metres from camera to landmark 9 (middle knuckle)
  palmCenter: Vector3,         // world, average of 0,5,9,13,17
  forward: Vector3,            // world unit vector wrist(0) -> middle knuckle(9): the way a punch goes
  back: Vector3,               // world unit vector out of the back of the hand
  velocity: Vector3,           // world m/s of palmCenter (filtered)
  fist: bool, fistAmount,      // 0..1 smoothed, with hysteresis
  pinch: bool, pinchAmount,    // thumb tip (4) to index tip (8)
  pointer: {x, y},             // index fingertip on screen (CSS px)
  palmFlat: bool,              // open hand, fingers straight, palm facing down within ~35° of world down
  knock: bool,                 // true for ONE frame when a fist moves down fast then stops dead ("hit the ring on a surface")
}
```
- **Handedness:** MediaPipe's label is used as reported (`'Right'` → the person's right hand); the user
  showed that the other reading put the ring on the left hand with both cameras. If both hands get the
  same label, the one further right on screen is the right hand. `swapHands` flips the result.
- Metric 3D: depth of landmark 9 = `fPx * metricLength / pixelLength`, using the least foreshortened
  bone among (0-5, 0-17, 5-17, 0-9, 9-10, 5-9, 13-17). Every other landmark's depth = that depth + its
  MediaPipe world-landmark z offset from landmark 9. Each landmark's camera-space position is its
  screen ray scaled to its depth, so `cam[i]` projects exactly onto `screen[i]`.
- MediaPipe world landmarks are x right, y down, z away from the camera, in the UNFLIPPED frame. Convert
  to camera space with (x, −y, −z), and negate x when `feed.mirrored`.

### `occluder.js` — `HandOccluder`
```js
const occ = new HandOccluder(stage.scene);
occ.update(hands);    // depth-only capsules along each bone (finger radius ~ 0.12 * palmWidth), hidden when no hand
```
Draws before everything else (`renderOrder = -10`), `colorWrite: false`, writes depth, so virtual things
behind your fingers are hidden by your real fingers.

### `energy.js` — shared energy look
```js
makeEnergyMaterial({ color, opacity, rim, scan, dissolve })   // ShaderMaterial: fresnel rim, scanlines/hex pattern,
                                                              // flicker, additive; uniforms.uProgress (0 = gone, 1 = solid),
                                                              // uniforms.uTime, uniforms.uIntensity; noise-based dissolve with a hot edge band
makeEdgeLines(geometry, color)      // glowing edge LineSegments that draw in with progress (uProgress)
class Beam                          // flickering energy beam between two world points: beam.set(a, b), beam.update(dt), beam.visible, beam.intensity
class Sparks                        // pooled additive particles: sparks.emit(pos, vel, count, opts), sparks.flow(from, to, count), sparks.update(dt)
```
All glowing objects are put on `BLOOM_LAYER`.

### `ring.js` — `PowerRing`
```js
const ring = new PowerRing(stage.scene);
await ring.loadModel('./models/ring.glb');       // optional; keeps the procedural ring on failure
ring.update(hand /* HandFrame | null */, dt, { glow /*0..1*/, power /*0..100*/ });
ring.visible
ring.gemWorld        // Vector3: centre of the ring's face (where beams start)
ring.faceNormal      // Vector3: world direction the face points (back of the hand)
```
- Sits on the proximal phalanx of the middle finger: centre at `lerp(cam[9], cam[10], 0.38)` (camera
  space → world), axis along 9→10, face toward `hand.back`. Size from `palmWidth`: finger radius ≈ 0.12
  × palmWidth.
- Procedural model, emerald theme: bevelled band (LatheGeometry profile), chunky raised bezel with an
  original glowing emblem (NOT the trademarked Green Lantern logo), engraved detail, metalness with an
  environment reflection (PMREM of a small generated room/gradient so metal is not black).
- Glow: emissive ramps with `glow`, bezel emblem on BLOOM_LAYER; dims and flickers when `power < 20`.

### `lantern.js` — `PowerLantern`
```js
const lantern = new PowerLantern(stage.scene);
await lantern.loadModel('./models/lantern.glb');  // optional
lantern.summon(position /* world */, up /* world unit normal of the surface */);  // build-in animation (~1.2 s)
lantern.dismiss();                                // break-up animation, then hidden
lantern.update(dt, { charging /*bool*/, power });
lantern.placed      // true after summon finished, false after dismiss
lantern.core        // Vector3 world: the glowing heart (charging point)
```
- Procedural model of an original "power battery" lantern (~22 cm tall): base, cage/glass chamber with
  an emerald core, top cap and handle; contact shadow and a green light pool on the surface; gentle
  idle pulse; brightens and throws a beam to the ring while charging.

### `surface.js` — `SurfaceFinder`
```js
const finder = new SurfaceFinder(stage.scene);
finder.start();                              // shows the "find a surface" reticle
const s = finder.update(hands, stage.camera, dt);
// s = { status: 'searching' | 'holding' | 'found', hold /*0..1*/, position, up }
finder.stop();
```
- The hand is the depth probe: lay a hand flat on the table/floor; when `palmFlat` holds steady for
  ~0.7 s, the surface is at the palm (slightly below the palm centre, by ~1.5 cm) with up = world up
  (or the palm's back normal when the motion sensor is off and the camera may be tilted).
- A reticle (glowing ring + crosshair on the plane) follows the palm while searching and fills while
  holding.
- After 8 s with no flat hand, fall back to a spot 0.6 m ahead and 0.35 m below the camera, facing up.

### `constructs.js` — `Constructs`
```js
const cons = new Constructs(stage.scene, sparks /* from energy.js */);
cons.shapes                     // ['cube', 'ball', 'shield', 'sword', 'hammer', 'wall']
cons.build(shape, ring, hand)   // starts the build-in transition; returns false if one is already active
cons.release()                  // starts the break-up transition
cons.update(dt, ring, hand)     // follows the fist; beam from ring.gemWorld to the construct
cons.active                     // a construct exists (building, held or breaking)
cons.held                       // fully built and held
```
- Construct look: translucent emerald energy (energy material), glowing edges, scanlines, flicker,
  bloom; a flickering beam from the ring's face to the construct.
- Placement: in front of the fist along `hand.forward`, ~0.18–0.3 m from the ring depending on shape
  size; if `hand.forward` points back at the camera, lean it upward so the construct never covers the
  lens. Smoothly follows position and rotation (rotation from the hand's basis).
- Build-in (~0.9 s): sparks stream from the ring to the shape, the wireframe edges draw in, the surface
  fills with a scanning dissolve front, then a flash.
- Break-up (~0.7 s): flicker, noise dissolve outward with a hot edge, edges fade, shards/sparks burst
  and fall away.

### `voice.js` — `Voice`
```js
const voice = new Voice();
voice.supported          // speech recognition available
voice.start();           // must be called from a user gesture; keeps restarting after each phrase
voice.listening          // bool, for the mic indicator
voice.onCommand = (cmd) => {};
// cmd: { type: 'construct', shape } | { type: 'release' } | { type: 'status' } | { type: 'oath', complete: bool, progress: 0..1 }
voice.say(text, { interrupt })   // ring's voice via speechSynthesis (slightly low pitch); queue, de-duplicated
```
- Shape words: cube/box/block, ball/sphere/orb, shield, sword/blade, hammer, wall. "release"/"drop" →
  release. "power"/"status"/"battery"/"charge level" → status.
- Oath: detect from a few short key phrases ("brightest day", "blackest night", "beware my power",
  "lantern's light", plus fuzzy variants); `complete` when the final phrase or 3+ phrases are heard
  within ~20 s. Never display or store the full oath text.
- Recognition errors (no permission, no network, unsupported) must not break the page; `supported`
  false hides voice UI and the on-screen buttons become the way to make constructs.

### `power.js` — `PowerCell`
```js
const cell = new PowerCell();      // level persisted in localStorage (try/catch), default 100
cell.level                          // 0..100
cell.use(amount); cell.drain(perSecond, dt); cell.charge(perSecond, dt); cell.fill();
cell.onWarning = (level, threshold) => {};   // fires once when crossing 20, 10, 5, 0 going down
```

### `ui.js` — `Hud`, `HandClicker`
```js
const hud = new Hud(rootEl);
hud.setPower(level); hud.setListening(bool); hud.setHint(text);
hud.banner(text, { tone: 'charged' | 'warning' | 'info' });   // big centre message with a glow-in effect
hud.subtitle(text);                                            // what the ring "says"
const clicker = new HandClicker([buttonEls]);
clicker.update(pointer /* {x,y} | null */, pinch /* bool */, dt);   // hover highlight + dwell ring; fires el.click()
```
- Hand cursor: a small glowing dot at the pointer; a button fires on pinch while hovered, or after a
  1.0 s dwell. Normal taps work too.
- Buttons: LANTERN (summon / dismiss), construct buttons (cube, ball, shield, sword, hammer, wall) shown
  while a fist is held or when voice is unsupported, camera flip, swap hands, motion on/off, mic.

## Rules in `main.js` (integration)

- Ring shows on the right hand only. Fist → ring glows.
- Fist + shape (voice or button) → construct; costs 4%, drains 1.2%/s while held; follows the fist;
  open the hand → it breaks up. At 0% it breaks up and the ring says it is out of power.
- Warnings, spoken + subtitle + banner: 20% "Warning. Ring power at twenty percent.", 10% "Ring power
  low. Please recharge.", 5% "Power critical. Five percent remaining.", 0% "Power depleted."
- Knock (fist moves down fast then stops, as if hitting the ring on a surface) or saying "power" →
  "Power level at N percent."
- LANTERN button (hand click or tap) → surface finder → lantern summoned on the surface. Press again to
  dismiss.
- Charging: ring within 12 cm of `lantern.core` → charging (+6%/s), beam from lantern to ring, hum.
  **Saying the oath while charging → 100% at once → "Ring charged."** Oath when not charging but the
  lantern is out → "Hold the ring to the lantern." Oath with no lantern → "Summon the lantern first."
