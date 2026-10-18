// One Euro filter (Casiez et al. 2012): a low-pass whose cutoff rises with speed, so slow
// jitter is smoothed hard while fast motion stays responsive.
// Times are in seconds. A sample with a non-increasing time or a non-finite value is ignored
// (the last output is returned), so a bad frame never poisons the state with NaN.

const TWO_PI = Math.PI * 2;

function alpha(dt, cutoff) {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuro {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.reset();
  }

  reset() {
    this.value = 0;
    this.speed = 0;      // filtered derivative, units per second
    this.t = 0;
    this.ready = false;
  }

  filter(value, t) {
    if (!Number.isFinite(value) || !Number.isFinite(t)) return this.ready ? this.value : value;
    if (!this.ready) {
      this.value = value; this.speed = 0; this.t = t; this.ready = true;
      return value;
    }
    const dt = t - this.t;
    if (!(dt > 0)) return this.value;
    this.t = t;
    this.speed += alpha(dt, this.dCutoff) * ((value - this.value) / dt - this.speed);
    const cutoff = this.minCutoff + this.beta * Math.abs(this.speed);
    this.value += alpha(dt, cutoff) * (value - this.value);
    return this.value;
  }
}

// Vector versions share one cutoff driven by the speed vector's length, so all axes get the same
// lag and a moving point does not drift sideways off its path (per-axis filters would).
// filter(v, t, out = v): reads v.x/v.y(/v.z), writes the result into out and returns it.
// Works with plain {x, y} objects and THREE.Vector2/Vector3 alike.

export class OneEuroVec2 {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.value = { x: 0, y: 0 };
    this.speed = { x: 0, y: 0 };
    this.reset();
  }

  reset() {
    this.value.x = this.value.y = 0;
    this.speed.x = this.speed.y = 0;
    this.t = 0;
    this.ready = false;
  }

  filter(v, t, out = v) {
    const x = v.x, y = v.y, val = this.value;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) {
      if (this.ready) { out.x = val.x; out.y = val.y; }
      return out;
    }
    if (!this.ready) {
      val.x = x; val.y = y; this.speed.x = this.speed.y = 0; this.t = t; this.ready = true;
      out.x = x; out.y = y;
      return out;
    }
    const dt = t - this.t;
    if (dt > 0) {
      this.t = t;
      const sp = this.speed, ad = alpha(dt, this.dCutoff);
      sp.x += ad * ((x - val.x) / dt - sp.x);
      sp.y += ad * ((y - val.y) / dt - sp.y);
      const a = alpha(dt, this.minCutoff + this.beta * Math.hypot(sp.x, sp.y));
      val.x += a * (x - val.x);
      val.y += a * (y - val.y);
    }
    out.x = val.x; out.y = val.y;
    return out;
  }
}

export class OneEuroVec3 {
  constructor({ minCutoff = 1, beta = 0, dCutoff = 1 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.value = { x: 0, y: 0, z: 0 };
    this.speed = { x: 0, y: 0, z: 0 };
    this.reset();
  }

  reset() {
    this.value.x = this.value.y = this.value.z = 0;
    this.speed.x = this.speed.y = this.speed.z = 0;
    this.t = 0;
    this.ready = false;
  }

  filter(v, t, out = v) {
    const x = v.x, y = v.y, z = v.z, val = this.value;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) || !Number.isFinite(t)) {
      if (this.ready) { out.x = val.x; out.y = val.y; out.z = val.z; }
      return out;
    }
    if (!this.ready) {
      val.x = x; val.y = y; val.z = z;
      this.speed.x = this.speed.y = this.speed.z = 0;
      this.t = t; this.ready = true;
      out.x = x; out.y = y; out.z = z;
      return out;
    }
    const dt = t - this.t;
    if (dt > 0) {
      this.t = t;
      const sp = this.speed, ad = alpha(dt, this.dCutoff);
      sp.x += ad * ((x - val.x) / dt - sp.x);
      sp.y += ad * ((y - val.y) / dt - sp.y);
      sp.z += ad * ((z - val.z) / dt - sp.z);
      const a = alpha(dt, this.minCutoff + this.beta * Math.hypot(sp.x, sp.y, sp.z));
      val.x += a * (x - val.x);
      val.y += a * (y - val.y);
      val.z += a * (z - val.z);
    }
    out.x = val.x; out.y = val.y; out.z = val.z;
    return out;
  }
}
