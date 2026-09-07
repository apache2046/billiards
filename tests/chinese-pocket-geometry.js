'use strict';

const assert = require('node:assert/strict');
global.window = global;
require('../js/math.js');
require('../js/physics.js');
require('../js/renderer.js');

const { PhysicsWorld, roundedCushionContour, cushionEndExtension } = BilliardsPhysics;
const { chineseCushionGeometry, chinesePocketGeometry } = BilliardsRenderer.geometry;
const world = new PhysicsWorld('chineseEight', { silent: true });
const table = world.table, ball = world.getCueBall();
world.balls = [ball];
const near = (actual, expected, label, tolerance = 1e-9) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} != ${expected}`);

// Every rendered nose point is an actual contact point with the same normal.
// Include the diagonal/straight returns, not just the original rail tangents.
let contactsChecked = 0;
for (const segment of table.cushions) {
  const contour = roundedCushionContour(table, segment);
  const mesh = chineseCushionGeometry(table, segment);
  for (const p of contour) {
    near(Math.hypot(p.nx, p.nz), 1, 'unit contour normal');
    ball.pos = { x: p.x + p.nx * (ball.radius - 0.00001), z: p.z + p.nz * (ball.radius - 0.00001) };
    const contacts = world.scanCushionContacts(ball);
    assert.ok(contacts.some((c) => c.nx * p.nx + c.nz * p.nz > 0.999999 && Math.abs(c.depth - 0.00001) < 1e-8), `${segment.id}: visible contour has no matching contact`);
    assert.ok(mesh.positions.some((_, i) => i % 3 === 0 && Math.hypot(mesh.positions[i] - p.x, mesh.positions[i + 1] - table.cushionContactHeight, mesh.positions[i + 2] - p.z) < 1e-10), 'nose mesh does not use the physical outline');
    contactsChecked += 1;
  }
  // The cushion is one connected cloth body, not a prism plus round discs.
  // Arc joins share vertices geometrically, with no internal end-cap faces.
  for (const end of [segment.min, segment.max]) {
    const capTriangles = mesh.indices.reduce((sum, _, i) => {
      if (i % 3) return sum;
      const points = mesh.indices.slice(i, i + 3).map((n) => mesh.positions[n * 3 + (segment.axis === 'x' ? 0 : 2)]);
      return sum + Number(points.every((value) => Math.abs(value - end) < 1e-10));
    }, 0);
    assert.equal(capTriangles, 0, `${segment.id}: internal cap at the straight/arc join`);
  }
  const topVertices = mesh.positions.filter((_, i) => i % 3 === 1);
  near(Math.max(...topVertices), table.cushionTopHeight + 0.014, 'cloth rises continuously to the backing');
}

assert.equal(table.jawReturns.length, 12);
for (const jaw of table.jaws) {
  const wall = table.jawReturns.find((item) => item.id === `return-${jaw.id}`);
  const a = jaw.radiusAlong, b = jaw.radius;
  const length = Math.hypot(b * Math.sin(jaw.sweep), a * Math.cos(jaw.sweep));
  const radial = {
    x: (jaw.mouthDirection.x * b * Math.sin(jaw.sweep) + jaw.normal.x * a * Math.cos(jaw.sweep)) / length,
    z: (jaw.mouthDirection.z * b * Math.sin(jaw.sweep) + jaw.normal.z * a * Math.cos(jaw.sweep)) / length,
  };
  near(radial.x, wall.normal.x, 'arc/return normal x');
  near(radial.z, wall.normal.z, 'arc/return normal z');
  near((wall.p1.x - wall.p0.x) * wall.normal.x + (wall.p1.z - wall.p0.z) * wall.normal.z, 0, 'return is tangent');
  // Either side of the arc/return join must belong to the correct surface.
  for (const side of [-1, 1]) {
    const angle = jaw.sweep + side * 0.008;
    const s = Math.sin(angle), c = Math.cos(angle), length = Math.hypot(b * s, a * c);
    const normal = { x: (jaw.mouthDirection.x * b * s + jaw.normal.x * a * c) / length, z: (jaw.mouthDirection.z * b * s + jaw.normal.z * a * c) / length };
    ball.pos = {
      x: jaw.x + jaw.mouthDirection.x * a * s + jaw.normal.x * b * c + normal.x * (ball.radius - 0.0001),
      z: jaw.z + jaw.mouthDirection.z * a * s + jaw.normal.z * b * c + normal.z * (ball.radius - 0.0001),
    };
    const contacts = world.scanCushionContacts(ball);
    const expected = side < 0 ? jaw.id : wall.id;
    assert.ok(contacts.some((c) => c.id === expected), `${jaw.id}: missed ${expected}`);
    assert.ok(!contacts.some((c) => c.id === (side < 0 ? wall.id : jaw.id)), 'hidden round cap still collides behind the join');
  }
}

// The reference distinguishes corners (oblique returns) from middle U mouths.
assert.ok(table.cornerReturnAngle > Math.PI / 4 && table.cornerReturnAngle < Math.PI / 3);
near(table.sideReturnAngle, Math.PI / 2, 'middle quarter arc');
near(Math.SQRT2 * (table.cornerGap + table.jawRadius) - 2 * table.jawRadius, 0.085, 'corner throat width preserved');
near(2 * (table.sideGap - table.sideJawRadius), 0.100, 'middle throat width preserved');
assert.ok(table.sideJawRadius > table.jawRadius * 1.7, 'middle shoulder is still a short circular corner');
// An ellipse's closest-point normal is not a radial vector. Check the ball
// offset on both sides of the true contact boundary, including tight turns.
for (const jaw of table.jaws.filter((item) => item.radiusAlong !== item.radius)) {
  for (let i = 1; i < 90; i += 1) {
    const angle = i / 90 * Math.PI / 2, s = Math.sin(angle), c = Math.cos(angle);
    const length = Math.hypot(jaw.radius * s, jaw.radiusAlong * c);
    const na = jaw.radius * s / length, nf = jaw.radiusAlong * c / length;
    const nx = jaw.mouthDirection.x * na + jaw.normal.x * nf;
    const nz = jaw.mouthDirection.z * na + jaw.normal.z * nf;
    for (const penetration of [-0.0005, 0.0001, 0.002]) {
      ball.pos = {
        x: jaw.x + jaw.mouthDirection.x * jaw.radiusAlong * s + jaw.normal.x * jaw.radius * c + nx * (ball.radius - penetration),
        z: jaw.z + jaw.mouthDirection.z * jaw.radiusAlong * s + jaw.normal.z * jaw.radius * c + nz * (ball.radius - penetration),
      };
      const contact = world.scanCushionContacts(ball).find((item) => item.id === jaw.id);
      if (penetration < 0) assert.equal(contact, undefined, 'middle ellipse has an invisible protrusion');
      else {
        assert.ok(contact, 'middle ellipse missed contact');
        near(contact.depth, penetration, 'ellipse offset depth');
        near(contact.nx, nx, 'ellipse offset normal x');
        near(contact.nz, nz, 'ellipse offset normal z');
      }
    }
  }
}
for (const pocket of table.pockets) {
  ball.pos = { ...pocket.throat };
  assert.equal(world.scanCushionContacts(ball).length, 0, 'phantom return wall blocks a centred mouth');
}

// Both soft and firm impacts on all twelve new return walls must finish a
// real compliant-contact episode and leave less energy than they arrived
// with. Instantaneous kinetic energy alone can rise during spring release.
for (const wall of table.jawReturns) {
  for (const speed of [0.35, 1.8]) {
    const simulation = new PhysicsWorld('chineseEight', { silent: true });
    const cue = simulation.getCueBall(), n = wall.normal;
    simulation.balls = [cue];
    cue.pos = {
      x: wall.p0.x + (wall.p1.x - wall.p0.x) * 0.15 + n.x * (cue.radius + 0.001),
      z: wall.p0.z + (wall.p1.z - wall.p0.z) * 0.15 + n.z * (cue.radius + 0.001),
    };
    cue.vel = { x: -n.x * speed, z: -n.z * speed };
    cue.omega = { x: cue.vel.z / cue.radius, y: 0, z: -cue.vel.x / cue.radius };
    const energy = simulation.totalEnergy();
    for (let i = 0; i < 200; i += 1) simulation.step(0.0001);
    assert.equal(simulation.lastCushionEvent?.cushionId, wall.id, 'return collision did not finish');
    assert.equal(cue.railContact, null);
    assert.ok(simulation.totalEnergy() < energy, 'return added net energy');
    assert.ok([cue.pos.x, cue.pos.z, cue.posY, cue.vel.x, cue.vel.z].every(Number.isFinite));
  }
}

function checkMesh(mesh, name) {
  assert.ok(mesh.positions.every(Number.isFinite) && mesh.normals.every(Number.isFinite), `${name}: non-finite vertex`);
  assert.equal(mesh.normals.length, mesh.positions.length);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const indices = mesh.indices.slice(i, i + 3).map((n) => n * 3), [a, b, c] = indices, p = mesh.positions;
    const u = [0, 1, 2].map((d) => p[b + d] - p[a + d]), v = [0, 1, 2].map((d) => p[c + d] - p[a + d]);
    const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    assert.ok(Math.hypot(...cross) > 1e-14, `${name}: degenerate triangle`);
    for (const index of indices) {
      assert.ok(cross.reduce((sum, n, d) => sum + n * mesh.normals[index + d], 0) >= -1e-12, `${name}: inverted triangle`);
      near(Math.hypot(...mesh.normals.slice(index, index + 3)), 1, `${name}: non-unit normal`);
    }
  }
}
for (const segment of table.cushions) checkMesh(chineseCushionGeometry(table, segment), segment.id);
for (const pocket of table.pockets) {
  const geometry = chinesePocketGeometry(table, pocket);
  for (const [name, mesh] of Object.entries(geometry)) checkMesh(mesh, `${pocket.id}/${name}`);
  // Both inner bracket ends meet the cloth/wood seam, not the middle of an
  // uninterrupted rail cap. The rear top edge stays clear of the slate hole.
  const vertices = geometry.plate.positions;
  const joint = -table.cornerGap + cushionEndExtension(table, false, 0.056, 0.0035);
  const endpoints = pocket.type === 'corner'
    ? [[Math.sign(pocket.outward.x) * (table.width / 2 + joint), Math.sign(pocket.outward.z) * (table.height / 2 + 0.056)], [Math.sign(pocket.outward.x) * (table.width / 2 + 0.056), Math.sign(pocket.outward.z) * (table.height / 2 + joint)]]
    : [[-(table.sideMouth / 2 + 0.0035), Math.sign(pocket.outward.z) * (table.height / 2 + 0.056)], [table.sideMouth / 2 + 0.0035, Math.sign(pocket.outward.z) * (table.height / 2 + 0.056)]];
  for (const [x, z] of endpoints) assert.ok(vertices.some((_, i) => i % 3 === 0 && Math.hypot(vertices[i] - x, vertices[i + 2] - z) < 1e-10), 'bracket does not meet its cloth return');
}

// Predictor/undo copies must not share mutable return geometry.
const copy = world.clone();
copy.table.jawReturns[0].p0.x += 1;
copy.table.jaws[0].mouthDirection.x += 1;
assert.notEqual(copy.table.jawReturns[0].p0.x, table.jawReturns[0].p0.x);
assert.notEqual(copy.table.jaws[0].mouthDirection.x, table.jaws[0].mouthDirection.x);
for (const mode of ['eight', 'snooker']) {
  const other = new PhysicsWorld(mode, { silent: true });
  assert.equal(other.table.jawReturns.length, 0, 'Chinese geometry leaked into another table');
}

console.log(`CueLab Chinese pocket geometry passed (${contactsChecked} visual/contact samples, 12 tangent returns, 24 rebounds, 6 brackets, meshes, clone isolation).`);
