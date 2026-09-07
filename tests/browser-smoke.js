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
        clearTimeout(app.predictionUpgradeTimer);
        app.prediction = app.world.predictShot(app.shotOptions(), 12, 2000);
        app.updatePredictionMetrics();
        return { cue: { ...app.world.getCueBall().pos }, firstHit: Boolean(app.prediction.firstHit),
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
