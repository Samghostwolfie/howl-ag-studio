# Lantern Ring v2 — where we stopped

Paused on 2026-10-18 at the user's request. GitHub Pages
(`https://samghostwolfie.github.io/howl-ag-studio/`, branch `gh-pages`) still serves the previous,
working single-file ring. Everything below is on branch `claude/hand-tracking-cube-game-76qn4g`.

## What the user asked for

1. Ring aligned properly on the right middle finger.
2. Fix: the ring showed on the LEFT hand with both cameras. Cause found: the old code read MediaPipe's
   label backwards. With tasks-vision ≥ 0.10.5 and unflipped frames, `'Right'` is the person's right
   hand.
3. Better ring design (Sketchfab was suggested; it can't be fetched automatically, so the plan is
   original procedural models plus optional `models/ring.glb` / `models/lantern.glb` the user can add).
4. A Lantern button pressed with a hand "click" (pinch or dwell); the lantern appears on a real surface
   the camera is looking at.
5. Speaking the oath while charging at the lantern → 100% and "Ring charged".
6. Fist + "cube" (and other shapes) → glowing energy construct with a flashing beam from the ring that
   follows the hand; build-up and break-apart transitions.
7. Low power warnings spoken like the show ("Ring power low. Please recharge."); hitting the ring on a
   surface → "Power level at N percent."
8. 3D that blends with the real world (real surfaces, staying put as you move, lighting, occlusion,
   glow).

## Plan

- Design and module APIs: [`lantern-ring-contract.md`](lantern-ring-contract.md).
- Two modes: WebXR AR (Chrome on Android with ARCore: real surfaces via hit-test, camera image read
  back for hand tracking) and camera mode (getUserMedia; mirror mode on the front camera).

## Status of each file in `public/lantern/`

| File | State |
| --- | --- |
| `index.html` | Done (start screen with AR / mirror / camera modes). Not yet run against the modules. |
| `js/main.js` | First draft of all game rules, written against the contract. Needs adjusting to the modules' real APIs, then testing. |
| `js/config.js`, `js/camera.js`, `js/gyro.js`, `js/fx.js` | Built and self-tested by the stage agent. Independent review not done. |
| `js/filters.js`, `js/hands.js`, `js/occluder.js` | Written by the hands agent, which was stopped before it reported back. Treat as unfinished: re-test against the contract. |
| `js/ring.js` | Not started. |
| `js/lantern.js`, `js/surface.js` | Not started. |
| `js/energy.js`, `js/constructs.js` | Not started. |
| `js/xr.js` | Not started. |
| `js/voice.js`, `js/power.js`, `js/audio.js`, `js/ui.js` | Not started. |

## To resume

1. Build the missing modules (ring, lantern + surface, energy + constructs, xr, voice/power/audio/ui)
   against the contract, and finish/verify hands.
2. Adjust `main.js` to the real module APIs.
3. Run the end-to-end browser test with synthetic hands and a fake microphone, then publish the
   `public/lantern/` folder to `gh-pages` (copy the folder to the branch root).
