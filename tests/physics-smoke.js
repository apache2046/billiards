'use strict';

const assert = require('node:assert/strict');
global.window = global;
require('../js/math.js');
require('../js/physics.js');
require('../js/renderer.js');

const { PhysicsWorld } = global.BilliardsPhysics;

// With gl.cullFace(BACK) and the default CCW front face, every triangle of a
// closed convex mesh must wind so its geometric normal points outward.  An
// inverted mesh still "renders", but shows its mirror-image inner wall — on
// the sphere that made rolling balls appear to spin backwards.
{
  const { sphereGeometry, cylinderGeometry, cubeGeometry } = global.BilliardsRenderer.geometry;
  const check = (name, geometry, centre = [0, 0, 0]) => {
    const p = geometry.positions, idx = geometry.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const [ia, ib, ic] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
      const ax = p[ia], ay = p[ia + 1], az = p[ia + 2];
      const e1 = [p[ib] - ax, p[ib + 1] - ay, p[ib + 2] - az];
      const e2 = [p[ic] - ax, p[ic + 1] - ay, p[ic + 2] - az];
      const n = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ];
      if (n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-12) continue; // degenerate pole triangle
      const cx = (ax + p[ib] + p[ic]) / 3 - centre[0];
      const cy = (ay + p[ib + 1] + p[ic + 1]) / 3 - centre[1];
      const cz = (az + p[ib + 2] + p[ic + 2]) / 3 - centre[2];
      const outward = n[0] * cx + n[1] * cy + n[2] * cz;
      assert.ok(outward > 1e-9, `${name}: triangle ${i / 3} winds inward (would cull the visible side)`);
    }
  };
  check('sphere', sphereGeometry(12, 16));
  check('cylinder', cylinderGeometry(14));
  check('tapered cylinder', cylinderGeometry(14, 1, 1.6));
  check('cube', cubeGeometry());
}

function assertNoRackOverlap(world) {
  for (let i = 0; i < world.balls.length; i += 1) {
    for (let j = i + 1; j < world.balls.length; j += 1) {
      const a = world.balls[i], b = world.balls[j];
      const distance = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
      assert.ok(distance >= a.radius + b.radius - 1e-7, `${world.mode}: ${a.id} overlaps ${b.id}`);
    }
  }
}

for (const mode of ['chineseEight', 'practice', 'eight', 'nine', 'snooker']) {
  const world = new PhysicsWorld(mode, { silent: true });
  assertNoRackOverlap(world);
  const direction = mode === 'snooker' ? { x: 1, z: 0.22 } : { x: 1, z: 0 };
  const prediction = world.predictShot({ direction, speed: 3.4, tipX: 0.22, tipY: -0.25, elevation: 7 });
  assert.ok(prediction.paths.get('cue').length > 3, `${mode}: missing cue path`);
  assert.ok([...prediction.paths.values()].flat().every((p) => Number.isFinite(p.x) && Number.isFinite(p.z)), `${mode}: non-finite path`);
  assert.ok(prediction.cueDistance > 0.1, `${mode}: cue did not travel`);
}

// A centre-ball shot starts in sliding motion and settles into rolling before stopping.
{
  const world = new PhysicsWorld('practice', { silent: true });
  world.balls = [world.getCueBall()];
  assert.equal(world.strike({ direction: { x: 1, z: 0 }, speed: 2, tipX: 0, tipY: 0, elevation: 0 }), true);
  let observedRolling = false;
  for (let i = 0; i < 4500; i += 1) {
    world.step(1 / 300);
    if (world.getCueBall().state === 'rolling') observedRolling = true;
    if (!world.isMoving()) break;
  }
  assert.equal(observedRolling, true, 'sliding never transitioned to rolling');
  assert.ok(world.getCueBall().lastSpeed < 0.01, 'ball failed to settle');
}

// Default Chinese-eight setup follows the 9-foot Q8-style playing area and tight,
// rounded 85 mm Q8 mouths.  The 8 is centred and the rear corners are opposite groups.
{
  const world = new PhysicsWorld(undefined, { silent: true });
  assert.equal(world.mode, 'chineseEight');
  assert.equal(world.table.name, '乔氏金腿式赛事台');
  assert.equal(world.table.width, 2.54);
  assert.equal(world.table.height, 1.26);
  assert.ok(Math.abs(2 * world.table.sideGap - 2 * world.table.jawRadius - 0.085) < 1e-9);
  assert.ok(Math.abs(Math.sqrt(2) * (world.table.cornerGap + world.table.jawRadius) - 2 * world.table.jawRadius - 0.085) < 1e-9);
  assert.equal(world.table.jaws.length, 12, 'six pockets must have two physical jaws each');
  for (const jaw of world.table.jaws) {
    const centreAtContact = {
      x: jaw.tangent.x + jaw.normal.x * world.params.radius,
      z: jaw.tangent.z + jaw.normal.z * world.params.radius,
    };
    const dx = centreAtContact.x - jaw.x, dz = centreAtContact.z - jaw.z;
    const distance = Math.hypot(dx, dz);
    assert.ok(Math.abs(distance - jaw.radius - world.params.radius) < 1e-9, `${jaw.id}: jaw is not tangent to rail`);
    assert.ok(Math.abs(dx / distance - jaw.normal.x) < 1e-9 && Math.abs(dz / distance - jaw.normal.z) < 1e-9,
      `${jaw.id}: jaw normal is discontinuous at tangent`);
  }
  const eight = world.getBall('8');
  assert.ok(Math.abs(eight.pos.z) < 1e-9, '8 ball is not in the rack centre');
  const rear = world.balls.filter((ball) => ball.number === 13 || ball.number === 7);
  assert.deepEqual(new Set(rear.map((ball) => ball.kind)), new Set(['solid', 'stripe']));
}

// The two sides of every straight-to-round tangent must give nearly the same
// rebound.  This guards against the old square-end/round-post normal jump.
function grazeTangent(jawId, straightSide) {
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall(); world.balls = [cue];
  const jaw = world.table.jaws.find((item) => item.id === jawId);
  const segment = world.table.cushions.find((item) => item.id === jaw.segmentId);
  const along = segment.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
  const endpoint = segment.axis === 'x' ? jaw.tangent.x : jaw.tangent.z;
  const straightSign = Math.abs(endpoint - segment.min) < 1e-9 ? 1 : -1;
  const offset = (straightSide ? 1 : -1) * straightSign * 0.001;
  cue.pos = {
    x: jaw.tangent.x + jaw.normal.x * (cue.radius + 0.005) + along.x * offset,
    z: jaw.tangent.z + jaw.normal.z * (cue.radius + 0.005) + along.z * offset,
  };
  cue.vel = { x: -jaw.normal.x * 0.9, z: -jaw.normal.z * 0.9 };
  cue.omega = { x: cue.vel.z / cue.radius, y: 0, z: -cue.vel.x / cue.radius };
  let event = null;
  world.onEvent((item) => { if (!event && item.type === 'cushion') event = item; });
  for (let i = 0; i < 20 && !event; i += 1) world.step(1 / 300);
  return { cue, event, segment };
}
{
  const geometry = new PhysicsWorld('chineseEight', { silent: true });
  for (const jaw of geometry.table.jaws) {
    const straight = grazeTangent(jaw.id, true);
    const round = grazeTangent(jaw.id, false);
    assert.ok(straight.event && round.event, `${jaw.id}: tangent-side collision was missed`);
    assert.equal(straight.event.cushionId, straight.segment.id, `${jaw.id}: straight side used wrong collider`);
    assert.equal(round.event.cushionId, jaw.id, `${jaw.id}: round side used wrong collider`);
    assert.ok(Math.hypot(straight.cue.vel.x - round.cue.vel.x, straight.cue.vel.z - round.cue.vel.z) < 0.08,
      `${jaw.id}: straight/round rebound is discontinuous at the common tangent`);
  }
}

// A low-front-mass small-tip cue produces less initial squirt than the large-tip
// preset.  Harder leather also exposes a smaller chalk/friction-safe hit zone.
{
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const shot = { direction: { x: 1, z: 0 }, speed: 4, tipX: 0.68, tipY: 0.18, elevation: 4 };
  world.setCueType('small'); world.setTipType('medium');
  const small = world.cueImpactMetrics(shot);
  world.setCueType('large');
  const large = world.cueImpactMetrics(shot);
  assert.ok(Math.abs(small.squirt) < Math.abs(large.squirt), 'small-tip low-deflection cue should squirt less');
  world.setTipType('soft'); const soft = world.cueImpactMetrics(shot);
  world.setTipType('hard'); const hard = world.cueImpactMetrics(shot);
  assert.ok(hard.safeOffset < soft.safeOffset, 'hard tip should have the smaller friction-safe zone');
}

function cushionRig({ sideSpin = 0, topSpin = null }) {
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall();
  world.balls = [cue];
  cue.pos = { x: world.table.width / 2 - cue.radius + 0.0001, z: 0 };
  cue.vel = { x: 2, z: 0.7 };
  cue.omega = { x: cue.vel.z / cue.radius, y: sideSpin, z: topSpin == null ? -cue.vel.x / cue.radius : topSpin };
  const energyBefore = world.totalEnergy();
  let event = null;
  world.onEvent((item) => { if (item.type === 'cushion') event = item; });
  world.step(1 / 300);
  return { world, cue, event, energyBefore, energyAfter: world.totalEnergy() };
}

// Running English opens the rail angle; reverse English closes it.  Low-speed
// contact may enter the no-slip/soft-English region through the same solver.
{
  const running = cushionRig({ sideSpin: 50 });
  const reverse = cushionRig({ sideSpin: -50 });
  assert.equal(running.event.english, 'running');
  assert.equal(reverse.event.english, 'reverse');
  assert.ok(running.event.reboundAngle > reverse.event.reboundAngle + 8, 'English did not materially change the rail angle');
}

// Follow and draw participate in the raised cushion-nose contact.  Follow gives
// the stronger normal rebound here, while neither collision creates energy.
{
  const R = new PhysicsWorld('chineseEight', { silent: true }).params.radius;
  const follow = cushionRig({ topSpin: -2 / R });
  const draw = cushionRig({ topSpin: 2 / R });
  assert.ok(Math.abs(follow.cue.vel.x) > Math.abs(draw.cue.vel.x), 'follow/draw rail-speed ordering is wrong');
  assert.ok(follow.energyAfter <= follow.energyBefore + 1e-9, 'follow cushion impact created energy');
  assert.ok(draw.energyAfter <= draw.energyBefore + 1e-9, 'draw cushion impact created energy');
}

// Balls frozen on every straight cushion and every rounded jaw must be pushed
// to the shared visible boundary and remain stable without jitter or embedding.
{
  const geometry = new PhysicsWorld('chineseEight', { silent: true });
  for (const source of geometry.table.cushions) {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    const along = (source.min + source.max) / 2;
    cue.pos = source.axis === 'x'
      ? { x: along, z: source.value + source.normal.z * (cue.radius - 1e-7) }
      : { x: source.value + source.normal.x * (cue.radius - 1e-7), z: along };
    cue.vel = { x: 0, z: 0 }; cue.omega = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i += 1) world.step(1 / 300);
    const signed = source.axis === 'x'
      ? (cue.pos.z - source.value) * source.normal.z
      : (cue.pos.x - source.value) * source.normal.x;
    assert.ok(signed >= cue.radius - 2e-5, `${source.id}: frozen ball remained inside straight cushion`);
    assert.equal(cue.state, 'stationary');
  }
  for (const source of geometry.table.jaws) {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    cue.pos = {
      x: source.x + source.normal.x * (source.radius + cue.radius - 1e-7),
      z: source.z + source.normal.z * (source.radius + cue.radius - 1e-7),
    };
    cue.vel = { x: 0, z: 0 }; cue.omega = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 120; i += 1) world.step(1 / 300);
    const distance = Math.hypot(cue.pos.x - source.x, cue.pos.z - source.z);
    assert.ok(distance >= source.radius + cue.radius - 2e-5, `${source.id}: frozen ball remained inside jaw`);
    assert.equal(cue.state, 'stationary');
  }
}

// With elevation, the side-spin axis tilts and the ordinary cloth-slip solver
// bends the path back toward the English side (swerve), opposing initial squirt.
function lateralAtOnePointTwoMetres(elevation) {
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall(); world.balls = [cue]; cue.pos = { x: -0.8, z: 0 };
  world.strike({ direction: { x: 1, z: 0 }, speed: 3, tipX: 0.65, tipY: 0, elevation });
  for (let i = 0; i < 1000 && cue.pos.x < 0.4; i += 1) world.step(1 / 300);
  return cue.pos.z;
}
{
  const level = lateralAtOnePointTwoMetres(0);
  const elevated = lateralAtOnePointTwoMetres(8);
  assert.ok(level < 0, 'level side-English shot is missing initial squirt');
  assert.ok(elevated > level + 0.02, 'elevated side-English shot is missing cloth-driven swerve');
}

// Side-pocket capture and sink state.
{
  const world = new PhysicsWorld('practice', { silent: true });
  const cue = world.getCueBall();
  world.balls = [cue];
  cue.pos = { x: 0, z: -world.table.height / 2 + cue.radius * 1.2 };
  cue.vel = { x: 0, z: -0.8 };
  for (let i = 0; i < 120 && !cue.pocketed; i += 1) world.step(1 / 300);
  assert.equal(cue.pocketed, true, 'side pocket did not capture the ball');
  assert.equal(cue.state, 'pocketed');
  assert.ok(cue.sinkTarget, 'pocketed ball is missing a continuous sink target');
}

// A centred path through each of the six mouths must cross the arc throat
// before capture, then continue into the liner instead of freezing or teleporting.
{
  const geometry = new PhysicsWorld('chineseEight', { silent: true });
  for (const source of geometry.table.pockets) {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    const pocket = world.table.pockets.find((item) => item.id === source.id);
    cue.pos = {
      x: pocket.throat.x - pocket.outward.x * 0.070,
      z: pocket.throat.z - pocket.outward.z * 0.070,
    };
    cue.vel = { x: pocket.outward.x * 0.85, z: pocket.outward.z * 0.85 };
    let previous = { ...cue.pos }, maxStep = 0;
    for (let i = 0; i < 180 && !cue.pocketed; i += 1) {
      world.step(1 / 300);
      maxStep = Math.max(maxStep, Math.hypot(cue.pos.x - previous.x, cue.pos.z - previous.z));
      previous = { ...cue.pos };
    }
    assert.equal(cue.pocketId, pocket.id, `${pocket.id}: centred shot was not captured by the intended pocket`);
    assert.ok(maxStep < 0.008, `${pocket.id}: mouth caused a discontinuous position correction`);
    const distanceBefore = Math.hypot(cue.pos.x - cue.sinkTarget.x, cue.pos.z - cue.sinkTarget.z);
    for (let i = 0; i < 25; i += 1) world.step(1 / 300);
    const distanceAfter = Math.hypot(cue.pos.x - cue.sinkTarget.x, cue.pos.z - cue.sinkTarget.z);
    assert.ok(distanceAfter < distanceBefore, `${pocket.id}: animation did not continue into the liner`);
  }
}

// Squirt must match the rigid-impulse end-mass model: roughly 1–3° at half-tip
// English for a low-deflection cue, and the aim allowance readout follows tan α.
{
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const impact = world.cueImpactMetrics({ direction: { x: 1, z: 0 }, speed: 3, tipX: 0.5, tipY: 0, elevation: 0 });
  const degrees = Math.abs(impact.squirt) * 180 / Math.PI;
  assert.ok(degrees > 0.9 && degrees < 3.2, `unphysical squirt magnitude ${degrees.toFixed(2)}°`);
  const allowance = impact.aimAllowancePerMetre * 1000;
  assert.ok(allowance > 14 && allowance < 60, `unphysical aim allowance ${allowance.toFixed(1)} mm/m`);
  const slow = world.cueImpactMetrics({ direction: { x: 1, z: 0 }, speed: 1, tipX: 0.5, tipY: 0, elevation: 0 });
  assert.ok(Math.abs(slow.squirt - impact.squirt) < 0.002, 'squirt should be nearly speed-independent');
}

// Elevating the cue drives part of the impulse into the slate: the surviving
// horizontal speed scales with cos(elevation) while spin is kept in full.
{
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const options = { direction: { x: 1, z: 0 }, speed: 3, tipX: 0, tipY: -0.5 };
  const flat = world.cueImpactMetrics({ ...options, elevation: 0 });
  const steep = world.cueImpactMetrics({ ...options, elevation: 30 });
  const ratio = steep.horizontalSpeed / flat.horizontalSpeed;
  assert.ok(Math.abs(ratio - Math.cos(30 * Math.PI / 180)) < 0.02, `elevation speed ratio ${ratio.toFixed(3)}`);
  assert.ok(Math.abs(steep.omega.z - flat.omega.z) / Math.abs(flat.omega.z) < 0.02,
    'draw spin should not lose a cos(elevation) factor');
}

// Ball-ball throw rig: drive the cue ball into a straight or cut contact with a
// controlled pre-impact state, then read the object ball's departure angle.
function throwRig({ objectZ = 0, sideSpin = 0, roll = 0, speed = 1.5 }) {
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall();
  const object = world.getBall('1');
  world.balls = [cue, object];
  const R = cue.radius;
  object.pos = { x: 0, z: objectZ };
  cue.pos = { x: -(2 * R + 0.0008), z: 0 };
  cue.vel = { x: speed, z: 0 };
  cue.omega = { x: 0, y: sideSpin, z: roll * -speed / R };
  const energyBefore = world.totalEnergy();
  const contactNormal = (() => {
    // Normal direction at the moment the gap closes, from the aim geometry.
    const dz = objectZ / (2 * R);
    return { x: Math.sqrt(Math.max(0, 1 - dz * dz)), z: dz };
  })();
  for (let i = 0; i < 60 && Math.hypot(object.vel.x, object.vel.z) < 0.02; i += 1) world.step(1 / 300);
  assert.ok(Math.hypot(object.vel.x, object.vel.z) > 0.02, 'throw rig failed to reach contact');
  const departure = Math.atan2(object.vel.z, object.vel.x);
  const lineAngle = Math.atan2(contactNormal.z, contactNormal.x);
  return {
    world, cue, object,
    throwDegrees: (departure - lineAngle) * 180 / Math.PI,
    energyBefore, energyAfter: world.totalEnergy(),
  };
}

// Left English throws the object ball to the shooter's right (and vice versa),
// soft contact throws more than firm contact, and no collision creates energy.
{
  const left = throwRig({ sideSpin: -30 });
  const right = throwRig({ sideSpin: 30 });
  assert.ok(left.throwDegrees > 0.8 && left.throwDegrees < 7, `left-English throw ${left.throwDegrees.toFixed(2)}°`);
  assert.ok(right.throwDegrees < -0.8 && right.throwDegrees > -7, `right-English throw ${right.throwDegrees.toFixed(2)}°`);
  const soft = throwRig({ sideSpin: 12, speed: 0.7 });
  const firm = throwRig({ sideSpin: 12 * (3.5 / 0.7), speed: 3.5 });
  assert.ok(soft.throwDegrees < firm.throwDegrees - 0.35,
    `soft shots should throw more: soft ${soft.throwDegrees.toFixed(2)}° vs firm ${firm.throwDegrees.toFixed(2)}°`);
  for (const rig of [left, right, soft, firm]) {
    assert.ok(rig.energyAfter <= rig.energyBefore + 1e-9, 'ball-ball impact created energy');
  }
}

// On the same half-ball cut, a stun (sliding) cue ball throws the object ball
// further off the impact line than a rolling one: vertical rubbing from roll
// tilts the slip direction and eats part of the friction budget.
{
  const R = new PhysicsWorld('chineseEight', { silent: true }).params.radius;
  const stun = throwRig({ objectZ: R, roll: 0 });
  const rolling = throwRig({ objectZ: R, roll: 1 });
  assert.ok(Math.abs(stun.throwDegrees) > Math.abs(rolling.throwDegrees) + 0.2,
    `stun throw ${stun.throwDegrees.toFixed(2)}° should exceed rolling throw ${rolling.throwDegrees.toFixed(2)}°`);
}

// Spin transfer works like gears: a rolling (follow) cue ball leaves the object
// ball with a small opposite (draw) component, not with follow.
{
  const rig = throwRig({ roll: 1 });
  const cueRollBefore = -1.5 / rig.cue.radius;
  assert.ok(rig.object.omega.z > 0.4, `follow should transfer as draw, got ω_z=${rig.object.omega.z.toFixed(2)}`);
  assert.ok(Math.abs(rig.object.omega.z) < 0.35 * Math.abs(cueRollBefore), 'transferred spin should stay small');
}

console.log('CueLab physics smoke tests passed.');
