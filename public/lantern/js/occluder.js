// Depth-only stand-ins for the real hands: capsules on every bone plus a palm slab. They write depth
// but no colour, so virtual things behind your real fingers are hidden by them.
import * as THREE from 'three';
import { BLOOM_LAYER } from './config.js';

const MAX_HANDS = 2;
const RADIUS = 0.11;            // x palmWidth
const SLAB_HALF = 0.16;         // half thickness of the palm, x palmWidth

// Bone pairs: fingers, thumb, then the palm rim (rounds off the slab's edges).
const BONES = [
  1, 2, 2, 3, 3, 4,
  5, 6, 6, 7, 7, 8,
  9, 10, 10, 11, 11, 12,
  13, 14, 14, 15, 15, 16,
  17, 18, 18, 19, 19, 20,
  0, 1, 0, 17, 5, 9, 9, 13, 13, 17,
];
const NB = BONES.length / 2;
// Radius per joint (x RADIUS x palmWidth): thinner toward the tips, pinky thinner than the rest.
const JOINT_R = [
  1.25,
  1.25, 1.1, 0.95, 0.85,
  1.0, 0.92, 0.85, 0.78,
  1.0, 0.92, 0.85, 0.78,
  0.95, 0.88, 0.8, 0.74,
  0.85, 0.78, 0.72, 0.66,
];
// The ring sits on the middle finger's first bone: keep that capsule a bit inside the ring's bore so
// a few frames of ring smoothing lag do not cut into the band.
const RING_BONE_A = 9, RING_BONE_B = 10, RING_BONE_SCALE = 0.85;
const PALM = [0, 1, 5, 9, 13, 17];   // slab outline, in order around the palm

const _pos = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qId = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _n = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

function slabGeometry() {
  const k = PALM.length;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(k * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  const idx = [];
  for (let i = 1; i < k - 1; i++) {
    idx.push(0, i, i + 1);              // top fan
    idx.push(k, k + i + 1, k + i);      // bottom fan
  }
  for (let i = 0; i < k; i++) {         // side walls
    const j = (i + 1) % k;
    idx.push(i, j, k + j, i, k + j, k + i);
  }
  g.setIndex(idx);
  return g;
}

export class HandOccluder {
  constructor(scene) {
    this.material = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: true, side: THREE.DoubleSide });
    this._debugMaterial = null;
    this.group = new THREE.Group();
    this.group.name = 'HandOccluder';

    this.bones = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), this.material, NB * MAX_HANDS);
    this.joints = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 10, 7), this.material, 21 * MAX_HANDS);
    this.slabs = [];
    const meshes = [this.bones, this.joints];
    for (let h = 0; h < MAX_HANDS; h++) {
      const slab = new THREE.Mesh(slabGeometry(), this.material);
      this.slabs.push(slab);
      meshes.push(slab);
    }
    for (const m of meshes) {
      m.renderOrder = -10;
      m.frustumCulled = false;          // instances move every frame; the bounds would be stale
      m.matrixAutoUpdate = false;       // everything is written in world space
      m.layers.enable(BLOOM_LAYER);     // so it also hides glow behind the fingers in the bloom pass
      this.group.add(m);
    }
    this.bones.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.joints.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.group.visible = false;
    scene.add(this.group);
  }

  // Show the occluders in colour (development aid).
  get debug() { return !!this._debugMaterial && this.bones.material === this._debugMaterial; }
  set debug(on) {
    if (on && !this._debugMaterial) {
      this._debugMaterial = new THREE.MeshBasicMaterial({
        color: 0xff40c0, transparent: true, opacity: 0.45, depthWrite: true, side: THREE.DoubleSide,
      });
    }
    const mat = on ? this._debugMaterial : this.material;
    this.bones.material = this.joints.material = mat;
    for (const s of this.slabs) s.material = mat;
  }

  update(hands) {
    const n = Math.min(hands ? hands.length : 0, MAX_HANDS);
    let nb = 0, nj = 0;
    for (let h = 0; h < MAX_HANDS; h++) {
      const slab = this.slabs[h];
      const hand = h < n ? hands[h] : null;
      if (!hand || !hand.world) { slab.visible = false; continue; }
      const P = hand.world;
      const pw = hand.palmWidth > 0.02 && hand.palmWidth < 0.2 ? hand.palmWidth : 0.065;
      const r0 = RADIUS * pw;

      for (let k = 0; k < BONES.length; k += 2) {
        const a = BONES[k], b = BONES[k + 1];
        let r = r0 * 0.5 * (JOINT_R[a] + JOINT_R[b]);
        if (a === RING_BONE_A && b === RING_BONE_B) r *= RING_BONE_SCALE;
        _dir.subVectors(P[b], P[a]);
        const len = _dir.length();
        if (len > 1e-6) _q.setFromUnitVectors(UP, _dir.multiplyScalar(1 / len));
        else _q.identity();
        _pos.addVectors(P[a], P[b]).multiplyScalar(0.5);
        _scale.set(r, Math.max(len, 1e-5), r);
        this.bones.setMatrixAt(nb++, _m.compose(_pos, _q, _scale));
      }
      for (let j = 0; j < 21; j++) {
        let r = r0 * JOINT_R[j];
        if (j === RING_BONE_B) r *= RING_BONE_SCALE;
        _scale.set(r, r, r);
        this.joints.setMatrixAt(nj++, _m.compose(P[j], _qId, _scale));
      }

      // Palm slab: the outline offset both ways along the palm normal.
      if (hand.back) _n.copy(hand.back);
      else _n.subVectors(P[5], P[0]).cross(_dir.subVectors(P[17], P[0])).normalize();
      _n.multiplyScalar(SLAB_HALF * pw);
      const pos = slab.geometry.attributes.position, arr = pos.array, k = PALM.length;
      for (let i = 0; i < k; i++) {
        const p = P[PALM[i]];
        arr[i * 3] = p.x + _n.x; arr[i * 3 + 1] = p.y + _n.y; arr[i * 3 + 2] = p.z + _n.z;
        const o = (k + i) * 3;
        arr[o] = p.x - _n.x; arr[o + 1] = p.y - _n.y; arr[o + 2] = p.z - _n.z;
      }
      pos.needsUpdate = true;
      slab.visible = true;
    }
    this.bones.count = nb;
    this.joints.count = nj;
    this.bones.instanceMatrix.needsUpdate = true;
    this.joints.instanceMatrix.needsUpdate = true;
    this.group.visible = n > 0;
  }

  dispose() {
    this.group.removeFromParent();
    this.bones.geometry.dispose();
    this.joints.geometry.dispose();
    for (const s of this.slabs) s.geometry.dispose();
    this.material.dispose();
    if (this._debugMaterial) this._debugMaterial.dispose();
  }
}
