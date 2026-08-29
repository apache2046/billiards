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

  // Flat XZ meshes (pocket holes/plates, cloth markings, the snooker D) are
  // single-sided: every triangle must wind CCW seen from +Y or back-face
  // culling would blank it.
  const { circleGeometry, sectorGeometry } = global.BilliardsRenderer.geometry;
  const checkFlat = (name, geometry) => {
    const p = geometry.positions, idx = geometry.indices;
    for (let i = 0; i < idx.length; i += 3) {
      const [ia, ib, ic] = [idx[i] * 3, idx[i + 1] * 3, idx[i + 2] * 3];
      const e1x = p[ib] - p[ia], e1z = p[ib + 2] - p[ia + 2];
      const e2x = p[ic] - p[ia], e2z = p[ic + 2] - p[ia + 2];
      const ny = e1z * e2x - e1x * e2z;
      assert.ok(ny > 1e-12, `${name}: triangle ${i / 3} winds away from +Y (would be culled)`);
    }
  };
  checkFlat('circle', circleGeometry(20));
  checkFlat('sector', sectorGeometry(20, Math.PI * 1.48));
  checkFlat('annulus sector', sectorGeometry(20, Math.PI * 1.06, 0.74));
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

// Default Chinese-eight setup follows the 9-foot Q8-style playing area with
// rounded jaws: 85 mm corner mouths at the narrowest arc-to-arc point, and a
// middle mouth 15 mm wider per the CBSA equipment rule.  The 8 is centred and
// the rear corners are opposite groups.
{
  const world = new PhysicsWorld(undefined, { silent: true });
  assert.equal(world.mode, 'chineseEight');
  assert.equal(world.table.name, '乔氏金腿式赛事台');
  assert.equal(world.table.width, 2.54);
  assert.equal(world.table.height, 1.26);
  assert.ok(Math.abs(world.table.sideMouth - world.table.cornerMouth - 0.015) < 1e-9,
    'CBSA rule: the middle mouth is 15 mm wider than the corner mouth');
  assert.ok(Math.abs(Math.sqrt(2) * (world.table.cornerGap + world.table.jawRadius) - 2 * world.table.jawRadius - 0.085) < 1e-9);
  assert.ok(Math.abs(2 * world.table.sideGap - 2 * world.table.jawRadius - 0.100) < 1e-9);
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
  // Select the rear corners by rack position, not ball number, so a scrambled
  // rack order cannot slip past this assertion.
  const spacing = 2 * world.params.radius + 0.00075;
  const rearX = world.table.rackApex + 4 * Math.sqrt(3) * (spacing / 2);
  const rear = [-2, 2].map((k) => world.balls.find(
    (ball) => Math.abs(ball.pos.x - rearX) < 1e-9 && Math.abs(ball.pos.z - k * spacing) < 1e-9,
  ));
  assert.ok(rear[0] && rear[1], 'rear corner balls missing from the rack coordinates');
  assert.deepEqual(new Set(rear.map((ball) => ball.kind)), new Set(['solid', 'stripe']),
    'rear corners must hold one solid and one stripe');
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

// The rail is a Hunt-Crossley spring-damper, not a rigid wall: restitution
// falls with impact speed by itself, compression depth and contact time are
// physical quantities, and a firm square hit pops the ball briefly off the
// slate through the tilted nose.
{
  const square = (speed) => {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    cue.pos = { x: world.table.width / 2 - cue.radius - 0.02, z: 0 };
    cue.vel = { x: speed, z: 0 };
    let event = null;
    world.onEvent((item) => { if (!event && item.type === 'cushion') event = item; });
    for (let i = 0; i < 40 && !event; i += 1) world.step(1 / 600);
    return { event, cue };
  };
  const slow = square(1), medium = square(2.5), fast = square(5);
  assert.ok(slow.event.restitution > medium.event.restitution + 0.03, 'restitution must fall with impact speed');
  assert.ok(medium.event.restitution > fast.event.restitution + 0.03, 'restitution must keep falling with impact speed');
  assert.ok(medium.event.restitution > 0.78 && medium.event.restitution < 0.87,
    `2.5 m/s stun restitution ${medium.event.restitution.toFixed(3)} drifted from the table calibration`);
  assert.ok(fast.event.compression > medium.event.compression && medium.event.compression > slow.event.compression,
    'rubber compression must grow with impact speed');
  assert.ok(fast.event.compression > 0.0012 && fast.event.compression < 0.006,
    `5 m/s compression ${(fast.event.compression * 1000).toFixed(2)} mm out of range`);
  for (const rig of [slow, medium, fast]) {
    assert.ok(rig.event.contactTime > 0.0006 && rig.event.contactTime < 0.0040,
      `contact time ${(rig.event.contactTime * 1000).toFixed(2)} ms outside the measured band`);
  }
  assert.ok(fast.cue.velY > 0.2, 'a firm square rail hit should hop the ball off the slate');
  assert.ok(Math.abs(slow.cue.velY) < 1e-9, 'soft rail contact must not hop');
}

// The rubber contact lives across steps, so its outcome must not depend on
// the caller's step size: the same spinning impact integrated at 600 Hz and
// on the deepest slow-motion grid (100 kHz, 10 µs) has to leave the rail with
// the same velocity, spin and telemetry.  On the fine grid the episode must
// also visibly persist across many steps — that persistence is what lets the
// compression be watched frame by frame in slow motion.
{
  const run = (dt) => {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    cue.pos = { x: world.table.width / 2 - cue.radius - 0.03, z: 0.1 };
    cue.vel = { x: 2.2, z: 0.9 };
    cue.omega = { x: 31.5, y: 18, z: -77 };
    let event = null, contactSteps = 0;
    world.onEvent((e) => { if (!event && e.type === 'cushion') event = e; });
    for (let i = 0, total = Math.round(0.12 / dt); i < total; i += 1) {
      world.step(dt);
      if (cue.railContact) contactSteps += 1;
    }
    return { cue, event, contactSteps };
  };
  const coarse = run(1 / 600);
  const fine = run(1 / 100000);
  assert.ok(coarse.event && fine.event, 'dt-invariance rig missed the cushion');
  assert.ok(Math.hypot(coarse.cue.vel.x - fine.cue.vel.x, coarse.cue.vel.z - fine.cue.vel.z) < 0.01,
    'cushion outcome drifted with step size');
  assert.ok(Math.abs(coarse.event.restitution - fine.event.restitution) < 0.01,
    'measured restitution drifted with step size');
  assert.ok(Math.abs(coarse.event.compression - fine.event.compression) < 5e-5,
    'compression depth drifted with step size');
  assert.ok(Math.abs(coarse.event.contactTime - fine.event.contactTime) < 1.5e-4,
    'contact time drifted with step size');
  assert.ok(fine.contactSteps > 50,
    `fine-grid contact only persisted ${fine.contactSteps} steps; the episode must span steps, not resolve atomically`);
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

// The widened 100 mm middle mouth must swallow straight entries across its
// whole jaw-to-jaw corridor, while a ball rolling along the cushion line past
// the open mouth must sail through untouched (the jaws are exactly tangent).
{
  const geometry = new PhysicsWorld('chineseEight', { silent: true });
  const R = geometry.params.radius;
  const corridor = geometry.table.sideGap - geometry.table.jawRadius - R;
  for (const offset of [-corridor * 0.92, 0, corridor * 0.92]) {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    cue.pos = { x: offset, z: world.table.height / 2 - R - 0.03 };
    cue.vel = { x: 0, z: 1.1 };
    for (let i = 0; i < 400 && !cue.pocketed; i += 1) world.step(1 / 600);
    assert.equal(cue.pocketed, true, `middle-mouth entry at ${(offset * 1000).toFixed(1)} mm was not captured`);
    assert.equal(cue.pocketId, 'tm', `middle-mouth entry at ${(offset * 1000).toFixed(1)} mm fell into the wrong pocket`);
  }
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall(); world.balls = [cue];
  cue.pos = { x: -0.30, z: world.table.height / 2 - R };
  cue.vel = { x: 1.6, z: 0 };
  cue.omega = { x: cue.vel.z / R, y: 0, z: -cue.vel.x / R };
  for (let i = 0; i < 400; i += 1) world.step(1 / 600);
  assert.equal(cue.pocketed, false, 'a rail-line roller crossing the middle mouth must not be captured');
  assert.ok(cue.pos.x > 0.3, 'the rail-line roller should continue past the mouth');
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
    world, cue, object, speed,
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
  const cueRollBefore = -rig.speed / rig.cue.radius;
  assert.ok(rig.object.omega.z > 0.4, `follow should transfer as draw, got ω_z=${rig.object.omega.z.toFixed(2)}`);
  assert.ok(Math.abs(rig.object.omega.z) < 0.35 * Math.abs(cueRollBefore), 'transferred spin should stay small');
}

// Cut-induced throw across cut angles must reproduce the measured hump: it
// peaks near a half-ball hit and falls for thin cuts (larger slip → smaller
// Alciatore μ).  With spin, throw follows the contact-slip picture: gearing
// outside english zeroes it, partial outside (slower slip) increases it, and
// extra inside english (faster slip) lowers the throw angle again.
{
  const R = new PhysicsWorld('chineseEight', { silent: true }).params.radius;
  const atCut = (cut, extra = {}) => throwRig({ objectZ: 2 * R * Math.sin(cut * Math.PI / 180), ...extra });
  const t10 = atCut(10), t30 = atCut(30), t70 = atCut(70);
  assert.ok(Math.abs(t30.throwDegrees) > Math.abs(t10.throwDegrees) + 0.3,
    `CIT should rise toward the half-ball hit: 10° → ${t10.throwDegrees.toFixed(2)}°, 30° → ${t30.throwDegrees.toFixed(2)}°`);
  assert.ok(Math.abs(t30.throwDegrees) > Math.abs(t70.throwDegrees) + 0.5,
    `CIT should fall again for thin cuts: 30° → ${t30.throwDegrees.toFixed(2)}°, 70° → ${t70.throwDegrees.toFixed(2)}°`);
  assert.ok(Math.abs(t30.throwDegrees) > 2 && Math.abs(t30.throwDegrees) < 6,
    `peak stun CIT out of measured range: ${t30.throwDegrees.toFixed(2)}°`);

  const gearing = -1.5 * Math.sin(30 * Math.PI / 180) / R;
  const geared = atCut(30, { sideSpin: gearing });
  assert.ok(Math.abs(geared.throwDegrees) < 0.4,
    `gearing outside english should cancel throw, got ${geared.throwDegrees.toFixed(2)}°`);
  // Sweep from stun to gearing: near gearing the contact sticks and throw is
  // limited by the linear stick impulse, past the crossover it follows the
  // sliding μ(v) curve — so the throw MAXIMUM sits at partial outside
  // english, strictly between stun and gearing (Alciatore's measured shape).
  const sweep = [0, 0.15, 0.3, 0.45, 0.6, 0.8, 1].map((f) => ({
    f, degrees: atCut(30, { sideSpin: gearing * f }).throwDegrees,
  }));
  const peak = sweep.reduce((best, s) => (Math.abs(s.degrees) > Math.abs(best.degrees) ? s : best));
  assert.ok(peak.f > 0 && peak.f < 1,
    `peak throw must occur at partial outside english, got peak at f=${peak.f}`);
  assert.ok(Math.abs(peak.degrees) > Math.abs(t30.throwDegrees) + 0.15,
    `stick/slide crossover peak (${peak.degrees.toFixed(2)}°) should exceed the stun throw (${t30.throwDegrees.toFixed(2)}°)`);
  const insideExtra = atCut(30, { sideSpin: -gearing });
  assert.ok(Math.abs(insideExtra.throwDegrees) < Math.abs(t30.throwDegrees),
    `inside english speeds up slip and must lower the throw angle: ${insideExtra.throwDegrees.toFixed(2)}°`);
  const beyond = atCut(30, { sideSpin: gearing * 2 });
  assert.ok(beyond.throwDegrees * t30.throwDegrees < 0,
    'outside english beyond gearing must reverse the throw direction');

  // Thin cut at pace: with the pair rewound to its true time of impact the
  // departure deviates from the first-touch impact line by throw alone.
  const fast = atCut(70, { speed: 5 });
  assert.ok(Math.abs(fast.throwDegrees) < 1.5,
    `fast thin cut should carry only residual throw, got ${fast.throwDegrees.toFixed(2)}°`);
}

// Pocket geometry must match the published equipment specs for every game:
// WPA pool mouths are measured tip-to-tip with 142°/104° facings, snooker
// uses rounded jaws with template-level corner/middle falls.
{
  const pool = new PhysicsWorld('eight', { silent: true });
  assert.ok(Math.abs(pool.table.cornerGap * Math.sqrt(2) - 0.1143) < 1e-9, 'pool corner mouth is not 4.5 in');
  assert.ok(Math.abs(2 * pool.table.sideGap - 0.127) < 1e-9, 'pool side mouth is not 5.0 in');
  assert.equal(pool.table.jaws.length, 0, 'pool should use flat facings, not round jaws');
  assert.equal(pool.table.facings.length, 12, 'pool needs two facings per pocket');
  for (const facing of pool.table.facings) {
    const segment = pool.table.cushions.find((s) => facing.id.includes(s.id));
    const along = segment.axis === 'x' ? { x: 1, z: 0 } : { x: 0, z: 1 };
    const dx = facing.p1.x - facing.p0.x, dz = facing.p1.z - facing.p0.z;
    const length = Math.hypot(dx, dz);
    const cosToRail = Math.abs((dx * along.x + dz * along.z) / length);
    const expected = Math.abs(Math.cos(Math.PI - (facing.pocketType === 'side' ? 104 : 142) * Math.PI / 180));
    assert.ok(Math.abs(cosToRail - expected) < 1e-9, `${facing.id}: facing angle drifted from spec`);
    assert.ok(Math.abs(Math.hypot(facing.normal.x, facing.normal.z) - 1) < 1e-9, `${facing.id}: non-unit normal`);
  }
  const snooker = new PhysicsWorld('snooker', { silent: true });
  const q = snooker.table.jawRadius;
  assert.ok(Math.abs(Math.sqrt(2) * (snooker.table.cornerGap + q) - 2 * q - 0.086) < 1e-9, 'snooker corner fall drifted');
  assert.ok(Math.abs(2 * snooker.table.sideGap - 2 * q - 0.103) < 1e-9, 'snooker middle fall drifted');
}

// A ball frozen against a pool pocket facing must stay put, and a ball rolled
// square into the facing must rebound along the facing normal, not the rail's.
{
  const geometry = new PhysicsWorld('eight', { silent: true });
  let facingsTested = 0;
  for (const source of geometry.table.facings) {
    const world = new PhysicsWorld('eight', { silent: true });
    const cue = world.getCueBall(); world.balls = [cue];
    const facing = world.table.facings.find((f) => f.id === source.id);
    const mid = { x: (facing.p0.x + facing.p1.x) / 2, z: (facing.p0.z + facing.p1.z) / 2 };
    cue.pos = { x: mid.x + facing.normal.x * (cue.radius - 1e-7), z: mid.z + facing.normal.z * (cue.radius - 1e-7) };
    cue.vel = { x: 0, z: 0 }; cue.omega = { x: 0, y: 0, z: 0 };
    for (let i = 0; i < 240; i += 1) world.step(1 / 600);
    if (cue.pocketed) continue; // deep-jaw spots may legitimately fall in
    facingsTested += 1;
    const dx = cue.pos.x - mid.x, dz = cue.pos.z - mid.z;
    assert.ok(dx * facing.normal.x + dz * facing.normal.z >= cue.radius - 5e-5, `${facing.id}: ball sank into facing`);
    assert.equal(cue.state, 'stationary', `${facing.id}: frozen ball did not settle`);
  }
  // 8 of the 12 facings currently stay out of the fall; if pocket capture ever
  // inflates enough to swallow (nearly) all of them, this block must fail
  // rather than pass vacuously.
  assert.ok(facingsTested >= 6, `only ${facingsTested} facings actually tested`);
  const world = new PhysicsWorld('eight', { silent: true });
  const cue = world.getCueBall(); world.balls = [cue];
  const facing = world.table.facings[0];
  // Aim near the mouth tip (t = 0.3) — the deep end of the facing is already
  // over the pocket fall, where capture is the correct outcome.
  const spot = {
    x: facing.p0.x + (facing.p1.x - facing.p0.x) * 0.3,
    z: facing.p0.z + (facing.p1.z - facing.p0.z) * 0.3,
  };
  cue.pos = { x: spot.x + facing.normal.x * (cue.radius + 0.02), z: spot.z + facing.normal.z * (cue.radius + 0.02) };
  cue.vel = { x: -facing.normal.x * 0.8, z: -facing.normal.z * 0.8 };
  let event = null;
  world.onEvent((item) => { if (!event && item.type === 'cushion') event = item; });
  for (let i = 0; i < 120 && !event; i += 1) world.step(1 / 600);
  assert.ok(event && event.cushionId === facing.id, 'square hit did not use the facing collider');
  const outSpeed = cue.vel.x * facing.normal.x + cue.vel.z * facing.normal.z;
  assert.ok(outSpeed > 0.3, 'facing rebound lost the normal direction');
}

// Beyond the chalk limit the tip skids off: a miscue keeps under half the
// speed, under half the spin, and roughly doubles the squirt angle.
{
  const world = new PhysicsWorld('chineseEight', { silent: true });
  world.setTipType('hard');
  const options = { direction: { x: 1, z: 0 }, speed: 4, tipY: 0, elevation: 0 };
  const clean = world.cueImpactMetrics({ ...options, tipX: 0.6 });
  const bad = world.cueImpactMetrics({ ...options, tipX: 0.895 });
  assert.equal(clean.miscue, false);
  assert.equal(bad.miscue, true);
  assert.ok(bad.horizontalSpeed < clean.horizontalSpeed * 0.45, 'miscue kept too much speed');
  assert.ok(Math.abs(bad.omega.y) < Math.abs(clean.omega.y) * 0.35, 'miscue kept too much spin');
  assert.ok(Math.abs(bad.squirt) > Math.abs(clean.squirt), 'miscue should deflect more, not less');
}

// An elevated firm stroke drives the ball into the slate and it rebounds
// airborne, flies without cloth friction, then lands and settles normally.
{
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall(); world.balls = [cue];
  cue.pos = { x: -0.8, z: 0 };
  world.strike({ direction: { x: 1, z: 0 }, speed: 4.4, tipX: 0, tipY: -0.2, elevation: 30 });
  assert.ok(cue.velY > 0.8, `elevated strike should launch upward, got ${cue.velY.toFixed(2)}`);
  let apex = 0, sawAirborne = false;
  for (let i = 0; i < 6000; i += 1) {
    world.step(1 / 600);
    apex = Math.max(apex, cue.posY);
    if (cue.state === 'airborne') sawAirborne = true;
    if (!world.isMoving()) break;
  }
  assert.ok(sawAirborne, 'jump shot never reported airborne state');
  assert.ok(apex > 0.05, `jump apex only ${apex.toFixed(3)} m`);
  assert.ok(Math.abs(cue.posY) < 1e-9, 'ball failed to return to the cloth');
}

// A proper jump clears an object ball dead in its path and lands beyond it.
{
  const world = new PhysicsWorld('chineseEight', { silent: true });
  const cue = world.getCueBall(); const object = world.getBall('1');
  world.balls = [cue, object];
  cue.pos = { x: -0.5, z: 0 }; object.pos = { x: -0.05, z: 0 };
  object.vel = { x: 0, z: 0 };
  world.strike({ direction: { x: 1, z: 0 }, speed: 5, tipX: 0, tipY: 0.1, elevation: 32 });
  // Watch the fly-over and landing only; the cue ball may legitimately return
  // off the far cushion later.
  for (let i = 0; i < 180; i += 1) world.step(1 / 600);
  assert.ok(Math.hypot(object.vel.x, object.vel.z) < 0.02, 'jumped cue ball should clear the object ball');
  assert.ok(cue.pos.x > object.pos.x + 0.05, 'cue ball should come down beyond the cleared ball');
}

console.log('CueLab physics smoke tests passed.');
