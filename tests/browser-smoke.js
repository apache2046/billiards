'use strict';

// Optional browser suite; the app and npm test still have zero dependencies.
// Run npm run serve first. Use an installed Playwright (or its absolute path).
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.CUELAB_PLAYWRIGHT_PATH || 'playwright');
const url = process.env.CUELAB_TEST_URL || 'http://localhost:8080';

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CUELAB_CHROME_PATH || undefined,
    headless: true, args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'] });
  const screenshots = fs.mkdtempSync(path.join(os.tmpdir(), 'cuelab-browser-'));
  const errors = [];
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 980 } });
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.waitForFunction(() => window.cueLab?.renderer?.lastRenderSignature);
    assert.equal(await page.locator('#webglError').isVisible(), false);
    assert.equal(await page.locator('#undoButton').isDisabled(), true);
    await page.locator('#spinControl').focus();
    await page.keyboard.press('ArrowUp');
    assert.equal(await page.evaluate(() => cueLab.tipY), 0.02);
    await page.keyboard.press('Home');
    assert.equal(await page.evaluate(() => cueLab.tipY), 0);
    await page.locator('#powerSlider').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#powerValue').textContent(), '63%');
    await page.locator('#assistGhost').focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator('#assistGhost').isChecked(), false);
    assert.equal(await page.evaluate(() => cueLab.world.inShot), false, 'native checkbox space fired a shot');
    await page.locator('#labTab').click();
    await page.keyboard.press('ArrowLeft');
    assert.equal(await page.locator('#shotTab').getAttribute('aria-selected'), 'true');
    await page.locator('#labTab').click();
    await page.locator('#tableTheme').selectOption('blue');
    await page.locator('#ballSkin').selectOption('palladium');
    await page.reload();
    await page.waitForFunction(() => cueLab?.renderer?.lastRenderSignature);
    assert.equal(await page.evaluate(() => cueLab.renderer.tableTheme), 'blue');
    assert.equal(await page.evaluate(() => cueLab.ballSkin), 'palladium');
    assert.equal(await page.locator('#assistGhost').isChecked(), false);
    await page.locator('#focusToggle').click();
    assert.equal(await page.locator('#controlPanel').isVisible(), false);
    await page.keyboard.press('f');
    assert.equal(await page.locator('#controlPanel').isVisible(), true);
    await page.locator('#shootButton').click();
    await page.waitForFunction(() => cueLab.world.inShot);
    await page.waitForFunction(() => !document.querySelector('#undoButton').disabled);
    await page.locator('#pauseButton').click();
    await page.waitForFunction(() => document.querySelector('#shootButton strong').textContent === '继续模拟');
    await page.locator('#shootButton').click();
    assert.equal(await page.evaluate(() => cueLab.paused), false);
    await page.locator('#undoButton').click();
    assert.equal(await page.evaluate(() => cueLab.world.inShot || cueLab.world.isMoving()), false);
    await page.locator('#labTab').click();
    await page.locator('#placementToggle').click();
    await page.waitForFunction(() => document.querySelector('#shootButton strong').textContent === '完成摆球');
    await page.locator('#shootButton').click();
    assert.equal(await page.evaluate(() => cueLab.placement), false);
    await page.locator('#tableTheme').selectOption('club');
    await page.locator('#ballSkin').selectOption('tv');
    await page.locator('#slowButton').click();
    assert.equal(await page.evaluate(() => cueLab.slowMotionRate), 0.25);
    for (let i = 0; i < 4; i += 1) await page.locator('#slowButton').click();
    assert.equal(await page.evaluate(() => cueLab.slowMotionRate), 1);

    for (const kind of ['draw', 'follow', 'masse', 'gear', 'english', 'railFrozen']) {
      await page.locator(`[data-drill="${kind}"]`).click();
      assert.equal(await page.locator('[data-drill][aria-pressed="true"]').count(), 1);
      assert.equal(await page.locator(`[data-drill="${kind}"]`).getAttribute('aria-pressed'), 'true');
      const prediction = await page.evaluate(() => {
        const app = cueLab;
        app.prediction = app.world.predictShot(app.shotOptions(), 12, 2000);
        app.updatePredictionMetrics();
        return { cue: { ...app.world.getCueBall().pos }, firstHit: Boolean(app.prediction.firstHit),
          firstRail: app.prediction.events.find((event) => event.type === 'cushion' && event.ballId === 'cue')?.cushionId,
          ghost: app.predictedAimContact(), cut: document.querySelector('#cutAngleMetric').textContent,
          maxHeight: Math.max(...app.prediction.paths.get('cue').map(p => p.y)),
          feedback: document.querySelector('#shotFeedback').textContent };
      });
      if (kind === 'masse') {
        assert.equal(prediction.firstHit, false, 'massé did not clear the obstacle');
        assert.equal(prediction.ghost, null, 'straight-ray ghost contradicts the curved trajectory');
        assert.equal(prediction.cut, '—');
        assert.ok(prediction.maxHeight > 0, 'prediction lost its airborne height');
        assert.match(prediction.feedback, /尚未.*标定/);
      }
      if (kind === 'gear') {
        assert.ok(prediction.firstHit && prediction.ghost);
        assert.ok(prediction.ghost.cutAngle > 25 && prediction.ghost.cutAngle < 35);
      }
      await page.locator('#shootButton').click();
      const actual = await page.evaluate(() => {
        const app = cueLab; app.setPaused(true);
        for (let i = 0; i < 20000 && app.world.isMoving(); i += 1) app.world.step(0.001);
        if (app.pendingSettle) app.settleShot();
        return { record: app.shotRecord, moving: app.world.isMoving(),
          cue: { ...app.world.getCueBall().pos }, toast: document.querySelector('#toast').textContent };
      });
      assert.equal(actual.moving, false, `${kind}: failed to settle`);
      if (kind === 'draw' || kind === 'follow') {
        assert.ok(actual.record.potted.includes('1'), `${kind}: target not potted`);
        assert.ok(actual.record.cueRail, `${kind}: cue never reached the rail`);
      }
      if (kind === 'english') {
        // The drill compares first-rail angles; the toast must report that
        // rail, not whichever cushion the cue ball touched last.
        assert.match(actual.toast, /^首库 · /);
        assert.equal(actual.record.cueRail.cushionId, prediction.firstRail, 'english drill toast is not about the first rail');
      }
      if (kind === 'follow') {
        assert.ok(actual.record.returnedCueRail?.returned);
        assert.match(actual.toast, /回吸同库/);
      }
      if (kind === 'masse') {
        assert.equal(actual.record.firstContact, null);
        assert.ok(actual.cue.z > 0.1);
      }
      await page.locator('#undoButton').click();
      const restored = await page.evaluate(() => ({ ...cueLab.world.getCueBall().pos }));
      assert.deepEqual(restored, prediction.cue, `${kind}: undo lost the original ball position`);
      console.log(`Browser drill ${kind}: prediction, real shot and undo passed.`);
    }

    // Chinese eight-ball rules (CBSA 2017) as a player meets them.
    const settle = () => page.evaluate(() => {
      const app = cueLab; app.setPaused(true);
      for (let i = 0; i < 40000 && app.world.isMoving(); i += 1) app.world.step(0.001);
      if (app.pendingSettle) app.settleShot();
      app.setPaused(false);
      return { rule: JSON.parse(JSON.stringify(app.rule)), record: JSON.parse(JSON.stringify(app.shotRecord)),
        toast: document.querySelector('#toast').textContent, cue: { ...app.world.getCueBall().pos } };
    });
    // The break is played with the cue ball in hand behind the head string;
    // an 8 potted on the break is spotted and the breaker continues (§5.4).
    await page.goto(`${url}/?rack=557`);
    await page.waitForFunction(() => window.cueLab?.renderer?.lastRenderSignature);
    assert.equal(await page.evaluate(() => cueLab.rule.ballInHand), 'kitchen');
    await page.evaluate(() => {
      const app = cueLab, w = app.world, cue = w.getCueBall(), apex = w.getBall('1');
      cue.pos = { x: w.table.cueStart, z: 0.45 };
      const d = { x: apex.pos.x - cue.pos.x, z: apex.pos.z - cue.pos.z }, n = Math.hypot(d.x, d.z);
      app.aimDirection = { x: d.x / n, z: d.z / n }; app.power = 1; app.elevation = 4; app.updateAllUI(); app.shoot();
    });
    let result = await settle();
    assert.deepEqual(result.record.potted, ['8'], 'fixed break no longer pots the 8');
    assert.equal(result.rule.winner, null, 'an 8 on the break must not lose the rack');
    assert.equal(result.rule.currentPlayer, 0, 'the breaker continues after a legal pot');
    assert.deepEqual(result.rule.groups, [null, null], 'the break must not decide the groups');
    assert.ok(await page.evaluate(() => { const b = cueLab.world.getBall('8'); return !b.pocketed && Math.abs(b.pos.x - cueLab.world.table.rackApex) < 1e-6; }));
    // A soft break that sends fewer than four balls to a cushion is illegal:
    // the opponent chooses (§5.2) and nobody may shoot meanwhile.
    await page.goto(`${url}/?rack=3`);
    await page.waitForFunction(() => window.cueLab?.renderer?.lastRenderSignature);
    await page.evaluate(() => { cueLab.power = 0.25; cueLab.updatePowerUI(); cueLab.shoot(); });
    result = await settle();
    assert.deepEqual(result.rule.pendingChoice, { kind: 'illegalBreak', chooser: 1, breaker: 0 });
    await page.waitForFunction(() => !document.querySelector('#ruleChoice').hidden);
    await page.evaluate(() => cueLab.performPrimaryAction());
    assert.equal(await page.evaluate(() => cueLab.world.inShot), false, 'a shot fired while the choice was pending');
    // Space moves focus to the panel, never onto an option it would press.
    await page.keyboard.press('Space'); await page.keyboard.press('Space');
    assert.ok(await page.evaluate(() => Boolean(cueLab.rule.pendingChoice)), 'Space picked an illegal-break option');
    await page.locator('#ruleChoiceAccept').click();
    assert.deepEqual(await page.evaluate(() => [cueLab.rule.currentPlayer, cueLab.rule.ballInHand]), [1, 'table']);
    // Ball in hand: pressing on the cue ball picks it up and places it, it
    // does not stroke a shot.
    const drag = await page.evaluate(() => {
      const app = cueLab, cue = app.world.getCueBall(), rect = app.glCanvas.getBoundingClientRect();
      const from = app.renderer.project({ x: cue.pos.x, y: cue.radius, z: cue.pos.z });
      const to = app.renderer.project({ x: -0.9, y: cue.radius, z: -0.35 });
      return { from: { x: rect.left + from.x, y: rect.top + from.y }, to: { x: rect.left + to.x, y: rect.top + to.y } };
    });
    await page.mouse.move(drag.from.x, drag.from.y);
    await page.mouse.down();
    // Space while the ball is held must not stroke it out of the hand.
    await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => cueLab.world.inShot), false, 'Space fired a shot while the cue ball was held');
    await page.mouse.move(drag.to.x, drag.to.y, { steps: 8 });
    await page.mouse.up();
    const placed = await page.evaluate(() => ({ ...cueLab.world.getCueBall().pos, inShot: cueLab.world.inShot }));
    assert.equal(placed.inShot, false, 'picking up the cue ball fired a shot');
    assert.ok(Math.hypot(placed.x + 0.9, placed.z + 0.35) < 0.01, 'the cue ball did not follow the drag');
    // A foul leaves the cue ball where it stopped and hands the opponent ball
    // in hand; touching a ball with nothing reaching a cushion is a foul (§9.2).
    await page.evaluate(() => {
      const app = cueLab, w = app.world, cue = w.getCueBall();
      const target = w.balls.find((b) => b.id !== 'cue' && !b.pocketed && b.number !== 8
        && Math.abs(b.pos.x) < 1.0 && Math.abs(b.pos.z) < 0.4);
      cue.pos = { x: target.pos.x - 0.12, z: target.pos.z };
      app.aimDirection = { x: 1, z: 0 }; app.power = 0.03; app.elevation = 3; app.setSpin(0, -0.3); app.shoot();
    });
    result = await settle();
    assert.ok(result.record.firstContact && !result.record.railAfterContact && !result.record.potted.length);
    assert.equal(result.rule.currentPlayer, 0, 'the turn did not pass after the foul');
    assert.equal(result.rule.ballInHand, 'table');
    assert.match(result.toast, /没有球碰库/);
    // A cue ball driven off the table is a foul, not a pot in the nearest
    // pocket, and the aiming readout warns about it beforehand.
    const jump = await page.evaluate(() => {
      const app = cueLab, w = app.world;
      app.world.getCueBall().pos = { x: -0.9, z: 0.1 };
      app.aimDirection = { x: 0, z: 1 }; app.power = 1; app.elevation = 45; app.setSpin(0, 0); app.updateAllUI();
      app.prediction = w.predictShot(app.shotOptions(), 12, 3000); app.updatePredictionMetrics();
      const label = document.querySelector('#firstHitMetric').textContent;
      app.shoot();
      return label;
    });
    assert.equal(jump, '飞出台面');
    result = await settle();
    assert.deepEqual(result.record.offTable, ['cue']);
    assert.ok(!result.record.potted.includes('cue'));
    assert.equal(result.rule.ballInHand, 'table');
    // A cue ball frozen to the rail cannot be struck low: the stick rises
    // over the cushion and the contact is lifted to what the stick can reach.
    const frozen = await page.evaluate(() => {
      const app = cueLab, w = app.world, cue = w.getCueBall();
      cue.pos = { x: 0.3, z: -w.table.height / 2 + cue.radius + 0.0002 };
      app.aimDirection = { x: 0, z: 1 }; app.elevation = 3; app.setSpin(0, -0.6); app.updateAllUI();
      return app.strokeGeometry();
    });
    assert.ok(frozen.elevation > 25, `frozen cue ball stroked at ${frozen.elevation.toFixed(1)}° through the rail`);
    assert.ok(frozen.liftedTip && frozen.tipY > -0.6, 'a rail-frozen cue ball accepted a deep draw');
    // A ball frozen to the cushion and driven straight into it does not
    // satisfy the rail requirement (CBSA §13.2): foul, ball in hand.
    const frozenRail = await page.evaluate(() => {
      const app = cueLab, w = app.world, t = w.table;
      w.balls.forEach((b) => { if (!['cue', '3', '8'].includes(b.id)) { b.pocketed = true; b.sinkTarget = null; b.sinkDepth = 1; } });
      const three = w.getBall('3'), cue = w.getCueBall();
      Object.assign(three, { pocketed: false, pos: { x: 0.3, z: t.height / 2 - three.radius - 0.0001 }, vel: { x: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } });
      Object.assign(cue, { pos: { x: 0.3, z: 0.1 }, vel: { x: 0, z: 0 }, omega: { x: 0, y: 0, z: 0 } });
      Object.assign(w.getBall('8'), { pocketed: false, pos: { x: -0.8, z: -0.3 } });
      app.rule.winner = null; app.rule.pendingChoice = null; app.rule.breakShot = false;
      app.rule.groups = ['solid', 'stripe']; app.rule.currentPlayer = 0; app.rule.ballInHand = null;
      app.aimDirection = { x: 0, z: 1 }; app.power = 0.1; app.setSpin(0, 0); app.elevation = 0; app.sound.enabled = false;
      app.setPaused(false); app.shoot(); app.setPaused(true);
      for (let i = 0; i < 20000 && w.isMoving(); i += 1) w.step(0.001);
      if (app.pendingSettle) app.settleShot();
      return { railAfter: app.shotRecord.railAfterContact, current: app.rule.currentPlayer, ballInHand: app.rule.ballInHand };
    });
    assert.equal(frozenRail.railAfter, false, 'a frozen ball pushed into its rail counted as a rail contact');
    assert.deepEqual([frozenRail.current, frozenRail.ballInHand], [1, 'table'], 'no foul for a frozen-ball push into the rail');
    console.log('Browser rules: break, illegal break, ball in hand, no-rail foul, off-table, frozen-rail and rail-frozen stroke passed.');
    // Palladium skin, as on the Dynaspheres set: the badge is the rotor logo
    // (apex lobe about twice as far from the centre as the opposite valley),
    // and on a stripe it stands along the ivory band, so the colour caps sit
    // beside the number rather than above and below it.  The 8's outline
    // badge is as large as the others.
    const skin = await page.evaluate(() => {
      const r = cueLab.renderer;
      const paint = (number, kind) => {
        const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 256;
        const ctx = canvas.getContext('2d');
        r.paintPalladiumBall(ctx, { kind, number, color: BilliardsPhysics.PALLADIUM_COLORS[number] });
        const data = ctx.getImageData(0, 0, 512, 256).data;
        const lum = (x, y) => { const i = (y * 512 + x) * 4; return data[i] + data[i + 1] + data[i + 2]; };
        const onContour = number === 8 ? (x, y) => lum(x, y) > 450 : (x, y) => lum(x, y) < 200;
        // Walk out from the badge centre to its contour, starting past the
        // numeral, which sits a little toward the apex.
        const walk = (dx, dy, from = 20) => { for (let step = from; step < 110; step += 1) if (onContour(128 + dx * step, 128 + dy * step)) return step; return null; };
        const rgb = (x, y) => { const i = (y * 512 + x) * 4; return [data[i], data[i + 1], data[i + 2]]; };
        const stripe = kind === 'stripe';
        return { east: walk(1, 0, stripe ? 26 : 20), west: walk(-1, 0), north: walk(0, -1, stripe ? 20 : 26), south: walk(0, 1),
          polar: rgb(128, 20), band: rgb(40, 128) };
      };
      return { stripe: paint(11, 'stripe'), solid: paint(3, 'solid'), eight: paint(8, 'solid') };
    });
    const hex = (value) => [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16));
    const close = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 24);
    assert.ok(skin.stripe.east > 1.7 * skin.stripe.west && Math.abs(skin.stripe.north - skin.stripe.south) <= 3,
      `stripe badge must stand along the band: ${JSON.stringify(skin.stripe)}`);
    assert.ok(close(skin.stripe.polar, hex('#df3339')) && close(skin.stripe.band, hex('#f2e9d2')),
      'stripe caps must be at the poles with the ivory band around the badges');
    assert.ok(skin.solid.north > 1.7 * skin.solid.south && Math.abs(skin.solid.east - skin.solid.west) <= 3,
      `solid badge is not an apex-up rotor: ${JSON.stringify(skin.solid)}`);
    assert.ok(['north', 'south', 'east', 'west'].every((k) => Math.abs(skin.eight[k] - skin.solid[k]) <= 4),
      `the 8's outline badge must match the others: ${JSON.stringify(skin.eight)}`);
    console.log('Browser Palladium skin: rotor badge, stripe band orientation and 8 badge passed.');
    // Canopy lighting as over a professional table: the bed is lit nearly
    // evenly to the corners, a ball throws a dark contact shadow along the
    // table, and a polished black ball mirrors the panels straight above it.
    const light = await page.evaluate(() => {
      const app = cueLab, r = app.renderer, gl = r.gl, w = app.world, t = w.table;
      app.setPaused(true);
      w.balls.forEach((b) => { b.pocketed = true; b.sinkTarget = null; b.sinkDepth = 1; });
      const eight = w.getBall('8');
      Object.assign(eight, { pocketed: false, pos: { x: 0, z: 0 }, posY: 0 });
      const R = eight.radius;
      r.cameraMode = 'top'; r.zoom = 1; r.orbit = null; r.updateCamera(); r.lastRenderSignature = null;
      r.render(w, { showCue: false });
      const dpr = r.canvas.width / r.cssWidth;
      const sample = (x, y, z) => {
        const p = r.project({ x, y, z }), px = new Uint8Array(4);
        gl.readPixels(Math.round(p.x * dpr), Math.round(r.canvas.height - p.y * dpr), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return px[0] + px[1] + px[2];
      };
      return { open: sample(0.35, 0, 0.25), corner: sample(t.width / 2 - 0.06, 0, t.height / 2 - 0.06),
        shadow: sample(1.15 * R, 0, 0), top: sample(0, 2 * R, 0), side: sample(0.8 * R, 1.6 * R, 0) };
    });
    assert.ok(light.corner > 0.7 * light.open && light.corner <= light.open, `bed lighting is not even: ${JSON.stringify(light)}`);
    assert.ok(light.shadow < 0.88 * light.open, `no contact shadow beside the ball: ${JSON.stringify(light)}`);
    assert.ok(light.top > 350 && light.top > 2.5 * light.side, `the black ball does not mirror the canopy: ${JSON.stringify(light)}`);
    console.log('Browser lighting: even canopy, contact shadow and canopy reflection passed.');
    // A GPU reset rebuilds the renderer; the chosen cloth must survive it.
    await page.goto(url);
    await page.waitForFunction(() => window.cueLab?.renderer?.lastRenderSignature);
    await page.evaluate(() => {
      const select = document.querySelector('#tableTheme');
      select.value = 'blue'; select.dispatchEvent(new Event('change'));
      window.__loseContext = cueLab.renderer.gl.getExtension('WEBGL_lose_context');
      window.__loseContext.loseContext();
    });
    await page.waitForTimeout(300);
    await page.evaluate(() => window.__loseContext.restoreContext());
    await page.waitForFunction(() => cueLab.renderer.gl.isContextLost() === false && cueLab.renderer.lastRenderSignature);
    assert.equal(await page.evaluate(() => cueLab.renderer.tableTheme), 'blue', 'table theme lost after WebGL context restore');
    assert.equal(await page.evaluate(() => cueLab.renderer.gl.getError()), 0, 'WebGL error after context restore');
    await page.evaluate(() => { const select = document.querySelector('#tableTheme'); select.value = 'club'; select.dispatchEvent(new Event('change')); });
    console.log('Browser WebGL context restore keeps the table theme passed.');
    // Speed: a table at rest is neither stepped nor redrawn, and a full
    // break preview is spread over frames instead of stalling one.
    await page.goto(url);
    await page.waitForFunction(() => window.cueLab?.renderer?.lastRenderSignature);
    const idle = await page.evaluate(async () => {
      const app = cueLab, gl = app.renderer.gl;
      await new Promise((resolve) => setTimeout(resolve, 600));
      let draws = 0;
      const clear = gl.clear.bind(gl);
      gl.clear = (mask) => { draws += 1; return clear(mask); };
      const time = app.world.time;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      gl.clear = clear;
      return { draws, stepped: app.world.time - time };
    });
    assert.equal(idle.draws, 0, 'an idle table was redrawn');
    assert.equal(idle.stepped, 0, 'an idle table was stepped');
    const preview = await page.evaluate(async () => {
      const app = cueLab;
      let longest = 0;
      for (const name of ['updatePrediction', 'advancePredictionJob']) {
        const original = app[name].bind(app);
        app[name] = (...args) => { const t0 = performance.now(); try { return original(...args); } finally { longest = Math.max(longest, performance.now() - t0); } };
      }
      app.power = 1; app.updatePowerUI(); app.schedulePrediction(true);
      const started = performance.now();
      while (app.predictionJob !== null || !app.prediction) {
        if (performance.now() - started > 8000) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return { longest, truncated: app.prediction?.truncated, moved: app.prediction?.paths.size };
    });
    assert.ok(preview.longest < 30, `the break preview stalled the main thread for ${preview.longest.toFixed(1)} ms`);
    assert.equal(preview.truncated, false, 'the break preview never finished');
    assert.ok(preview.moved > 8, 'the break preview lost the object balls');
    console.log('Browser speed: idle table not redrawn, break preview sliced across frames passed.');
    await page.goto(url);
    await page.waitForFunction(() => window.cueLab?.renderer?.lastRenderSignature);

    for (const mode of ['practice', 'eight', 'nine', 'snooker', 'chineseEight']) {
      await page.locator('#gameMode').selectOption(mode);
      await page.waitForFunction(mode => cueLab.world.mode === mode, mode);
      assert.equal(await page.evaluate(() => cueLab.renderer.gl.getError()), 0, `${mode}: WebGL error`);
      assert.equal(await page.locator('[data-drill][aria-pressed="true"]').count(), 0);
    }
    await page.locator('#shotTab').click();
    await page.locator('#assistGhost').check();
    await page.evaluate(() => { document.querySelector('.panel-scroll').scrollTop = 0; });
    await page.mouse.move(1420, 20);
    await page.screenshot({ path: path.join(screenshots, 'desktop.png') });
    // A long toast sits over the table, above the guide legend, not on it.
    await page.evaluate(() => cueLab.toast('首库 · 入 31.2° / 出 44.6° · 胶边压缩 2.1 mm · 顺塞让点 12 mm/m，撤销后换反塞对照'));
    await page.waitForTimeout(350);
    const toastLayout = await page.evaluate(() => {
      const [t, l, s] = ['#toast', '.aim-legend', '.stage'].map((q) => document.querySelector(q).getBoundingClientRect());
      return { overlap: t.bottom > l.top && t.top < l.bottom && t.right > l.left && t.left < l.right,
        offCentre: Math.abs(t.left + t.right - s.left - s.right) / 2 };
    });
    assert.ok(!toastLayout.overlap, 'a long toast covers the guide legend');
    assert.ok(toastLayout.offCentre < 2, `the toast is ${toastLayout.offCentre.toFixed(0)} px off the table centre`);
    await page.locator('#cameraButton').click();
    await page.screenshot({ path: path.join(screenshots, 'top.png') });

    for (const [width, height] of [[390, 844], [320, 700], [768, 1024]]) {
      const mobile = await browser.newPage({ viewport: { width, height }, isMobile: true, hasTouch: true });
      mobile.on('pageerror', error => errors.push(error.message));
      await mobile.goto(url);
      await mobile.waitForFunction(() => cueLab?.renderer?.lastRenderSignature);
      const layout = await mobile.evaluate(() => {
        const shoot = document.querySelector('#shootButton').getBoundingClientRect();
        return { doc: document.documentElement.scrollWidth, footer: document.querySelector('.bottom-bar').scrollWidth,
          right: shoot.right, bottom: shoot.bottom, height: innerHeight };
      });
      assert.ok(layout.doc <= width && layout.footer <= width && layout.right <= width, `${width}: horizontal overflow`);
      assert.ok(layout.bottom <= layout.height, `${width}: primary action outside viewport`);
      await mobile.locator('#helpButton').tap();
      assert.equal(await mobile.locator('#helpDialog').isVisible(), true);
      await mobile.locator('#closeHelp').tap();
      await mobile.locator('#cameraButton').tap();
      assert.equal(await mobile.evaluate(() => cueLab.renderer.cameraMode), 'top');
      await mobile.locator('#cameraButton').tap();
      await mobile.locator('#labTab').tap();
      await mobile.locator('[data-drill="draw"]').tap();
      assert.equal(await mobile.evaluate(() => cueLab.activeDrill), 'draw');
      await mobile.locator('[data-drill="masse"]').tap();
      assert.equal(await mobile.evaluate(() => cueLab.elevation), 60);
      // The body is the mobile scroll container: controls below the first
      // viewport must remain reachable above the fixed primary-action bar.
      await mobile.locator('#tableTheme').selectOption('classic');
      assert.equal(await mobile.evaluate(() => cueLab.renderer.tableTheme), 'classic');
      await mobile.locator('#soundSetting').uncheck();
      assert.equal(await mobile.evaluate(() => cueLab.sound.enabled), false);
      await mobile.locator('#shotTab').tap();
      await mobile.locator('#powerSlider').tap();
      assert.ok(await mobile.evaluate(() => cueLab.power > 0.45 && cueLab.power < 0.6));
      await mobile.evaluate(() => { document.body.scrollTop = 0; });
      if (width === 390) await mobile.screenshot({ path: path.join(screenshots, 'mobile.png') });
      await mobile.close();
      console.log(`Touch ${width} × ${height}: layout, help, camera and drill controls passed.`);
    }
    assert.deepEqual(errors, [], 'browser JavaScript errors');
    console.log(`Browser regression passed. Screenshots: ${screenshots}`);
  } finally {
    await browser.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
