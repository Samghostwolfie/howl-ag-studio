// Stage: renderer, scene, camera, lights, environment map, the camera picture as background and
// selective bloom (camera mode). In AR mode the browser draws the camera picture and there is no bloom.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { BLOOM_LAYER } from './config.js';

const MAX_PIXEL_RATIO = 1.5;
const SLOW_FRAME = 0.045;    // s: average frame time that turns bloom off ...
const SLOW_WINDOW = 2;       // s: ... when it lasts this long
const WARMUP = 1.5;          // s: ignore shader compiles and camera start-up
const SAMPLE_EVERY = 6;      // frames between light samples of the video
const SAMPLE_SIZE = 24;

const FULLSCREEN_VERT = /* glsl */`
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

// The video, cropped like object-fit: cover and mirrored for the selfie camera. VideoTextures stay
// sRGB-encoded on the GPU, so decode to linear here; colorspace_fragment encodes again for the screen.
const BG_FRAG = /* glsl */`
uniform sampler2D map;
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uMirror;
varying vec2 vUv;
void main() {
  vec2 uv = vUv;
  uv.x = mix(uv.x, 1.0 - uv.x, uMirror);
  vec3 c = texture2D(map, uv * uScale + uOffset).rgb;
  c = mix(pow(c * 0.9478672986 + vec3(0.0521327014), vec3(2.4)), c * 0.0773993808, vec3(lessThanEqual(c, vec3(0.04045))));
  gl_FragColor = vec4(c, 1.0);
  #include <colorspace_fragment>
}`;

// Normal render + bloom glow, then the same output transform OutputPass applies (tone mapping + sRGB),
// in one full-screen pass to save a pass on phones.
const MIX_FRAG = /* glsl */`
uniform sampler2D tBase;
uniform sampler2D tBloom;
uniform float uBloom;
varying vec2 vUv;
void main() {
  vec4 base = texture2D(tBase, vUv);
  vec3 glow = texture2D(tBloom, vUv).rgb * uBloom;
  float a = max(base.a, clamp(max(glow.r, max(glow.g, glow.b)), 0.0, 1.0));
  gl_FragColor = vec4(base.rgb + glow, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}`;

// Bloom pass stand-ins: opaque things turn black (they still hide glow behind them), see-through
// things are skipped, so only BLOOM_LAYER objects light up the bloom buffer.
const BLACK = new THREE.MeshBasicMaterial({ color: 0x000000 });
const BLACK_2S = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide });
const SKIP = new THREE.MeshBasicMaterial({ visible: false });

const WHITE = new THREE.Color(1, 1, 1);

function isOpaque(m) {
  return !!m && m.visible !== false && m.transparent !== true && m.colorWrite !== false
    && m.depthWrite !== false && m.blending === THREE.NormalBlending;
}

export class Stage {
  constructor(canvas) {
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'high-performance' });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping; // keeps the camera picture exactly as filmed
    renderer.setClearColor(0x000000, 0);
    renderer.xr.enabled = true;
    this.renderer = renderer;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 50);
    this.camera.layers.enable(BLOOM_LAYER); // objects put on the bloom layer only still render

    // Lights: soft sky/ground fill + ambient + a key light from above and in front.
    this.hemi = new THREE.HemisphereLight(0xffffff, 0x3a4038, 1.0);
    this.ambient = new THREE.AmbientLight(0xffffff, 0.3);
    this.key = new THREE.DirectionalLight(0xffffff, 1.8);
    this.key.position.set(0.5, 1.0, 0.7);
    this.scene.add(this.hemi, this.ambient, this.key);
    this.lights = { hemi: this.hemi, ambient: this.ambient, key: this.key };

    this.lightLevel = 0.6;
    this._levelTarget = 0.6;
    this._tint = new THREE.Color(1, 1, 1);
    this._tintTarget = new THREE.Color(1, 1, 1);
    this._scratchColor = new THREE.Color();

    // Environment for metal reflections: a soft generated room, prefiltered once.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment(renderer);
    this.envMap = pmrem.fromScene(room, 0.04).texture;
    room.dispose();
    pmrem.dispose();

    // Camera picture.
    this.feed = null;
    this._bgMat = new THREE.ShaderMaterial({
      name: 'CameraBackground',
      uniforms: {
        map: { value: null },
        uScale: { value: new THREE.Vector2(1, 1) },
        uOffset: { value: new THREE.Vector2(0, 0) },
        uMirror: { value: 0 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: BG_FRAG,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    this._bgQuad = new FullScreenQuad(this._bgMat);

    // Selective bloom. The scene is rendered at half resolution with everything except BLOOM_LAYER
    // blacked out, then blurred; the blur is added over the full-resolution normal render.
    this.bloomEnabled = true;
    this.autoBloom = true;      // turn bloom off by itself when frames are slow
    this._bloomLayer = new THREE.Layers();
    this._bloomLayer.set(BLOOM_LAYER);
    this._swapObjs = [];
    this._swapMats = [];
    this._darkenVisit = (o) => this._darken(o);

    const isWebGL2 = renderer.capabilities.isWebGL2;
    this._baseRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: isWebGL2 ? 4 : 0 });
    this._baseRT.texture.name = 'Stage.base';
    this.bloomComposer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType }));
    this.bloomComposer.renderToScreen = false;
    this.bloomComposer.setPixelRatio(1); // sizes below are already device pixels
    this._bloomRender = new RenderPass(this.scene, this.camera, null, new THREE.Color(0, 0, 0), 0);
    this.bloomPass = new UnrealBloomPass(new THREE.Vector2(1, 1), 1.0, 0, 0.05);
    // The blur starts at half resolution, so every mip is twice as wide as usual: weight the tight mips
    // and drop the widest ones, or one bright construct would haze the whole picture.
    this.bloomPass.compositeMaterial.uniforms.bloomFactors.value = [1.0, 0.7, 0.32, 0.08, 0.0];
    this.bloomComposer.addPass(this._bloomRender);
    this.bloomComposer.addPass(this.bloomPass);

    this._mixMat = new THREE.ShaderMaterial({
      name: 'BloomMixOutput',
      uniforms: {
        tBase: { value: this._baseRT.texture },
        // The bloom pass leaves the blurred glow alone in its first mip target; using that (instead of
        // the composer output, which also holds the objects themselves) keeps cores from doubling.
        tBloom: { value: this.bloomPass.renderTargetsHorizontal[0].texture },
        uBloom: { value: 1 },
      },
      vertexShader: FULLSCREEN_VERT,
      fragmentShader: MIX_FRAG,
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });
    this._mixQuad = new FullScreenQuad(this._mixMat);

    // Light estimation from the camera picture.
    this._frame = 0;
    this._sampleCtx = null;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = SAMPLE_SIZE;
      this._sampleCtx = c.getContext('2d', { willReadFrequently: true });
    } catch (e) { /* no 2D canvas: lights stay at their defaults */ }

    // Frame-time watch for the bloom auto-off.
    this._perfSum = 0;
    this._perfN = 0;
    this._perfWarmup = WARMUP;
    this._warnedSlow = false;
    this._wasXR = false;

    this.width = 1;
    this.height = 1;
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  setFeed(feed) {
    this.feed = feed || null;
    this._bgMat.uniforms.map.value = feed ? feed.texture : null;
    this._perfWarmup = WARMUP;
    if (!feed) {
      this._levelTarget = 0.6;
      this._tintTarget.copy(WHITE);
    }
  }

  resize() {
    if (this.renderer.xr.isPresenting) return; // the XR session owns the size
    const W = Math.max(1, window.innerWidth || this.canvas.clientWidth || 1);
    const H = Math.max(1, window.innerHeight || this.canvas.clientHeight || 1);
    const pr = Math.min(window.devicePixelRatio || 1, MAX_PIXEL_RATIO);
    this.width = W;
    this.height = H;
    this.pixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(W, H, false);
    this.camera.aspect = W / H;
    if (this.feed && this.feed.ready) this.camera.fov = this.feed.fovY(W, H);
    this.camera.updateProjectionMatrix();

    const pw = Math.max(1, Math.round(W * pr));
    const ph = Math.max(1, Math.round(H * pr));
    this._baseRT.setSize(pw, ph);
    const bw = Math.max(1, Math.round(pw / 2));
    const bh = Math.max(1, Math.round(ph / 2));
    this.bloomComposer.setSize(bw, bh);
    this._perfWarmup = Math.max(this._perfWarmup, 0.5);
  }

  update(dt, xrActive) {
    const xr = !!xrActive && this.renderer.xr.isPresenting;
    if (xr) {
      // Pull this frame's viewer pose into the cameras now, so rays and projections use it before render.
      this.renderer.xr.updateCamera(this.camera);
    } else {
      if (this._wasXR) this._leaveXR();
      const feed = this.feed;
      if (feed && feed.ready) {
        const W = this.width, H = this.height;
        const fov = feed.fovY(W, H);
        if (Math.abs(fov - this.camera.fov) > 1e-4 || this.camera.aspect !== W / H) {
          this.camera.fov = fov;
          this.camera.aspect = W / H;
          this.camera.updateProjectionMatrix();
        }
        this._updateCover(feed, W, H);
        if (++this._frame % SAMPLE_EVERY === 0) this._sampleLight(feed.video);
      }
      this._watchFrameTime(dt);
    }
    this._wasXR = xr;
    this._updateLights(dt);
  }

  render(xrActive) {
    const r = this.renderer;
    if (xrActive && r.xr.isPresenting) {
      // The browser composites the camera picture under a transparent clear.
      r.setClearColor(0x000000, 0);
      r.autoClear = true;
      r.render(this.scene, this.camera);
      return;
    }
    const feed = this.feed;
    const showBg = !!feed && feed.ready && feed.video.readyState >= 2;
    r.setClearColor(0x000000, 0);
    const oldAutoClear = r.autoClear;
    r.autoClear = false;

    if (!this.bloomEnabled) {
      r.setRenderTarget(null);
      r.clear();
      if (showBg) this._bgQuad.render(r);
      r.render(this.scene, this.camera);
      r.autoClear = oldAutoClear;
      return;
    }

    // 1. Normal render (background + scene) into a multisampled linear HDR target.
    r.setRenderTarget(this._baseRT);
    r.clear();
    if (showBg) this._bgQuad.render(r);
    r.render(this.scene, this.camera);

    // 2. Bloom buffer: only BLOOM_LAYER objects, everything else black or skipped, no background.
    const swapped = this._swapObjs, mats = this._swapMats;
    this.scene.traverseVisible(this._darkenVisit);
    const autoUpdate = this.scene.matrixWorldAutoUpdate;
    this.scene.matrixWorldAutoUpdate = false; // already updated by the normal render
    this.bloomComposer.render(0);
    this.scene.matrixWorldAutoUpdate = autoUpdate;
    for (let i = 0; i < swapped.length; i++) swapped[i].material = mats[i];
    swapped.length = 0;
    mats.length = 0;

    // 3. Normal render + glow -> screen, tone mapped and sRGB encoded.
    r.setRenderTarget(null);
    this._mixQuad.render(r);
    r.autoClear = oldAutoClear;
  }

  // The camera to use for rays / projection this frame.
  viewCamera(xrActive) {
    const r = this.renderer;
    if (xrActive && r.xr.isPresenting) {
      const xrCam = r.xr.getCamera();
      return xrCam.cameras.length ? xrCam.cameras[0] : xrCam;
    }
    return this.camera;
  }

  // AR light probe: { intensity: ~0..1 (1 = bright room), color: THREE.Color | 0xRRGGBB | {r,g,b} | [r,g,b] (linear) }.
  setLightEstimate(est) {
    if (!est) return;
    const i = Number(est.intensity);
    if (Number.isFinite(i)) this._levelTarget = Math.min(1, Math.max(0, i));
    const c = est.color;
    const t = this._scratchColor;
    if (c === undefined || c === null) {
      t.copy(WHITE);
    } else if (c.isColor) {
      t.copy(c);
    } else if (typeof c === 'number') {
      t.setHex(c);
    } else if (Array.isArray(c) || ArrayBuffer.isView(c)) {
      t.setRGB(c[0], c[1], c[2]);
    } else {
      t.setRGB(c.r !== undefined ? c.r : c.x, c.g !== undefined ? c.g : c.y, c.b !== undefined ? c.b : c.z);
    }
    const m = Math.max(t.r, t.g, t.b);
    if (Number.isFinite(m) && m > 1e-4) this._tintTarget.setRGB(t.r / m, t.g / m, t.b / m);
  }

  // ---------- internals ----------

  _darken(o) {
    if (!(o.isMesh || o.isSprite || o.isPoints || o.isLine)) return;
    if (o.layers.test(this._bloomLayer)) return;
    const m = o.material;
    let sub;
    if (Array.isArray(m)) {
      sub = o.isMesh && m.every(isOpaque) ? BLACK_2S : SKIP;
    } else {
      // Depth-only (hand occluder) and hidden materials already draw no colour: leave them.
      if (!m || m.colorWrite === false || m.visible === false) return;
      sub = o.isMesh && isOpaque(m) ? (m.side === THREE.FrontSide ? BLACK : BLACK_2S) : SKIP;
    }
    this._swapObjs.push(o);
    this._swapMats.push(m);
    o.material = sub;
  }

  _updateCover(feed, W, H) {
    const rect = feed.coverRect(W, H);
    const kx = W / (rect.vw * rect.s);
    const ky = H / (rect.vh * rect.s);
    const u = this._bgMat.uniforms;
    u.uScale.value.set(kx, ky);
    u.uOffset.value.set((1 - kx) / 2, (1 - ky) / 2);
    u.uMirror.value = feed.mirrored ? 1 : 0;
  }

  _sampleLight(video) {
    const ctx = this._sampleCtx;
    if (!ctx || !video || video.readyState < 2 || !video.videoWidth) return;
    let d;
    try {
      ctx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
      d = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data;
    } catch (e) {
      console.warn('Light estimation from the camera is unavailable:', e.message || e);
      this._sampleCtx = null;
      return;
    }
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = (d.length / 4) * 255;
    r /= n; g /= n; b /= n;
    // Cameras auto-expose, so even a dim room averages ~0.15-0.25; a bright one ~0.45+.
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    this._levelTarget = Math.min(1, Math.max(0, (luma - 0.06) / 0.45));
    const m = Math.max(r, g, b);
    if (m > 0.02) this._tintTarget.setRGB(r / m, g / m, b / m, THREE.SRGBColorSpace);
  }

  _updateLights(dt) {
    const k = 1 - Math.exp(-Math.max(0, dt || 0) * 2.5);
    this.lightLevel += (this._levelTarget - this.lightLevel) * k;
    this._tint.lerp(this._tintTarget, k);
    const L = this.lightLevel;
    this.hemi.intensity = 0.45 + 1.1 * L;
    // A hint of the room's colour only: the camera's average is often strongly tinted.
    this.hemi.color.copy(WHITE).lerp(this._tint, 0.35);
    this.ambient.intensity = 0.12 + 0.4 * L;
    this.ambient.color.copy(WHITE).lerp(this._tint, 0.45);
    this.key.intensity = 0.6 + 1.7 * L;
    this.key.color.copy(WHITE).lerp(this._tint, 0.2);
  }

  _watchFrameTime(dt) {
    if (!this.bloomEnabled || !this.autoBloom || !(dt > 0)) return;
    if (this._perfWarmup > 0) {
      this._perfWarmup -= dt;
      this._perfSum = 0;
      this._perfN = 0;
      return;
    }
    if (dt > 0.5) return; // a stall (tab switch) is not the GPU's fault
    this._perfSum += dt;
    this._perfN++;
    if (this._perfSum < SLOW_WINDOW) return;
    if (this._perfSum / this._perfN > SLOW_FRAME) {
      this.bloomEnabled = false;
      if (!this._warnedSlow) console.warn('Lantern Ring: frames are slow, bloom turned off.');
      this._warnedSlow = true;
    }
    this._perfSum = 0;
    this._perfN = 0;
  }

  _leaveXR() {
    // Back to camera mode: the 3D camera sits at the origin again with its own projection.
    const cam = this.camera;
    cam.position.set(0, 0, 0);
    cam.quaternion.identity();
    cam.scale.set(1, 1, 1);
    cam.zoom = 1;
    cam.updateMatrixWorld();
    this.resize();
  }
}
