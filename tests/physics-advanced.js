'use strict';

const assert = require('node:assert/strict');
global.window = global;
require('../js/math.js');
require('../js/physics.js');
require('../js/drills.js');
const { PhysicsWorld, cushionFrame } = BilliardsPhysics;
const { createDrill } = BilliardsDrills;
const { V2, V3 } = BilliardsMath;
const G = 9.81;
const near = (a, b, tolerance, message) => assert.ok(Math.abs(a - b) <= tolerance, `${message}: ${a} vs ${b}`);
function rig(pair = false) {
  const w = new PhysicsWorld('chineseEight', { silent: true }), c = w.getCueBall(), o = w.getBall('1');
  w.balls = pair ? [c, o] : [c]; c.pos = { x: 0, z: 0 };
  return { w, c, o, R: c.radius };
}
function simulate(w, dt, seconds, done = () => false) {
  for (let i = 0; i < Math.ceil(seconds / dt); i += 1) { w.step(dt); if (done() || !w.isMoving()) break; }
}

// The two audit counterexamples and a same-height control. Sphere centres,
// not a magic height threshold plus a 2D disk, determine physical overlap.
for (const [dx, dy, overlap] of [[0.055, 0.030, false], [0.030, 0.047, true], [0.055, 0, true]]) {
  const { w, c, o, R } = rig(true);
  c.pos.x = -dx; c.posY = dy; c.vel.x = 1; o.pos = { x: 0, z: 0 };
  assert.equal(Math.hypot(dx, dy) < 2 * R, overlap);
  assert.equal(Boolean(w.pairContact(c, o, 0.001)), overlap);
  let hit = null; w.onEvent(e => { if (e.type === 'ball-ball') hit = e; });
  w.resolveBallPairs(0.001);
  assert.equal(Boolean(hit), overlap);
  if (!overlap) { assert.equal(o.vel.x, 0); assert.equal(c.vel.x, 1); }
  else if (dy > 0) { assert.ok(hit.normal.y < -0.5); assert.ok(c.velY > 0); assert.ok(o.velY >= -1e-10); }
}

// Closed-form central collisions at arbitrary spatial orientations/masses:
// normal impulse and momentum are three-dimensional, with no spurious torque.
for (const n of [{ x: 0.8, y: 0.6, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0.6, y: -0.48, z: 0.64 }]) {
  for (const mass of [0.1695, 0.23]) {
    const { w, c, o, R } = rig(true);
    o.mass = mass; o.inertia = 0.4 * mass * R * R;
    c.pos = { x: -2 * R * n.x, z: -2 * R * n.z }; c.posY = 0.2;
    o.pos = { x: 0, z: 0 }; o.posY = c.posY + 2 * R * n.y;
    c.vel = { x: 2 * n.x, z: 2 * n.z }; c.velY = 2 * n.y;
    const e = w.params.restitutionBall, before = w.totalEnergy();
    w.resolveContactCluster([{ a: c, b: o }], [c, o], 0);
    const va = 2 * (c.mass - e * o.mass) / (c.mass + o.mass), vb = 2 * (1 + e) * c.mass / (c.mass + o.mass);
    for (const [axis, ca, ob] of [['x', c.vel.x, o.vel.x], ['y', c.velY, o.velY], ['z', c.vel.z, o.vel.z]]) {
      near(ca, va * n[axis], 1e-9, `spatial cue ${axis}`);
      near(ob, vb * n[axis], 1e-9, `spatial object ${axis}`);
    }
    near(Math.hypot(c.omega.x, c.omega.y, c.omega.z), 0, 1e-9, 'central hit adds no torque');
    assert.ok(w.totalEnergy() <= before + 1e-10);
  }
}

// Spin and glancing friction conserve spatial linear/angular momentum in
// free flight. The floor is intentionally absent from these impulse tests.
function momentum(balls) {
  const p = { x: 0, y: 0, z: 0 }, l = { x: 0, y: 0, z: 0 };
  for (const b of balls) {
    const v = { x: b.vel.x, y: b.velY, z: b.vel.z }, pos = { x: b.pos.x, y: b.posY + b.radius, z: b.pos.z };
    const orbital = V3.cross(pos, v);
    for (const axis of ['x', 'y', 'z']) { p[axis] += b.mass * v[axis]; l[axis] += b.mass * orbital[axis] + b.inertia * b.omega[axis]; }
  }
  return { p, l };
}
for (const sign of [-1, 1]) {
  const { w, c, o, R } = rig(true), n = { x: 0.8, y: 0.36, z: sign * 0.48 };
  c.pos = { x: -2 * R * n.x, z: -2 * R * n.z }; c.posY = 0.2;
  o.pos = { x: 0, z: 0 }; o.posY = c.posY + 2 * R * n.y;
  c.vel.x = 2; c.omega = { x: 15 * sign, y: -40 * sign, z: -50 };
  const before = momentum(w.balls), energy = w.totalEnergy();
  w.resolveContactCluster([{ a: c, b: o }], [c, o], 0);
  const after = momentum(w.balls);
  for (const part of ['p', 'l']) for (const axis of ['x', 'y', 'z']) near(after[part][axis], before[part][axis], 1e-10, `conserved ${part}/${axis}`);
  assert.ok(w.totalEnergy() < energy);
}

// A floor contact can push but not pull. A ball below the slate lip can lift
// a supported ball, while a descending ball cannot drive one through the bed.
for (const sign of [-1, 1]) {
  const { w, c, o, R } = rig(true), ny = 0.4 * sign, nx = Math.sqrt(1 - ny * ny);
  c.pos = { x: -2 * R * nx, z: 0 }; c.posY = -2 * R * ny;
  if (c.posY < 0) c.pocketFall = 'test-lip';
  o.pos = { x: 0, z: 0 }; c.vel.x = 2;
  const before = w.totalEnergy();
  w.resolveContactCluster([{ a: c, b: o }], [c, o], 0);
  assert.ok(o.velY >= -1e-9, 'slate failed to support the lower ball');
  if (sign > 0) assert.ok(o.velY > 0.1, 'slate pulled the lifted ball down');
  assert.ok(w.totalEnergy() <= before + 1e-9, 'slate/ball impulses created energy');
}

// Seeded spatial stress tests exercise arbitrary orientations, relative
// velocities and spin, both with and without a supported lower ball.
{
  let seed = 2046;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 600; i += 1) {
    const { w, c: a, o: b, R } = rig(true);
    const n = V3.normalize({ x: random() - 0.5, y: random() - 0.5, z: random() - 0.5 });
    a.pos = { x: -2 * R * n.x, z: -2 * R * n.z }; b.pos = { x: 0, z: 0 };
    b.posY = i % 2 ? 0 : 0.2; a.posY = b.posY - 2 * R * n.y;
    if (a.posY < 0) a.pocketFall = 'test-lip';
    for (const ball of w.balls) {
      ball.vel = { x: 4 * (random() - 0.5), z: 4 * (random() - 0.5) };
      ball.velY = ball.posY <= 0 ? 0 : 4 * (random() - 0.5);
      ball.omega = { x: 200 * (random() - 0.5), y: 200 * (random() - 0.5), z: 200 * (random() - 0.5) };
    }
    const closing = (b.vel.x - a.vel.x) * n.x + (b.velY - a.velY) * n.y + (b.vel.z - a.vel.z) * n.z;
    const correction = closing + 0.1 + 4 * random();
    a.vel.x += n.x * correction; a.velY += n.y * correction; a.vel.z += n.z * correction;
    const energy = w.totalEnergy(), before = momentum(w.balls);
    w.resolveContactCluster([{ a, b }], [a, b], 0);
    assert.ok(w.totalEnergy() <= energy + 1e-9, `spatial case ${i}: energy creation / nonfinite state`);
    if (b.posY === 0) assert.ok(b.velY >= -1e-9, `spatial case ${i}: slate penetration`);
    else {
      const after = momentum(w.balls);
      for (const part of ['p', 'l']) for (const axis of ['x', 'y', 'z'])
        near(after[part][axis], before[part][axis], 1e-9, `spatial case ${i}: ${part}/${axis}`);
    }
  }
}

// Symmetric simultaneous airborne contacts cannot acquire array-order bias.
function airborneSplit(swap, dt) {
  const { w, c, o, R } = rig(true), two = new PhysicsWorld('chineseEight').getBall('2');
  w.balls = swap ? [c, two, o] : [c, o, two];
  c.pos = { x: -0.12, z: 0 }; c.vel.x = 3;
  o.pos = { x: 0, z: R }; two.pos = { x: 0, z: -R };
  for (const b of w.balls) b.posY = 0.2;
  const before = w.totalEnergy(); simulate(w, dt, 0.05);
  assert.ok(w.totalEnergy() <= before + 1e-8);
  return { c, o, two };
}
for (const dt of [0.001, 0.0001]) {
  const a = airborneSplit(false, dt), b = airborneSplit(true, dt);
  near(a.o.vel.x, a.two.vel.x, 1e-8, 'airborne split speed symmetry');
  near(a.o.vel.z, -a.two.vel.z, 1e-8, 'airborne split direction symmetry');
  near(a.o.vel.x, b.o.vel.x, 1e-8, 'airborne split order');
  near(a.c.vel.z, 0, 1e-8, 'airborne split cue drift');
}

// Raised nose: orthonormal tangents and an independent single-substep force
// balance, including the vertical friction contribution to the slate load.
for (const angle of [0, 0.7, 2.1, Math.PI]) for (const vertical of [-0.49, -0.295, 0, 0.3]) {
  const f = cushionFrame(Math.cos(angle), Math.sin(angle), vertical);
  for (const v of Object.values(f)) near(V3.dot(v, v), 1, 1e-12, 'unit cushion basis');
  near(V3.dot(f.normal, f.up), 0, 1e-12, 'nose friction must be tangent');
  near(V3.dot(f.tangent, f.up), 0, 1e-12, 'orthogonal nose tangents');
}
{
  const { w, c, R } = rig(), depth = 0.0001, dt = 0.000001;
  c.pos = { x: w.table.width / 2 - R + depth, z: 0.1 }; c.vel.x = 1; c.omega.z = -80;
  const sin = (w.table.cushionContactHeight - R) / R, cos = Math.sqrt(1 - sin * sin);
  const fn = 1.5e7 * depth ** 1.5 * (1 + w.cushionDamping());
  const ff = w.params.frictionCushion * fn;
  const load = c.mass * G + fn * sin - ff * cos;
  const slate = w.params.muSlide * load;
  const expectedV = 1 + (-fn * cos - ff * sin + slate) / c.mass * dt;
  const expectedW = -80 + R * (ff + slate) / c.inertia * dt;
  w.beginRailContact(c, { nx: -1, nz: 0, id: 'right', depth }, 1);
  w.integrateRailContact(c, dt, dt);
  near(c.vel.x, expectedV, 1e-10, 'raised nose horizontal force');
  near(c.omega.z, expectedW, 1e-9, 'raised nose friction torque');
  near(c.railContact.downImpulse, (fn * sin - ff * cos) * dt, 1e-11, 'complete slate load');
}

let railCases = 0;
for (const v of [0.2, 0.5, 1, 2, 4, 6]) for (const vz of [0, 0.5, 2])
for (const ratio of [-8, -2, 0, 1, 4, 8]) for (const side of [-100, 0, 100]) {
  const { w, c, R } = rig();
  c.pos = { x: w.table.width / 2 - R - 0.001, z: 0.1 }; c.vel = { x: v, z: vz };
  c.omega = { x: vz / R, y: side, z: -ratio * v / R };
  const before = w.totalEnergy(); let event;
  w.onEvent(e => { if (e.type === 'cushion') event = e; });
  simulate(w, 0.0001, 0.1, () => Boolean(event));
  assert.ok(event, 'energy sweep missed its rail');
  assert.ok(w.totalEnergy() <= before + 1e-7, 'completed rail contact created energy');
  railCases += 1;
}
{
  const { w, c, R } = rig(); c.pos = { x: w.table.width / 2 - R - 0.001, z: 0 };
  c.vel.x = 5; w.params.muSlide = w.params.muRoll = w.params.frictionCushion = 0; w.cushionDamping = () => 0;
  const before = w.totalEnergy(); let hit = false;
  w.onEvent(e => { if (e.type === 'cushion') hit = true; }); simulate(w, 0.00001, 0.1, () => hit);
  assert.ok(hit); assert.ok(w.totalEnergy() <= before * 1.0001, 'rail hop manufactured energy');
}

// Long draw must retain the right sign until impact and reach the BACK rail,
// without a returning object ball supplying a second, hidden impulse.
function longDraw(power, tipY, dt) {
  const { w, c, o, R } = rig(true); c.pos.x = -1.1; o.pos = { x: -1.1 + 1.8 + 2 * R, z: 0 };
  let contact = null, rail = null;
  w.onEvent(e => {
    if (e.type === 'ball-ball' && !contact) { contact = { x: c.pos.x }; o.pocketed = true; o.sinkTarget = null; }
    if (e.type === 'cushion' && e.ballId === 'cue') rail = e;
  });
  w.strike({ direction: { x: 1, z: 0 }, speed: 0.18 + 6.15 * power ** 1.34, tipY, elevation: Math.atan2(0.034, 0.22) * 180 / Math.PI });
  let minX = Infinity;
  simulate(w, dt, 12, () => { if (contact) minX = Math.min(minX, c.pos.x); return Boolean(rail); });
  return { c, contact, rail, retreat: contact.x - minX };
}
const deep = longDraw(0.8, -0.65, 0.001), deepFine = longDraw(0.8, -0.65, 0.0001);
assert.equal(deep.rail?.cushionId, 'left'); assert.ok(deep.c.vel.x > 0.1); assert.ok(deep.retreat > 1.9);
near(deep.retreat, deepFine.retreat, 0.005, 'long draw step convergence');
assert.equal(longDraw(0.62, -0.45, 0.001).rail, null, 'weak shallow draw should not magically retain backspin');

// Free sliding must agree with the rigid-sphere analytic velocity and
// parabolic position, independent of cloth coefficient or English mirror.
// TP A.19 / TP A.4: v_roll = (5 vx - 2 R wz, 5 vz + 2 R wx) / 7.
for (const elevation of [10, 26, 45, 60]) for (const sign of [-1, 1]) for (const dt of [0.001, 0.0001]) {
  const { w, c, R } = rig(); w.table.clothNapStrength = 0; w.params.muRoll = 0;
  w.resolveCushions = () => {}; w.checkPocket = () => {};
  w.strike({ direction: { x: 1, z: 0 }, speed: 3, tipX: 0.45 * sign, elevation });
  c.velY = 0; // Isolate cloth dynamics, not the uncalibrated launch model.
  const v0 = { ...c.vel }, wx = c.omega.x, wz = c.omega.z;
  const slip = { x: v0.x + R * wz, z: v0.z - R * wx }, mag = V2.length(slip), a = w.params.muSlide * G;
  const transition = mag / (3.5 * a), steps = Math.floor(transition / dt);
  for (let i = 0; i < steps; i += 1) w.step(dt);
  const t = steps * dt;
  near(c.vel.x, v0.x - a * slip.x / mag * t, 1e-9, 'analytic sliding vx');
  near(c.vel.z, v0.z - a * slip.z / mag * t, 1e-9, 'analytic sliding vz');
  near(c.pos.x, v0.x * t - 0.5 * a * slip.x / mag * t * t, 0.001, 'parabolic curve x');
  near(c.pos.z, v0.z * t - 0.5 * a * slip.z / mag * t * t, 0.001, 'parabolic curve z');
  w.step(dt * 2);
  near(c.vel.x, (5 * v0.x - 2 * R * wz) / 7, 1e-9, 'rolling vx invariant');
  near(c.vel.z, (5 * v0.z + 2 * R * wx) / 7, 1e-9, 'rolling vz invariant');
}

// Use the SAME layouts as the UI. No object removal or state/force overrides.
function drill(kind, dt) {
  const { w, c, o, R } = rig(true), s = createDrill(kind, w.table, R);
  c.pos = { ...s.cue }; if (s.target) o.pos = { ...s.target }; else w.balls = [c];
  const back = V2.scale(s.aim, -1);
  const distances = [Math.abs(back.x) > 1e-6 ? (Math.sign(back.x) * w.table.width / 2 - c.pos.x) / back.x : Infinity,
    Math.abs(back.z) > 1e-6 ? (Math.sign(back.z) * w.table.height / 2 - c.pos.z) / back.z : Infinity];
  const distance = Math.min(...distances), clearance = distance > 1.45 ? 0 : Math.min(45, Math.atan2(0.034, distance + 0.05) * 180 / Math.PI);
  let pairs = 0, rails = [], height = 0;
  w.onEvent(e => { if (e.type === 'ball-ball') pairs += 1; if (e.type === 'cushion' && e.ballId === 'cue') rails.push(e); });
  w.strike({ direction: s.aim, speed: 0.18 + 6.15 * s.power ** 1.34, tipX: s.spin.x, tipY: s.spin.y, elevation: Math.max(s.elevation, clearance) });
  assert.equal(w.lastCueMetrics.miscue, false);
  simulate(w, dt, 12, () => { height = Math.max(height, c.posY); return kind === 'follow' ? rails.some(e => e.returned) : kind === 'draw' ? rails.length > 0 : false; });
  return { w, c, o, pairs, rails, height };
}
for (const dt of [0.001, 0.0001]) {
  const draw = drill('draw', dt), follow = drill('follow', dt), masse = drill('masse', dt);
  assert.ok(draw.o.pocketed && draw.pairs === 1 && draw.rails.length > 0, 'long-draw preset failed its complete two-ball shot');
  assert.ok(follow.o.pocketed && follow.pairs === 1 && follow.rails.some(e => e.returned), 'follow preset did not pot and return');
  assert.ok(follow.rails.find(e => e.returned).returnDistance > 0.05);
  assert.ok(masse.height > 0 && masse.pairs === 0 && masse.c.pos.z > 0.1, 'massé preset did not curve around the obstacle');
}

// An ordinary rolling ball must not be reported as absorption. Observation
// state must survive undo/clone without aliasing, and new strokes clear it.
{
  const { w, c, R } = rig(); c.pos = { x: w.table.width / 2 - R - 0.01, z: 0 };
  c.vel.x = 0.5; c.omega.z = -c.vel.x / R;
  let event; w.onEvent(e => { if (e.type === 'cushion') event = e; }); simulate(w, 0.001, 1, () => Boolean(event));
  near(event.spinRatio, 1, 1e-9, 'ordinary rolling spin ratio'); assert.equal(event.returned, false);
  const clone = w.clone(), snapshot = w.snapshot();
  assert.notEqual(clone.getCueBall().railTravel, c.railTravel);
  clone.getCueBall().railTravel.maxDistance = 10;
  assert.ok(c.railTravel.maxDistance < 1);
  w.restore(snapshot); assert.deepEqual(w.getCueBall().railTravel, snapshot.balls[0].railTravel);
  simulate(w, 0.001, 10); w.strike({ direction: { x: 1, z: 0 }, speed: 0.3 });
  assert.equal(w.getCueBall().railTravel, null);
}

console.log(`CueLab advanced physics passed (600 spatial cases, raised-nose forces, ${railCases} rail energy cases, draw/follow/massé drills, analytic curves, observation isolation).`);
