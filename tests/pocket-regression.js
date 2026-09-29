'use strict';

const assert = require('node:assert/strict');
global.window = global;
require('../js/math.js');
require('../js/physics.js');
require('../js/renderer.js');
const { PhysicsWorld, pocketCoordinates } = BilliardsPhysics;

function entry(mode, index, speed) {
  const world = new PhysicsWorld(mode, { silent: true });
  const ball = world.getCueBall(), pocket = world.table.pockets[index];
  world.balls = [ball];
  ball.pos = {
    x: pocket.x - pocket.outward.x * (pocket.radiusAlong + 0.006),
    z: pocket.z - pocket.outward.z * (pocket.radiusAlong + 0.006),
  };
  ball.vel = { x: pocket.outward.x * speed, z: pocket.outward.z * speed };
  ball.omega = { x: ball.vel.z / ball.radius, y: 0, z: -ball.vel.x / ball.radius };
  return { world, ball, pocket };
}

// Every mouth must admit centred slow rolls and firm strokes continuously.
// Capture is only legal after the centre has descended through the slate.
let entries = 0;
for (const mode of ['chineseEight', 'eight', 'snooker']) {
  for (let index = 0; index < 6; index += 1) {
    for (const speed of [0.08, 0.3, 1, 4]) {
      const { world, ball, pocket } = entry(mode, index, speed);
      let sawFall = false, pots = 0;
      world.onEvent((event) => { if (event.type === 'pocket') pots += 1; });
      for (let i = 0; i < 1600 && !ball.pocketed; i += 1) {
        const previous = { ...ball.pos };
        world.step(0.001);
        sawFall ||= ball.pocketFall === pocket.id;
        const displacement = Math.hypot(ball.pos.x - previous.x, ball.pos.z - previous.z);
        assert.ok(displacement < Math.max(0.001, speed * 0.0012), `${mode}/${pocket.id}: discontinuous entry`);
      }
      assert.ok(sawFall, `${mode}/${pocket.id}: skipped the supported-to-falling transition`);
      assert.equal(ball.pocketId, pocket.id, `${mode}/${pocket.id}/${speed}: failed to pot`);
      assert.ok(ball.posY <= -ball.radius, 'counted a ball above the slate as pocketed');
      assert.equal(pots, 1, 'pocket event must be emitted once');
      assert.ok(world.isMoving(), 'settled before the fall animation finished');
      for (let i = 0; i < 500; i += 1) world.step(0.001);
      assert.equal(pots, 1);
      assert.equal(ball.sinkDepth, 0.22);
      assert.equal(world.isMoving(), false);
      entries += 1;
    }
  }
}

// The shelf is solid, even very near the mouth. Being above the opening
// while airborne is also insufficient for a pot.
{
  const { world, ball, pocket } = entry('eight', 4, 0);
  world.checkPocket(ball);
  assert.equal(ball.pocketFall, null);
  assert.equal(ball.pocketed, false);
  for (let i = 0; i < 100; i += 1) world.step(0.001);
  assert.equal(ball.posY, 0);
  ball.pos = { x: pocket.x, z: pocket.z };
  ball.posY = 0.12; ball.velY = 0.8;
  for (let i = 0; i < 40; i += 1) world.step(0.001);
  assert.equal(ball.pocketed, false, 'airborne ball was swallowed');
  assert.ok(ball.posY > 0.12);
}

// A ball just inside the front lip can come back onto the shelf. There is
// no attraction toward a pocket target and no scoring for a shallow rattle.
{
  const { world, ball, pocket } = entry('chineseEight', 4, 0);
  ball.pos = { x: 0, z: pocket.z - pocket.radiusAlong + 0.002 };
  ball.vel.z = -0.45; ball.omega.x = ball.vel.z / ball.radius;
  world.checkPocket(ball);
  assert.equal(ball.pocketFall, pocket.id);
  for (let i = 0; i < 100; i += 1) world.step(0.001);
  assert.equal(ball.pocketed, false);
  assert.equal(ball.pocketFall, null);
  assert.equal(ball.posY, 0);
  assert.ok(ball.pos.z < pocket.z - pocket.radiusAlong);
}

// An unforced fall has analytic gravitational motion and preserves spin.
// Committing a pot may not reset height, velocities, orientation or radius.
{
  const { world, ball, pocket } = entry('chineseEight', 4, 0);
  ball.pos = { x: pocket.x, z: pocket.z }; ball.omega.y = 12;
  world.checkPocket(ball);
  for (let i = 0; i < 20; i += 1) world.step(0.001);
  assert.ok(Math.abs(ball.posY + 0.5 * 9.81 * 0.02 ** 2) < 1e-9);
  assert.ok(Math.abs(ball.velY + 9.81 * 0.02) < 1e-9);
  assert.equal(ball.omega.y, 12);
  const before = { position: { ...ball.pos }, y: ball.posY, vy: ball.velY, velocity: { ...ball.vel }, omega: { ...ball.omega }, radius: ball.radius };
  world.captureBall(ball, pocket);
  assert.deepEqual(ball.pos, before.position);
  assert.deepEqual(ball.vel, before.velocity);
  assert.deepEqual(ball.omega, before.omega);
  assert.equal(ball.posY, before.y); assert.equal(ball.velY, before.vy); assert.equal(ball.radius, before.radius);
}

// A clone/undo during a fall must retain the unsupported state, and the
// slow-motion grid must converge on the normal-playback trajectory.
{
  const { world } = entry('chineseEight', 4, 1);
  for (let i = 0; i < 15; i += 1) world.step(0.001);
  const copy = world.clone(), snapshot = world.snapshot();
  world.step(0.001); copy.step(0.001);
  assert.deepEqual(world.balls, copy.balls);
  world.restore(snapshot);
  assert.deepEqual(world.balls, snapshot.balls);
  const run = (dt) => {
    const { world: simulation, ball } = entry('chineseEight', 4, 1);
    let energy = simulation.totalEnergy();
    for (let i = 0; i < Math.round(0.07 / dt); i += 1) {
      simulation.step(dt);
      const next = simulation.totalEnergy();
      assert.ok(next <= energy + 1e-7, 'pocket contact added mechanical energy');
      energy = next;
    }
    return ball;
  };
  const normal = run(0.001), slow = run(0.00001);
  assert.ok(Math.hypot(normal.pos.x - slow.pos.x, normal.pos.z - slow.pos.z) < 0.0005);
  assert.ok(Math.abs(normal.posY - slow.posY) < 0.0005);
  assert.ok(Math.abs(normal.velY - slow.velY) < 0.02);
}

// Tiny sliding velocities must transfer momentum before pure rolling.
// The previous 12 mm/s slip threshold discarded this contact impulse.
{
  const world = new PhysicsWorld('practice', { silent: true }), ball = world.getCueBall();
  world.params.muRoll = 0;
  ball.vel.x = 0.01;
  world.evolveBall(ball, 0.002);
  assert.ok(Math.abs(ball.vel.x - 0.01 * 5 / 7) < 1e-10);
  assert.ok(Math.abs(ball.vel.x + ball.omega.z * ball.radius) < 1e-10);
}

// The ellipse used by the shader and physics has the same shelf front, and
// all new visible mesh triangles agree with their declared face normals.
{
  const world = new PhysicsWorld('eight', { silent: true });
  for (const pocket of world.table.pockets) {
    const front = { x: pocket.throat.x + pocket.outward.x * pocket.shelfDepth, z: pocket.throat.z + pocket.outward.z * pocket.shelfDepth };
    assert.ok(Math.abs(pocketCoordinates(pocket, front).norm - 1) < 1e-12);
  }
  const { prismGeometry, pocketLinerGeometry, jawGeometry } = BilliardsRenderer.geometry;
  const meshes = [prismGeometry([[0.009, 0], [0.060, 0], [0.060, 0.042], [0.006, 0.042], [0, 0.037]]), pocketLinerGeometry(), jawGeometry(0.028, 0.042, 0.037)];
  for (const mesh of meshes) {
    for (let i = 0; i < mesh.indices.length; i += 3) {
      const [a, b, c] = mesh.indices.slice(i, i + 3).map((n) => n * 3), p = mesh.positions;
      const u = [0, 1, 2].map((d) => p[b + d] - p[a + d]), v = [0, 1, 2].map((d) => p[c + d] - p[a + d]);
      const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      assert.ok(cross.reduce((sum, n, d) => sum + n * mesh.normals[a + d], 0) >= -1e-12, 'inverted pocket/cushion mesh');
    }
  }
}

// A cushion episode must never begin and end without the rubber acting.
// The old linear rewind (depth / normal speed) overshot on round jaws: a
// fast ball sliding along an arc was rewound clear of the rubber, released
// with no force, and tunnelled through the jaw — so hard shots found the
// pockets bigger than soft ones, and 1× disagreed with slow motion.
let jawEntries = 0;
{
  let seed = 42;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  let episodes = 0, empty = 0;
  const watch = (world) => {
    const finish = world.finishRailContact.bind(world);
    world.finishRailContact = (target) => {
      episodes += 1;
      if (target.railContact && target.railContact.contactTime === 0) empty += 1;
      return finish(target);
    };
  };
  for (let n = 0; n < 120; n += 1) {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const ball = world.getCueBall(); world.balls = [ball];
    ball.pos = { x: (random() - 0.5) * 2.44, z: (random() - 0.5) * 1.16 };
    const angle = random() * Math.PI * 2;
    world.strike({ direction: { x: Math.cos(angle), z: Math.sin(angle) }, speed: 1 + random() * 5, tipX: 0, tipY: 0, elevation: 0 });
    watch(world);
    for (let i = 0; i < 15000 && world.isMoving(); i += 1) world.step(1 / 1000);
  }
  assert.ok(episodes > 300, 'random shots barely reached a cushion');

  const attempt = (pocketId, approach, offset, speed, dt) => {
    const world = new PhysicsWorld('chineseEight', { silent: true });
    const ball = world.getBall('1'); world.balls = [ball];
    const pocket = world.table.pockets.find((p) => p.id === pocketId);
    const a = approach * Math.PI / 180, out = pocket.outward;
    const dir = { x: out.x * Math.cos(a) - out.z * Math.sin(a), z: out.x * Math.sin(a) + out.z * Math.cos(a) };
    ball.pos = { x: pocket.throat.x - dir.z * offset - dir.x * 0.3, z: pocket.throat.z + dir.x * offset - dir.z * 0.3 };
    ball.vel = { x: dir.x * speed, z: dir.z * speed };
    ball.omega = { x: dir.z * speed / ball.radius, y: 0, z: -dir.x * speed / ball.radius };
    world.inShot = true;
    watch(world);
    // Judge only this entry into this pocket, not a pot elsewhere after a
    // chaotic tour of the rails.
    for (let t = 0; t < 0.3 / speed + 0.5 && world.isMoving(); t += dt) world.step(dt);
    return ball.pocketed && ball.pocketId === pocketId;
  };
  const width = (pocketId, approach, speed, dt) => {
    let potted = 0;
    for (let k = -40; k <= 40; k += 2) if (attempt(pocketId, approach, k / 1000, speed, dt)) potted += 2;
    jawEntries += 41;
    return potted;
  };
  for (const [pocketId, approach] of [['tm', 55], ['tm', 45], ['tr', 20]]) {
    const hard = width(pocketId, approach, 5, 1 / 1000);
    const slowMotion = width(pocketId, approach, 5, 1 / 20000);
    const soft = width(pocketId, approach, 0.8, 1 / 1000);
    assert.ok(Math.abs(hard - slowMotion) <= 4, `${pocketId} ${approach}°: 1× pocket ${hard} mm vs slow motion ${slowMotion} mm`);
    assert.ok(hard <= soft + 12, `${pocketId} ${approach}°: a hard ball finds a ${hard} mm pocket, a soft one ${soft} mm`);
  }
  assert.equal(empty, 0, `${empty} of ${episodes} cushion episodes ended before any force acted`);
}

console.log(`CueLab pocket regressions passed (${entries} entries, ${jawEntries} jaw entries, shelf, flight, return, energy, slow motion, geometry).`);
