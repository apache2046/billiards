'use strict';

// Published measurements the ball–rail, ball–slate and cloth models are
// calibrated against.  Each block names its source; the tolerances are the
// scatter of that data, not the model's own noise.
const assert = require('node:assert/strict');
global.window = global;
require('../js/math.js');
require('../js/physics.js');
const { PhysicsWorld } = BilliardsPhysics;
const D = 180 / Math.PI;
const rms = (list) => Math.sqrt(list.reduce((sum, x) => sum + x * x, 0) / list.length);

// A ball launched at the top rail from 3 mm away. `angle` is measured from
// the rail normal; top = ωR/v about the travel axis (1 roll, 0 stun, −1
// draw); side = ω_y R / v, positive running.  Returns the state right after
// the rail and once the post-rebound skid has ended.
function railShot(mode, { speed, angle, top = 1, side = 0 }) {
  const w = new PhysicsWorld(mode, { silent: true });
  const b = w.getCueBall(); w.balls = [b];
  const R = b.radius, H = w.table.height, a = angle / D;
  const vx = speed * Math.sin(a), vz = speed * Math.cos(a);
  Object.assign(b, {
    pos: { x: -0.6, z: H / 2 - R - 0.003 }, vel: { x: vx, z: vz }, posY: 0, velY: 0,
    omega: { x: top * vz / R, y: -side * speed / R, z: -top * vx / R }, state: 'sliding',
  });
  let event = null, after = null;
  w.onEvent((e) => { if (e.type === 'cushion' && !event) event = e; });
  for (let i = 0; i < 16000; i += 1) {
    w.step(0.0005);
    if (event && !after) after = { vx: b.vel.x, vz: b.vel.z, wx: b.omega.x };
    if (after && (Math.hypot(b.vel.x + b.omega.z * R, b.vel.z - b.omega.x * R) < 1e-3 || b.pos.z < -H / 2 + 0.1)) break;
  }
  assert.ok(event && after, `${mode}: rail shot missed the rail`);
  return {
    event,
    immediate: Math.atan2(Math.abs(after.vx), -after.vz) * D,
    effective: Math.atan2(Math.abs(b.vel.x), -b.vel.z) * D,
    e: -after.vz / vz,
    spinOut: after.wx * R / after.vz, // +1 rolling away from the rail, 0 stun
    speedAfterSkid: Math.hypot(b.vel.x, b.vel.z) / speed,
  };
}

// Dr Dave & Bob Jewett, TP B.11 (2009): slow rolling cue ball, no English,
// angles from the RAIL: immediate (high-speed video) and effective (where it
// next reached a rail).  Measured on a pool table.
{
  const data = [[10, 5, 3.5], [20, 10.5, 8.4], [30, 23, 16.9], [40, 37, 25.2], [50, 46, 35.7], [60, 56, 48.7], [70, 70, 64.1], [80, 79.95, 75.5]];
  const immediate = [], effective = [];
  for (const [incoming, measuredNow, measuredLater] of data) {
    const shot = railShot('eight', { speed: 0.6, angle: 90 - incoming });
    immediate.push(90 - shot.immediate - measuredNow);
    effective.push(90 - shot.effective - measuredLater);
  }
  assert.ok(rms(effective) < 2, `TP B.11 effective rebound angles off by ${rms(effective).toFixed(1)}° rms`);
  assert.ok(rms(immediate) < 4.5, `TP B.11 immediate rebound angles off by ${rms(immediate).toFixed(1)}° rms`);
}

// Dr Dave HSV B.15 (1000 fps, typical cloth), straight-in kicks: a rolling
// ball comes back at ≈72 % with about stun, a stunned ball leaves with
// topspin, and the ball "loses about half of its speed after rebound and
// skid"; TP B.6 uses a rolling-in rail COR of 0.7.
{
  const roll = railShot('eight', { speed: 1.5, angle: 0, top: 1 });
  const stun = railShot('eight', { speed: 1.5, angle: 0, top: 0 });
  assert.ok(roll.e > 0.66 && roll.e < 0.8, `rolling-in rail COR ${roll.e.toFixed(2)}`);
  assert.ok(Math.abs(roll.spinOut) < 0.3, `roll in should come out near stun, got ${roll.spinOut.toFixed(2)}`);
  assert.ok(stun.spinOut > 0.15, `stun in should come out with topspin, got ${stun.spinOut.toFixed(2)}`);
  assert.ok(roll.speedAfterSkid > 0.44 && roll.speedAfterSkid < 0.58, `speed after rebound and skid ${roll.speedAfterSkid.toFixed(2)}`);
  // The rail no longer erases the incoming spin: roll and stun leave differently.
  assert.ok(stun.spinOut - roll.spinOut > 0.25, 'incoming top/back spin must leave a mark off the rail');
}

// Dr Dave TP B.28: fast (sliding, no top or draw) banks on a 9-ft table go
// "twice plus 10 %" — tan(in)/tan(out) from the normal ≈ 1.17–1.32.
for (const angle of [10, 20, 30, 40, 50]) {
  const shot = railShot('eight', { speed: 2, angle, top: 0 });
  const ratio = Math.tan(angle / D) / Math.tan(shot.effective / D);
  assert.ok(ratio > 1.1 && ratio < 1.32, `stun bank at ${angle}°: tan ratio ${ratio.toFixed(2)}`);
}

// Dr Dave (bank/kick effects): running English leaves the rail with more
// speed and a longer angle, reverse English with less.
{
  const run = railShot('eight', { speed: 1.5, angle: 30, side: 1 });
  const none = railShot('eight', { speed: 1.5, angle: 30 });
  const reverse = railShot('eight', { speed: 1.5, angle: 30, side: -1 });
  assert.ok(run.speedAfterSkid > none.speedAfterSkid && none.speedAfterSkid > reverse.speedAfterSkid, 'running/reverse English speed order');
  assert.ok(run.effective > none.effective + 8 && none.effective > reverse.effective + 3, 'running/reverse English angle order');
  // Straight in, more side means a wider throw off the rail, and a lot of it.
  const angles = [0.5, 1, 1.5].map((s) => railShot('eight', { speed: 1.2, angle: 0, side: s }).effective);
  assert.ok(angles[0] > 8 && angles[1] > angles[0] + 6 && angles[2] > angles[1] + 3 && angles[2] > 24, `straight-in English throw ${angles.map((a) => a.toFixed(1))}`);
}

// Mathavan, Jackson & Parkin (Am. J. Phys. 2009): rolling snooker ball
// driven straight into the cushion, rebound/incident speed from high-speed
// video.  The 31 shots scatter over ≈0.87–0.95 below 2.5 m/s and ≈0.81–0.85
// at 2.7–3.4 m/s (the paper's quadratic fit peaks at 0.95 near 1 m/s); the
// targets follow the middle of that scatter.
for (const [speed, measured] of [[0.5, 0.9], [1.5, 0.895], [2, 0.88], [3, 0.845]]) {
  const shot = railShot('snooker', { speed, angle: 0 });
  assert.ok(Math.abs(shot.event.restitution - measured) < 0.03, `snooker COR at ${speed} m/s: ${shot.event.restitution.toFixed(3)}`);
}

// Dr Dave TP B.10: a 5.0 m/s draw stroke with 34.84 rev/s of backspin keeps
// 31.43 rev/s over 2 ft level, 30.12 from a 5° cue and 27.42 from 12°: the
// slate's reaction to an elevated stroke is a sliding friction contact.
{
  const world = new PhysicsWorld('eight', { silent: true });
  let tipY = -0.6, speed = 7;
  for (let i = 0; i < 40; i += 1) {
    const m = world.cueImpactMetrics({ direction: { x: 1, z: 0 }, speed, tipY, elevation: 0 });
    speed *= 5.0 / m.speed;
    tipY = Math.max(-m.safeOffset * 0.999, tipY * 34.84 / (Math.abs(m.omega.z) / (2 * Math.PI)));
  }
  for (const [elevation, measured] of [[0, 31.43], [5, 30.12], [12, 27.42]]) {
    const w = new PhysicsWorld('eight', { silent: true });
    const c = w.getCueBall(); w.balls = [c]; c.pos = { x: -1, z: 0 };
    w.strike({ direction: { x: 1, z: 0 }, speed, tipY, elevation });
    for (let i = 0; i < 5000 && c.pos.x < -1 + 0.6096; i += 1) w.step(0.0002);
    const rev = Math.abs(c.omega.z) / (2 * Math.PI);
    assert.ok(Math.abs(rev - measured) < 0.3, `TP B.10 ${elevation}°: ${rev.toFixed(2)} rev/s vs ${measured}`);
  }
}

// Dr Dave TP B.2 / physical-properties FAQ: sidespin on the cloth decays at a
// roughly constant ≈10 rad/s² (5–15), independent of how fast it spins.
{
  const decay = (spin) => {
    const w = new PhysicsWorld('eight', { silent: true });
    const b = w.getCueBall(); w.balls = [b];
    b.omega = { x: 0, y: spin, z: 0 }; b.state = 'spinning';
    for (let i = 0; i < 1000; i += 1) w.step(0.001);
    return spin - b.omega.y;
  };
  const slow = decay(20), fast = decay(120);
  assert.ok(slow > 5 && slow < 15, `sidespin decay ${slow.toFixed(1)} rad/s²`);
  assert.ok(Math.abs(fast - slow) < 1e-6, 'sidespin decay must not depend on the spin rate');
}

console.log('CueLab reference data passed (TP B.11 rebound angles, HSV B.15 straight-in kicks, TP B.28 banks, running/reverse English, Mathavan snooker COR, TP B.10 elevated draw, TP B.2 spin decay).');
