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

console.log(`CueLab pocket regressions passed (${entries} entries, shelf, flight, return, energy, slow motion, geometry).`);
