// 3DoF motion sensor for camera mode with the back camera: turning the phone turns the 3D camera,
// so things stay put in the room while you look around (no walking: that needs AR mode).
import * as THREE from 'three';

const D2R = Math.PI / 180;
// The camera looks out of the back of the device: rotate -90 deg about X.
const Q_BACK = new THREE.Quaternion(-Math.SQRT1_2, 0, 0, Math.SQRT1_2);
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

const _euler = new THREE.Euler();
const _qScreen = new THREE.Quaternion();
const _q = new THREE.Quaternion();
const _v = new THREE.Vector3();

export class Gyro {
  constructor() {
    this.available = false;   // a real orientation event has arrived
    this.enabled = true;      // user toggle
    this.alpha = 0;
    this.beta = 90;
    this.gamma = 0;
    this._calibrated = false;
    this._yawOffset = new THREE.Quaternion();
    this._last = new THREE.Quaternion(); // last good orientation, used if a reading goes bad

    this._onOrient = (e) => {
      // Desktop Chrome fires one event full of nulls: that is not a sensor.
      if (!Number.isFinite(e.alpha) || !Number.isFinite(e.beta) || !Number.isFinite(e.gamma)) return;
      this.alpha = e.alpha;
      this.beta = e.beta;
      this.gamma = e.gamma;
      this.available = true;
    };
    if (typeof window !== 'undefined') window.addEventListener('deviceorientation', this._onOrient);
  }

  // iOS 13+ only gives motion data after a permission prompt started from a tap.
  async requestPermission() {
    const DOE = typeof window !== 'undefined' ? window.DeviceOrientationEvent : undefined;
    if (!DOE || typeof DOE.requestPermission !== 'function') return true;
    try {
      return (await DOE.requestPermission()) === 'granted';
    } catch (e) {
      return false;
    }
  }

  // Make the direction the phone faces right now "forward" again.
  recenter() {
    this._calibrated = false;
  }

  // Sets camera.quaternion from the sensor (identity when not used) and updates matrixWorld.
  apply(camera, useIt) {
    if (!useIt || !this.enabled || !this.available) {
      camera.quaternion.identity();
      this._calibrated = false; // turning motion back on starts facing forward
      camera.updateMatrixWorld();
      return false;
    }
    const q = _q;
    const screenAngle = screenOrientationAngle() * D2R;
    _euler.set(this.beta * D2R, this.alpha * D2R, -this.gamma * D2R, 'YXZ');
    q.setFromEuler(_euler);
    q.multiply(Q_BACK);
    q.multiply(_qScreen.setFromAxisAngle(Z_AXIS, -screenAngle));

    if (!this._calibrated && isFiniteQuat(q)) {
      this._yawOffset.setFromAxisAngle(Y_AXIS, -headingOf(q));
      this._calibrated = true;
    }
    q.premultiply(this._yawOffset);

    if (isFiniteQuat(q)) {
      q.normalize();
      this._last.copy(q);
    } else {
      q.copy(this._last);
    }
    camera.quaternion.copy(q);
    camera.updateMatrixWorld();
    return true;
  }

  dispose() {
    if (typeof window !== 'undefined') window.removeEventListener('deviceorientation', this._onOrient);
  }
}

function screenOrientationAngle() {
  const so = typeof screen !== 'undefined' ? screen.orientation : null;
  const a = so && Number.isFinite(so.angle) ? so.angle : Number(window.orientation) || 0;
  return Number.isFinite(a) ? a : 0;
}

// Compass heading of where the camera looks. Looking straight down or up the view direction has no
// heading, so use the top edge of the phone instead.
function headingOf(q) {
  _v.set(0, 0, -1).applyQuaternion(q);
  if (_v.y < -0.9) _v.set(0, 1, 0).applyQuaternion(q);
  else if (_v.y > 0.9) _v.set(0, -1, 0).applyQuaternion(q);
  const h = Math.atan2(-_v.x, -_v.z);
  return Number.isFinite(h) ? h : 0;
}

function isFiniteQuat(q) {
  return Number.isFinite(q.x) && Number.isFinite(q.y) && Number.isFinite(q.z) && Number.isFinite(q.w)
    && (q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w) > 1e-6;
}
