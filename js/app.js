(function () {
  'use strict';

  const { PhysicsWorld } = window.BilliardsPhysics;
  const { BilliardsRenderer } = window.BilliardsRenderer;
  const { V2, clamp } = window.BilliardsMath;

  // Hold-to-adjust keys are integrated per frame for smooth, fine control:
  // WASD moves the tip contact point, Q/E scales cue speed, Z/C trims the
  // horizontal aim angle for English (squirt/swerve) compensation practice.
  const ADJUST_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'z', 'c']);
  const TIP_RATE = 0.85;      // tip offset (fraction of R) per second
  const POWER_RATE = 0.5;     // power fraction per second
  const TRIM_RATE = 1.8;      // aim trim degrees per second
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  class SoundEngine {
    constructor() { this.context = null; this.enabled = true; }
    ensure() {
      if (!this.enabled) return null;
      if (!this.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return null;
        this.context = new AudioContext();
      }
      if (this.context.state === 'suspended') this.context.resume();
      return this.context;
    }
    setEnabled(value) {
      this.enabled = value;
      if (value) this.ensure();
    }
    click(kind, intensity = 0.5) {
      const ctx = this.ensure();
      if (!ctx) return;
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      const filter = ctx.createBiquadFilter();
      filter.type = kind === 'pocket' ? 'lowpass' : 'bandpass';
      // Phenolic resin balls click around 2–3 kHz; the leather tip is duller.
      filter.frequency.value = kind === 'rail' ? 400 : kind === 'pocket' ? 210 : kind === 'cue' ? 1150 : 2550;
      filter.Q.value = kind === 'pocket' ? 0.7 : kind === 'ball' ? 2.4 : 1.2;
      gain.gain.setValueAtTime(Math.min(0.18, 0.035 + intensity * 0.075), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + (kind === 'pocket' ? 0.19 : kind === 'ball' ? 0.042 : 0.055));
      const frames = Math.max(1, Math.floor(ctx.sampleRate * (kind === 'pocket' ? 0.18 : 0.055)));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < frames; i += 1) channel[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / frames, kind === 'pocket' ? 1.8 : 4);
      const noise = ctx.createBufferSource();
      noise.buffer = buffer;
      noise.connect(filter).connect(gain).connect(ctx.destination);
      noise.start(now);
      if (kind === 'pocket' || kind === 'cue') {
        const osc = ctx.createOscillator();
        const oscGain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(kind === 'pocket' ? 115 : 260, now);
        osc.frequency.exponentialRampToValueAtTime(kind === 'pocket' ? 58 : 140, now + 0.12);
        oscGain.gain.setValueAtTime(0.03 + intensity * 0.025, now);
        oscGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.14);
        osc.connect(oscGain).connect(ctx.destination); osc.start(now); osc.stop(now + 0.15);
      }
    }
  }

  class CueLabApp {
    constructor() {
      this.stage = $('#stage');
      this.glCanvas = $('#glCanvas');
      this.guideCanvas = $('#guideCanvas');
      this.guideContext = this.guideCanvas.getContext('2d');
      try {
        this.renderer = new BilliardsRenderer(this.glCanvas);
      } catch (error) {
        console.error(error);
        $('#webglError').hidden = false;
        return;
      }

      this.world = new PhysicsWorld('chineseEight', { cueType: 'small', tipType: 'medium' });
      this.renderer.setTable(this.world.table);
      this.sound = new SoundEngine();
      this.aimDirection = { x: 1, z: 0 };
      this.tipX = 0;
      this.tipY = 0;
      this.power = 0.62;
      this.elevation = 3;
      this.keys = new Set();
      this.aimTrim = 0;
      this.drag = null;
      this.pullback = 0;
      this.paused = false;
      this.slowMotion = false;
      this.guidesEnabled = true;
      this.gridEnabled = true;
      this.trailsEnabled = true;
      this.prediction = null;
      this.predictionDirty = true;
      this.predictionTimer = null;
      this.lastPredictionAt = 0;
      this.actualTrails = new Map();
      this.trailFrame = 0;
      this.effects = [];
      this.undoStack = [];
      this.shotRecord = this.emptyShotRecord();
      this.shotNumber = 1;
      this.rule = this.createRuleState('chineseEight');
      this.activeDrill = null;
      this.predictedRailEvent = null;
      this.pendingSettle = false;
      this.predictedShotDuration = 1;
      this.accumulator = 0;
      this.lastFrameTime = performance.now();
      this.frameCount = 0;
      this.fpsTime = performance.now();
      this.wasMoving = false;
      this.toastTimer = null;
      this.helpOpen = false;
      this.assists = { trajectory: true, ghost: true, tangent: true, pocket: true };

      this.bindUI();
      this.world.onEvent((event) => this.handlePhysicsEvent(event));
      this.updateAllUI();
      this.applyStartupParams();
      this.schedulePrediction(true);
      requestAnimationFrame((time) => this.frame(time));
    }

    // Shareable setup via URL, e.g. ?tipx=0.5&tipy=-0.3&power=0.8&elev=6&aim=15&view=top&shoot=1
    applyStartupParams() {
      const params = new URLSearchParams(window.location.search);
      if (![...params.keys()].length) return;
      const num = (key) => {
        const value = parseFloat(params.get(key));
        return Number.isFinite(value) ? value : null;
      };
      const mode = params.get('mode');
      if (mode && $(`#gameMode option[value="${CSS.escape(mode)}"]`)) this.changeMode(mode);
      if (params.get('view') === 'top') {
        this.renderer.toggleCamera();
        $('#cameraButton').classList.add('active');
      }
      const tipX = num('tipx'), tipY = num('tipy');
      if (tipX != null || tipY != null) this.setSpin(tipX ?? 0, tipY ?? 0);
      const power = num('power');
      if (power != null) { this.power = clamp(power, 0.03, 1); this.updatePowerUI(); }
      const elevation = num('elev');
      if (elevation != null) {
        this.elevation = clamp(Math.round(elevation), 0, 35);
        this.updateElevationUI(); this.updateSpinUI();
      }
      const aim = num('aim');
      if (aim != null) {
        const radians = aim * Math.PI / 180;
        this.aimDirection = { x: Math.cos(radians), z: Math.sin(radians) };
      }
      const trim = num('trim');
      if (trim != null) this.rotateAim(trim);
      if (params.get('shoot') === '1') {
        // Optional t=<seconds> fast-forwards the shot so a shared link (or a
        // headless screenshot) lands exactly mid-flight.
        const fastForward = clamp(num('t') ?? 0, 0, 12);
        this.shoot();
        if (fastForward > 0 && this.world.inShot) {
          const dt = 1 / 300;
          for (let i = 0; i < fastForward * 300 && this.world.isMoving(); i += 1) {
            this.world.step(dt);
            this.trailFrame += 1;
            if (this.trailsEnabled && this.trailFrame % 5 === 0) this.captureTrails();
          }
        }
      }
    }

    emptyShotRecord() {
      return { firstContact: null, potted: [], cushions: [], lowestAtStart: null, expectedAtStart: null };
    }

    createRuleState(mode) {
      return {
        mode,
        currentPlayer: 0,
        scores: [0, 0],
        groups: [null, null],
        winner: null,
        snookerExpected: 'red',
        snookerClearance: 0,
      };
    }

    bindUI() {
      $('#gameMode').addEventListener('change', (event) => this.changeMode(event.target.value));
      $('#resetButton').addEventListener('click', () => this.resetRack());
      $('#soundToggle').addEventListener('click', () => {
        this.sound.setEnabled(!this.sound.enabled);
        $('#soundToggle').classList.toggle('muted', !this.sound.enabled);
        this.toast(this.sound.enabled ? '碰撞声音已开启' : '声音已关闭');
      });

      $('#helpButton').addEventListener('click', () => this.openHelp());
      $('#closeHelp').addEventListener('click', () => $('#helpDialog').close());
      $('#helpDialog').addEventListener('click', (event) => {
        if (event.target === $('#helpDialog')) $('#helpDialog').close();
      });

      $('#shootButton').addEventListener('click', () => this.shoot());
      $('#powerSlider').addEventListener('input', (event) => {
        this.power = Number(event.target.value) / 100;
        this.updatePowerUI(); this.schedulePrediction();
      });
      $('#elevationSlider').addEventListener('input', (event) => {
        this.elevation = Number(event.target.value);
        this.updateElevationUI(); this.updateSpinUI(); this.schedulePrediction();
      });
      $('#clothPreset').addEventListener('change', (event) => {
        this.world.setClothPreset(event.target.value);
        this.updateEquipmentHint();
        this.schedulePrediction(true);
        const label = event.target.options[event.target.selectedIndex].text;
        this.toast(`台呢已切换为：${label}`);
      });
      $('#cueType').addEventListener('change', (event) => {
        this.world.setCueType(event.target.value);
        this.updateSpinUI(); this.updateEquipmentHint(); this.schedulePrediction(true);
        this.toast(`已切换：${event.target.selectedOptions[0].text}`);
      });
      $('#tipType').addEventListener('change', (event) => {
        this.world.setTipType(event.target.value);
        this.updateSpinUI(); this.updateEquipmentHint(); this.schedulePrediction(true);
        this.toast(`皮头设为：${event.target.selectedOptions[0].text}`);
      });
      $$('[data-drill]').forEach((button) => button.addEventListener('click', () => this.loadDrill(button.dataset.drill)));

      this.bindSpinControl();
      $$('.presets button').forEach((button) => button.addEventListener('click', () => {
        const [x, y] = button.dataset.spin.split(',').map(Number);
        this.setSpin(x, y);
        $$('.presets button').forEach((item) => item.classList.toggle('active', item === button));
      }));
      $('#centerSpin').addEventListener('click', () => this.setSpin(0, 0));

      $('#guideToggle').addEventListener('click', () => this.toggleGuides());
      $('#diamondToggle').addEventListener('click', () => {
        this.gridEnabled = !this.gridEnabled; $('#diamondToggle').classList.toggle('active', this.gridEnabled);
      });
      $('#trailToggle').addEventListener('click', () => {
        this.trailsEnabled = !this.trailsEnabled; $('#trailToggle').classList.toggle('active', this.trailsEnabled);
        if (!this.trailsEnabled) this.actualTrails.clear();
      });
      $('#cameraButton').addEventListener('click', () => {
        const mode = this.renderer.toggleCamera();
        $('#cameraButton').classList.toggle('active', mode === 'top');
        this.schedulePrediction(true);
      });

      const assistMap = {
        assistTrajectory: 'trajectory', assistGhost: 'ghost', assistTangent: 'tangent', assistPocket: 'pocket',
      };
      Object.entries(assistMap).forEach(([id, key]) => $(`#${id}`).addEventListener('change', (event) => { this.assists[key] = event.target.checked; }));
      $('#assistAll').addEventListener('click', () => {
        const shouldEnable = Object.values(this.assists).some((value) => !value);
        Object.entries(assistMap).forEach(([id, key]) => { this.assists[key] = shouldEnable; $(`#${id}`).checked = shouldEnable; });
        $('#assistAll').textContent = shouldEnable ? '全部关闭' : '全部开启';
      });

      $('#undoButton').addEventListener('click', () => this.undo());
      $('#pauseButton').addEventListener('click', () => this.togglePause());
      $('#slowButton').addEventListener('click', () => {
        this.slowMotion = !this.slowMotion;
        $('#slowButton').classList.toggle('active', this.slowMotion);
        this.toast(this.slowMotion ? '慢动作：½ 倍速' : '恢复正常速度');
      });

      this.glCanvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
      this.glCanvas.addEventListener('pointermove', (event) => this.pointerMove(event));
      this.glCanvas.addEventListener('pointerup', (event) => this.pointerUp(event));
      this.glCanvas.addEventListener('pointercancel', (event) => this.pointerUp(event, true));
      this.glCanvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        this.renderer.setZoom(event.deltaY > 0 ? 1.08 : 0.93);
      }, { passive: false });

      window.addEventListener('keydown', (event) => {
        if (/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName)) return;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        const key = event.key.toLowerCase();
        if (ADJUST_KEYS.has(key) && !$('#helpDialog').open) {
          this.keys.add(key);
          event.preventDefault();
          return;
        }
        if (event.repeat) return;
        if (event.code === 'Space') { event.preventDefault(); this.shoot(); }
        else if (key === 'r') this.resetRack();
        else if (key === 'g') this.toggleGuides();
        else if (key === 'm') { $('#slowButton').click(); }
        else if (event.key === 'Escape' && !$('#helpDialog').open) this.togglePause();
      });
      window.addEventListener('keyup', (event) => this.keys.delete(event.key.toLowerCase()));
      window.addEventListener('blur', () => this.keys.clear());
      window.addEventListener('resize', () => this.schedulePrediction(true));
    }

    bindSpinControl() {
      const control = $('#spinControl');
      let activePointer = null;
      const update = (event) => {
        const rect = control.getBoundingClientRect();
        let x = (event.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.39);
        let y = ((rect.top + rect.height / 2) - event.clientY) / (rect.height * 0.39);
        const length = Math.hypot(x, y);
        if (length > 0.9) { x *= 0.9 / length; y *= 0.9 / length; }
        this.setSpin(x, y);
      };
      control.addEventListener('pointerdown', (event) => {
        activePointer = event.pointerId; control.setPointerCapture(activePointer); update(event); this.sound.ensure();
      });
      control.addEventListener('pointermove', (event) => { if (event.pointerId === activePointer) update(event); });
      const release = (event) => { if (event.pointerId === activePointer) activePointer = null; };
      control.addEventListener('pointerup', release); control.addEventListener('pointercancel', release);
    }

    pointerDown(event) {
      if (event.button !== 0 || this.world.isMoving() || this.paused) return;
      this.sound.ensure();
      this.updateAimFromPointer(event);
      this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: 0 };
      this.glCanvas.setPointerCapture(event.pointerId);
      this.stage.classList.add('charging');
      this.positionPowerFloat(event);
    }

    pointerMove(event) {
      if (this.drag && event.pointerId === this.drag.pointerId) {
        const cue = this.world.getCueBall();
        const centre = this.renderer.project({ x: cue.pos.x, y: cue.radius, z: cue.pos.z });
        const ahead = this.renderer.project({ x: cue.pos.x + this.aimDirection.x * 0.25, y: cue.radius, z: cue.pos.z + this.aimDirection.z * 0.25 });
        if (!centre || !ahead) return;
        const screenDirection = V2.normalize({ x: ahead.x - centre.x, z: ahead.y - centre.y });
        const dx = event.clientX - this.drag.startX, dy = event.clientY - this.drag.startY;
        const pull = Math.max(0, -(dx * screenDirection.x + dy * screenDirection.z));
        this.drag.moved = Math.max(this.drag.moved, Math.hypot(dx, dy));
        this.power = clamp(0.03 + pull / 190, 0.03, 1);
        this.pullback = this.power * 0.14;
        this.updatePowerUI(); this.positionPowerFloat(event); this.schedulePrediction();
      } else if (!this.world.isMoving() && !this.paused) {
        this.updateAimFromPointer(event);
      }
    }

    pointerUp(event, cancelled = false) {
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      const shouldShoot = !cancelled && this.drag.moved > 11;
      this.drag = null; this.pullback = 0; this.stage.classList.remove('charging');
      if (shouldShoot) this.shoot();
    }

    positionPowerFloat(event) {
      const rect = this.stage.getBoundingClientRect();
      const element = $('#powerFloat');
      element.style.left = `${clamp(event.clientX - rect.left + 16, 10, rect.width - 110)}px`;
      element.style.top = `${clamp(event.clientY - rect.top - 18, 55, rect.height - 35)}px`;
      $('#dragPowerBar').style.width = `${this.power * 100}%`;
      $('#dragPowerLabel').textContent = `${Math.round(this.power * 100)}%`;
    }

    updateAimFromPointer(event) {
      const cue = this.world.getCueBall();
      if (!cue || cue.pocketed) return;
      const point = this.renderer.screenToTable(event.clientX, event.clientY, cue.radius);
      if (!point) return;
      const vector = V2.sub(point, cue.pos);
      if (V2.length(vector) < cue.radius * 1.4) return;
      this.aimDirection = V2.normalize(vector);
      if (this.aimTrim) { this.aimTrim = 0; this.updateHud(); }
      this.schedulePrediction();
    }

    setSpin(x, y) {
      let tipX = clamp(x, -0.9, 0.9), tipY = clamp(y, -0.9, 0.9);
      const length = Math.hypot(tipX, tipY);
      if (length > 0.9) { tipX *= 0.9 / length; tipY *= 0.9 / length; }
      this.tipX = tipX; this.tipY = tipY;
      this.updateSpinUI(); this.schedulePrediction();
      $$('.presets button').forEach((item) => item.classList.remove('active'));
    }

    rotateAim(degrees) {
      const radians = degrees * Math.PI / 180;
      const c = Math.cos(radians), s = Math.sin(radians);
      const d = this.aimDirection;
      // Positive degrees swing the aim toward the shooter's right.
      this.aimDirection = V2.normalize({ x: d.x * c - d.z * s, z: d.x * s + d.z * c });
      this.aimTrim += degrees;
      this.updateHud();
      this.schedulePrediction();
    }

    applyKeyControls(dt) {
      if (!this.keys.size) return;
      const has = (key) => this.keys.has(key);
      const dTipX = (has('d') ? 1 : 0) - (has('a') ? 1 : 0);
      const dTipY = (has('w') ? 1 : 0) - (has('s') ? 1 : 0);
      const dPower = (has('e') ? 1 : 0) - (has('q') ? 1 : 0);
      const dTrim = (has('c') ? 1 : 0) - (has('z') ? 1 : 0);
      if (dTipX || dTipY) this.setSpin(this.tipX + dTipX * TIP_RATE * dt, this.tipY + dTipY * TIP_RATE * dt);
      if (dPower) {
        this.power = clamp(this.power + dPower * POWER_RATE * dt, 0.03, 1);
        this.updatePowerUI(); this.schedulePrediction();
      }
      if (dTrim) this.rotateAim(dTrim * TRIM_RATE * dt);
    }

    speedFromPower() { return 0.18 + 6.15 * Math.pow(this.power, 1.34); }

    shotOptions() {
      return {
        direction: { ...this.aimDirection }, speed: this.speedFromPower(),
        tipX: this.tipX, tipY: this.tipY, elevation: this.elevation,
        cueType: this.world.cueType, tipType: this.world.tipType,
      };
    }

    shoot() {
      if (!this.renderer || this.paused || this.world.isMoving()) return;
      if (this.rule.winner != null) { this.toast(`本局已结束，${this.rule.winner + 1} 号选手获胜；重新摆球可开始下一局`); return; }
      const cue = this.world.getCueBall();
      if (!cue || cue.pocketed) { this.world.respotCue(); this.schedulePrediction(true); return; }
      this.sound.ensure();
      const snapshot = {
        world: this.world.snapshot(),
        rule: JSON.parse(JSON.stringify(this.rule)),
        shotNumber: this.shotNumber,
        aimDirection: { ...this.aimDirection },
      };
      this.undoStack.push(snapshot);
      if (this.undoStack.length > 20) this.undoStack.shift();
      this.shotRecord = this.emptyShotRecord();
      if (this.world.mode === 'nine') this.shotRecord.lowestAtStart = this.lowestNineBall();
      if (this.world.mode === 'snooker') this.shotRecord.expectedAtStart = this.rule.snookerExpected;
      this.actualTrails.clear();
      this.effects.length = 0;
      this.predictedShotDuration = this.prediction?.duration || 2;
      const success = this.world.strike(this.shotOptions());
      if (!success) this.undoStack.pop();
      else {
        this.prediction = null;
        $('#statusText').textContent = '观察旋转、碰撞与走位';
      }
    }

    handlePhysicsEvent(event) {
      if (event.type === 'cue') {
        this.sound.click('cue', clamp(event.speed / 6, 0.15, 1));
        this.addEffect(event.position, 'cue', event.speed);
      } else if (event.type === 'ball-ball') {
        this.sound.click('ball', clamp(event.speed / 4, 0.1, 1));
        this.addEffect(event.position, 'ball', event.speed);
        if (!this.shotRecord.firstContact && (event.aId === 'cue' || event.bId === 'cue')) {
          this.shotRecord.firstContact = event.aId === 'cue' ? event.bId : event.aId;
        }
      } else if (event.type === 'cushion') {
        this.sound.click('rail', clamp(event.speed / 4, 0.08, 0.85));
        this.addEffect(event.position, 'rail', event.speed);
        this.shotRecord.cushions.push(event.ballId);
        if (event.ballId === 'cue') {
          $('#statusText').textContent = `${this.railEffectLabel(event)} · 入 ${event.incidentAngle.toFixed(1)}° → 出 ${event.reboundAngle.toFixed(1)}°`;
        }
      } else if (event.type === 'pocket') {
        this.sound.click('pocket', clamp(event.speed / 3, 0.2, 1));
        this.addEffect(event.position, 'pocket', event.speed);
        this.shotRecord.potted.push(event.ballId);
      } else if (event.type === 'settled') {
        this.pendingSettle = true;
      }
    }

    addEffect(position, type, strength) {
      this.effects.push({ position: { ...position }, type, strength: clamp(strength || 0.4, 0.2, 4), born: performance.now(), life: type === 'pocket' ? 720 : 380 });
      if (this.effects.length > 30) this.effects.shift();
    }

    settleShot() {
      this.pendingSettle = false;
      this.evaluateRules();
      this.shotNumber += 1;
      this.schedulePrediction(true);
      this.updateAllUI();
    }

    evaluateRules() {
      const mode = this.world.mode;
      const cueFoul = this.shotRecord.potted.includes('cue');
      if (this.activeDrill) {
        if (cueFoul) this.world.respotCue();
        const rail = this.world.lastCushionEvent;
        this.toast(rail ? `${this.railEffectLabel(rail)}：入射 ${rail.incidentAngle.toFixed(1)}°，反弹 ${rail.reboundAngle.toFixed(1)}°` : '实验完成；点击同一场景可复位后做对照');
        return;
      }
      if (mode === 'practice') {
        const objectPots = this.shotRecord.potted.filter((id) => id !== 'cue').length;
        this.rule.scores[0] += objectPots;
        if (cueFoul) { this.world.respotCue(); this.toast('母球落袋，已自动复位'); }
        else if (objectPots) this.toast(`进球 ${objectPots} 颗 · 可以继续练习`);
        return;
      }
      if (mode === 'eight' || mode === 'chineseEight') this.evaluateEightBall(cueFoul);
      else if (mode === 'nine') this.evaluateNineBall(cueFoul);
      else this.evaluateSnooker(cueFoul);
    }

    evaluateEightBall(cueFoul) {
      const player = this.rule.currentPlayer, opponent = 1 - player;
      const first = this.world.getBall(this.shotRecord.firstContact);
      const group = this.rule.groups[player];
      const ownRemainingBefore = group ? this.undoStack.at(-1).world.balls.filter((b) => !b.pocketed && b.kind === group).length : null;
      const expectedEight = group && ownRemainingBefore === 0;
      let foul = cueFoul || !first;
      if (first) {
        if (group) foul ||= expectedEight ? first.number !== 8 : first.kind !== group;
        else foul ||= first.number === 8;
      }
      const eightPotted = this.shotRecord.potted.includes('8');
      if (eightPotted) {
        const legalWin = !foul && expectedEight;
        this.rule.winner = legalWin ? player : opponent;
        this.toast(legalWin ? `漂亮！P${player + 1} 合法打进 8 号球` : `8 号球提前或犯规落袋，P${opponent + 1} 获胜`);
        return;
      }
      const objectPots = this.shotRecord.potted.filter((id) => id !== 'cue' && id !== '8').map((id) => this.world.getBall(id)).filter(Boolean);
      if (!this.rule.groups[0] && !foul) {
        const assigned = objectPots.find((ball) => ball.kind === 'solid' || ball.kind === 'stripe');
        if (assigned) {
          this.rule.groups[player] = assigned.kind;
          this.rule.groups[opponent] = assigned.kind === 'solid' ? 'stripe' : 'solid';
          this.toast(`P${player + 1} 分组：${assigned.kind === 'solid' ? '全色球' : '花色球'}`);
        }
      }
      const legalPots = objectPots.filter((ball) => !this.rule.groups[player] || ball.kind === this.rule.groups[player]).length;
      this.rule.scores[player] += legalPots;
      if (foul) {
        this.world.respotCue(); this.rule.currentPlayer = opponent; this.toast(`P${player + 1} 犯规，交换球权`);
      } else if (!legalPots) {
        this.rule.currentPlayer = opponent;
      }
    }

    lowestNineBall() {
      const balls = this.world.balls.filter((b) => !b.pocketed && Number.isInteger(b.number) && b.number <= 9);
      return balls.length ? Math.min(...balls.map((b) => b.number)) : null;
    }

    evaluateNineBall(cueFoul) {
      const player = this.rule.currentPlayer, opponent = 1 - player;
      const first = this.world.getBall(this.shotRecord.firstContact);
      const foul = cueFoul || !first || first.number !== this.shotRecord.lowestAtStart;
      const ninePotted = this.shotRecord.potted.includes('9');
      if (ninePotted && !foul) {
        this.rule.scores[player] += 1; this.rule.winner = player; this.toast(`P${player + 1} 合法打进 9 号球，赢得本局`); return;
      }
      if (ninePotted && foul) this.world.respotBall('9', { x: 0.63, z: 0 });
      const legalPots = this.shotRecord.potted.filter((id) => id !== 'cue').length;
      this.rule.scores[player] += foul ? 0 : legalPots;
      if (foul) {
        this.world.respotCue(); this.rule.currentPlayer = opponent; this.toast(`犯规：应先接触 ${this.shotRecord.lowestAtStart} 号球`);
      } else if (!legalPots) this.rule.currentPlayer = opponent;
    }

    snookerColorOrder() { return ['yellow', 'green', 'brown', 'blue', 'pink', 'black']; }

    snookerSpot(id) {
      return {
        yellow: { x: -0.89, z: -0.292 }, green: { x: -0.89, z: 0.292 }, brown: { x: -0.89, z: 0 },
        blue: { x: 0, z: 0 }, pink: { x: 0.89, z: 0 }, black: { x: 1.43, z: 0 },
      }[id];
    }

    evaluateSnooker(cueFoul) {
      const player = this.rule.currentPlayer, opponent = 1 - player;
      const expected = this.shotRecord.expectedAtStart;
      const first = this.world.getBall(this.shotRecord.firstContact);
      const objectPots = this.shotRecord.potted.filter((id) => id !== 'cue').map((id) => this.world.getBall(id)).filter(Boolean);
      const redsBefore = this.undoStack.at(-1).world.balls.filter((b) => !b.pocketed && b.kind === 'snooker' && b.value === 1).length;
      const expectedRed = expected === 'red';
      const firstLegal = first && (expectedRed ? first.value === 1 : expected === 'color' ? first.value > 1 : first.id === expected);
      let foul = cueFoul || !firstLegal;
      let points = 0;

      if (expectedRed) {
        if (objectPots.some((b) => b.value !== 1)) foul = true;
        if (!foul) points = objectPots.filter((b) => b.value === 1).length;
        if (points) this.rule.snookerExpected = 'color';
      } else if (expected === 'color') {
        const colors = objectPots.filter((b) => b.value > 1);
        if (colors.length !== 1 || objectPots.length !== 1) foul = true;
        if (!foul) {
          points = colors[0].value;
          const redsAfter = this.world.balls.filter((b) => !b.pocketed && b.value === 1).length;
          if (redsAfter > 0) {
            this.world.respotBall(colors[0], this.snookerSpot(colors[0].id));
            this.rule.snookerExpected = 'red';
          } else {
            this.world.respotBall(colors[0], this.snookerSpot(colors[0].id));
            this.rule.snookerExpected = 'yellow';
          }
        }
      } else {
        const target = this.world.getBall(expected);
        if (objectPots.length !== 1 || objectPots[0]?.id !== expected) foul = true;
        if (!foul) {
          points = target?.value || 0;
          const order = this.snookerColorOrder();
          const next = order.indexOf(expected) + 1;
          if (next < order.length) this.rule.snookerExpected = order[next];
          else { this.rule.winner = this.rule.scores[player] + points >= this.rule.scores[opponent] ? player : opponent; }
        }
      }

      if (foul) {
        const penalty = Math.max(4, first?.value || 4, ...objectPots.map((b) => b.value || 0));
        this.rule.scores[opponent] += penalty;
        objectPots.filter((b) => b.value > 1).forEach((b) => this.world.respotBall(b, this.snookerSpot(b.id)));
        this.rule.currentPlayer = opponent;
        this.toast(`犯规，P${opponent + 1} 获得 ${penalty} 分`);
      } else if (points > 0) {
        this.rule.scores[player] += points;
        this.toast(`P${player + 1} 得 ${points} 分 · 下一目标：${this.snookerTargetLabel()}`);
      } else {
        this.rule.currentPlayer = opponent;
      }
      if (cueFoul) this.world.respotCue();
      if (redsBefore === 0 && expectedRed) this.rule.snookerExpected = 'yellow';
    }

    snookerTargetLabel() {
      const target = this.rule.snookerExpected;
      return target === 'red' ? '红球' : target === 'color' ? '任意彩球' : ({ yellow: '黄球', green: '绿球', brown: '棕球', blue: '蓝球', pink: '粉球', black: '黑球' }[target] || target);
    }

    railEffectLabel(event, compact = false) {
      if (!event) return '—';
      const english = { running: '顺塞', reverse: '反塞', side: '纯侧塞', neutral: '中杆' }[event.english] || '中杆';
      if (compact) {
        if (event.english === 'neutral' && event.followRatio > 0.24) return '顺旋吸库';
        if (event.english === 'neutral' && event.followRatio < -0.24) return '低杆吃库';
        return event.frictionMode === 'stick' && event.english !== 'neutral' ? `${english}·软` : english;
      }
      const parts = [english];
      if (event.frictionMode === 'stick' && event.english !== 'neutral') parts.push('软塞黏着区');
      else if (event.frictionMode === 'slide' && event.english !== 'neutral') parts.push('滑移区');
      if (event.followRatio > 0.24) parts.push('顺旋吸库');
      else if (event.followRatio < -0.24) parts.push('低杆吃库');
      return parts.join(' · ');
    }

    loadDrill(kind) {
      if (this.world.isMoving()) { this.toast('请等待球静止后再切换实验'); return; }
      if (this.world.mode !== 'chineseEight') this.world.setMode('chineseEight');
      else this.world.reset('chineseEight');
      this.world.setCueType($('#cueType').value);
      this.world.setTipType($('#tipType').value);
      this.world.setClothPreset($('#clothPreset').value);
      this.renderer.setTable(this.world.table);

      const place = (ball, position) => {
        ball.pos = { ...position }; ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 };
        ball.rotation = [0, 0, 0, 1]; ball.pocketed = false; ball.pocketId = null;
        ball.sinkTime = 0; ball.sinkDepth = 0; ball.sinkTarget = null; ball.lastSpeed = 0; ball.state = 'stationary';
      };
      this.world.balls.forEach((ball) => {
        ball.pocketed = true; ball.pocketId = 'drill'; ball.sinkTime = 1; ball.sinkDepth = ball.radius * 3.2; ball.sinkTarget = null;
        ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 }; ball.state = 'pocketed';
      });
      const cue = this.world.getCueBall();
      const R = cue.radius, H = this.world.table.height;
      const setups = {
        railFrozen: {
          cue: { x: 0.20, z: H / 2 - R - 0.00015 }, target: { x: 0.78, z: H / 2 - R - 0.00015 },
          aim: { x: 1, z: 0 }, spin: { x: 0, y: 0 }, power: 0.34, elevation: 1,
          hint: '母球与 1 号球都贴长库。观察目标球沿库到圆弧袋角时，是进袋、晃袋还是被圆角弹出。',
        },
        english: {
          cue: { x: -0.50, z: -0.27 }, aim: V2.normalize({ x: 0.50, z: 1 }),
          spin: { x: -0.55, y: 0 }, power: 0.48, elevation: 3,
          hint: '当前是左塞顺塞。击打一杆后撤销，只改成右塞再打；对照首库“入/出角”和让点读数。',
        },
        follow: {
          cue: { x: -0.55, z: 0 }, aim: { x: 1, z: 0 },
          spin: { x: 0, y: 0.72 }, power: 0.58, elevation: 2,
          hint: '高杆正撞短库。先打高杆，再撤销改定杆/低杆，比较库后速度、回旋残量与停止距离。',
        },
      };
      const setup = setups[kind] || setups.english;
      place(cue, setup.cue);
      if (setup.target) place(this.world.getBall('1'), setup.target);
      this.aimDirection = { ...setup.aim };
      this.tipX = setup.spin.x; this.tipY = setup.spin.y;
      this.power = setup.power; this.elevation = setup.elevation;
      this.activeDrill = kind;
      this.rule = this.createRuleState('chineseEight'); this.shotNumber = 1;
      this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
      this.shotRecord = this.emptyShotRecord(); this.prediction = null;
      $('#gameMode').value = 'chineseEight';
      $$('[data-drill]').forEach((button) => button.classList.toggle('active', button.dataset.drill === kind));
      $('#drillHint').textContent = setup.hint;
      this.updateAllUI(); this.schedulePrediction(true);
      this.toast(`已载入：${$(`[data-drill="${kind}"]`)?.textContent || '物理实验'}`);
    }

    changeMode(mode) {
      this.activeDrill = null;
      $$('[data-drill]').forEach((button) => button.classList.remove('active'));
      this.world.setMode(mode);
      this.renderer.setTable(this.world.table);
      this.rule = this.createRuleState(mode);
      this.shotNumber = 1; this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
      this.aimDirection = { x: 1, z: 0 };
      this.world.setClothPreset($('#clothPreset').value);
      this.schedulePrediction(true); this.updateAllUI();
      this.toast(`${$('#gameMode').selectedOptions[0].text} · 已完成摆球`);
    }

    resetRack() {
      const mode = this.world.mode;
      this.activeDrill = null;
      $$('[data-drill]').forEach((button) => button.classList.remove('active'));
      this.world.reset(mode);
      this.world.setClothPreset($('#clothPreset').value);
      this.renderer.setTable(this.world.table);
      this.rule = this.createRuleState(mode); this.shotNumber = 1;
      this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
      this.aimDirection = { x: 1, z: 0 }; this.paused = false;
      this.schedulePrediction(true); this.updateAllUI(); this.toast('已重新摆球');
    }

    undo() {
      if (this.world.isMoving()) { this.toast('请先暂停或等待球静止'); return; }
      const snapshot = this.undoStack.pop();
      if (!snapshot) { this.toast('暂无可撤销的击球'); return; }
      this.world.restore(snapshot.world); this.rule = snapshot.rule; this.shotNumber = snapshot.shotNumber; this.aimDirection = snapshot.aimDirection;
      this.actualTrails.clear(); this.effects.length = 0; this.schedulePrediction(true); this.updateAllUI(); this.toast('已撤销上一杆');
    }

    togglePause() {
      this.paused = !this.paused;
      $('#pauseButton').classList.toggle('paused', this.paused);
      $('#pauseButton span').textContent = this.paused ? '继续' : '暂停';
      this.toast(this.paused ? '模拟已暂停' : '继续模拟');
    }

    toggleGuides() {
      this.guidesEnabled = !this.guidesEnabled;
      $('#guideToggle').classList.toggle('active', this.guidesEnabled);
      if (this.guidesEnabled) this.schedulePrediction(true);
      else this.prediction = null;
    }

    openHelp() {
      const dialog = $('#helpDialog');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }

    schedulePrediction(immediate = false) {
      this.predictionDirty = true;
      clearTimeout(this.predictionTimer);
      if (!this.guidesEnabled || this.world.isMoving()) return;
      const delay = immediate ? 0 : Math.max(34, 70 - (performance.now() - this.lastPredictionAt));
      this.predictionTimer = setTimeout(() => this.updatePrediction(), delay);
    }

    updatePrediction() {
      if (!this.predictionDirty || !this.guidesEnabled || this.world.isMoving()) return;
      this.predictionDirty = false;
      this.lastPredictionAt = performance.now();
      this.prediction = this.world.predictShot(this.shotOptions());
      this.updatePredictionMetrics();
    }

    updatePredictionMetrics() {
      if (!this.prediction) return;
      const event = this.prediction.firstHit;
      if (event) {
        const id = event.aId === 'cue' ? event.bId : event.aId;
        const ball = this.world.getBall(id);
        $('#firstHitMetric').textContent = ball?.number != null ? `${ball.number} 号球` : ball?.label || id;
      } else $('#firstHitMetric').textContent = '库边';
      const contact = this.world.findAimContact(this.aimDirection);
      $('#cutAngleMetric').textContent = contact ? `${contact.cutAngle.toFixed(1)}°` : '—';
      $('#pathMetric').textContent = `${this.prediction.cueDistance.toFixed(2)} m`;
      this.predictedRailEvent = this.prediction.events.find((item) => item.type === 'cushion' && item.ballId === 'cue') || null;
      $('#railEffectMetric').textContent = this.railEffectLabel(this.predictedRailEvent, true);
      const impact = this.world.cueImpactMetrics(this.shotOptions());
      const allowance = impact.aimAllowancePerMetre * 1000;
      $('#allowanceMetric').textContent = allowance < 0.05 ? '0 mm/m' : `${impact.tipX > 0 ? '右' : '左'} ${allowance.toFixed(1)} mm/m`;
    }

    frame(time) {
      const rawDelta = Math.min(0.05, (time - this.lastFrameTime) / 1000 || 0);
      this.lastFrameTime = time;
      this.applyKeyControls(rawDelta);
      const timeScale = this.slowMotion ? 0.5 : 1;
      if (!this.paused) {
        this.accumulator += rawDelta * timeScale;
        const fixed = 1 / 300;
        let steps = 0;
        while (this.accumulator >= fixed && steps < 20) {
          this.world.step(fixed);
          this.accumulator -= fixed; steps += 1; this.trailFrame += 1;
          if (this.trailsEnabled && this.trailFrame % 5 === 0) this.captureTrails();
        }
      }
      if (this.pendingSettle) this.settleShot();

      const moving = this.world.isMoving();
      if (moving !== this.wasMoving) {
        this.wasMoving = moving;
        this.updateMotionUI(moving);
        if (!moving) this.schedulePrediction(true);
      }
      this.renderer.render(this.world, {
        showCue: !moving && !this.paused,
        aimDirection: this.aimDirection,
        elevation: this.elevation,
        pullback: this.pullback,
        tipX: this.tipX,
        tipY: this.tipY,
      });
      this.drawGuides(time);
      this.updateLiveTelemetry();
      this.updateFps(time);
      requestAnimationFrame((next) => this.frame(next));
    }

    captureTrails() {
      this.world.balls.forEach((ball) => {
        if (ball.pocketed || Math.hypot(ball.vel.x, ball.vel.z) < 0.008) return;
        if (!this.actualTrails.has(ball.id)) this.actualTrails.set(ball.id, []);
        const path = this.actualTrails.get(ball.id);
        path.push({ ...ball.pos });
        if (path.length > 420) path.shift();
      });
    }

    resizeGuideCanvas() {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const width = Math.max(1, Math.round(this.guideCanvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(this.guideCanvas.clientHeight * dpr));
      if (this.guideCanvas.width !== width || this.guideCanvas.height !== height) { this.guideCanvas.width = width; this.guideCanvas.height = height; }
      this.guideContext.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    drawGuides(time) {
      this.resizeGuideCanvas();
      const ctx = this.guideContext;
      const width = this.guideCanvas.clientWidth, height = this.guideCanvas.clientHeight;
      ctx.clearRect(0, 0, width, height);
      if (this.gridEnabled) this.drawTableGrid(ctx);
      if (this.trailsEnabled) this.drawActualTrails(ctx);
      if (this.guidesEnabled && !this.world.isMoving() && this.prediction) this.drawPrediction(ctx);
      this.drawEffects(ctx, time);
    }

    tableClip(ctx) {
      const t = this.world.table, y = 0.005;
      const points = [
        this.renderer.project({ x: -t.width / 2, y, z: -t.height / 2 }), this.renderer.project({ x: t.width / 2, y, z: -t.height / 2 }),
        this.renderer.project({ x: t.width / 2, y, z: t.height / 2 }), this.renderer.project({ x: -t.width / 2, y, z: t.height / 2 }),
      ];
      if (points.some((p) => !p)) return false;
      ctx.beginPath(); ctx.moveTo(points[0].x, points[0].y); points.slice(1).forEach((p) => ctx.lineTo(p.x, p.y)); ctx.closePath(); ctx.clip();
      return true;
    }

    drawTableGrid(ctx) {
      const t = this.world.table;
      ctx.save(); if (!this.tableClip(ctx)) { ctx.restore(); return; }
      // Solid hairlines remain readable in perspective without the moiré produced by tiny dashes.
      ctx.lineWidth = 0.55; ctx.strokeStyle = 'rgba(178, 233, 214, .075)'; ctx.setLineDash([]);
      for (let i = 1; i < 8; i += 1) {
        const x = -t.width / 2 + t.width * i / 8;
        this.screenLine(ctx, { x, z: -t.height / 2 }, { x, z: t.height / 2 });
      }
      for (let i = 1; i < 4; i += 1) {
        const z = -t.height / 2 + t.height * i / 4;
        this.screenLine(ctx, { x: -t.width / 2, z }, { x: t.width / 2, z });
      }
      ctx.fillStyle = 'rgba(203, 242, 228, .18)';
      for (let i = 1; i < 8; i += 1) {
        [-1, 1].forEach((side) => {
          const p = this.renderer.project({ x: -t.width / 2 + t.width * i / 8, y: 0.007, z: side * (t.height / 2 - 0.012) });
          if (p) { ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(Math.PI / 4); ctx.fillRect(-2, -2, 4, 4); ctx.restore(); }
        });
      }
      ctx.restore();
    }

    screenLine(ctx, a, b, y = 0.006) {
      const pa = this.renderer.project({ x: a.x, y, z: a.z }), pb = this.renderer.project({ x: b.x, y, z: b.z });
      if (!pa || !pb) return;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
    }

    drawActualTrails(ctx) {
      ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      for (const [id, path] of this.actualTrails) {
        if (path.length < 2) continue;
        ctx.strokeStyle = id === 'cue' ? 'rgba(97, 244, 199, .25)' : 'rgba(229, 189, 101, .18)';
        ctx.lineWidth = id === 'cue' ? 1.2 : 0.9; ctx.setLineDash([1, 4]);
        this.drawWorldPath(ctx, path);
      }
      ctx.restore();
    }

    drawPrediction(ctx) {
      if (this.assists.trajectory) {
        ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        const firstEvent = this.prediction.firstHit;
        const targetId = firstEvent ? (firstEvent.aId === 'cue' ? firstEvent.bId : firstEvent.aId) : null;
        for (const [id, path] of this.prediction.paths) {
          if (path.length < 2) continue;
          const isCue = id === 'cue', isTarget = id === targetId;
          if (!isCue && !isTarget) continue;
          ctx.strokeStyle = isCue ? 'rgba(92, 244, 199, .86)' : 'rgba(235, 192, 94, .86)';
          ctx.shadowColor = isCue ? 'rgba(50, 238, 183, .55)' : 'rgba(229, 189, 101, .42)';
          ctx.shadowBlur = 7; ctx.lineWidth = isCue ? 2.1 : 1.8; ctx.setLineDash(isCue ? [] : [7, 4]);
          this.drawWorldPath(ctx, path);
          ctx.shadowBlur = 0; this.drawPathDots(ctx, path, isCue ? '#74f4cd' : '#ecc96d');
        }
        ctx.restore();
      }

      this.drawAimAllowance(ctx);
      this.drawCushionImpactGuide(ctx);

      const contact = this.world.findAimContact(this.aimDirection);
      if (!contact) return;
      const cue = this.world.getCueBall();
      if (this.assists.ghost) {
        const centre = this.renderer.project({ x: contact.ghost.x, y: cue.radius, z: contact.ghost.z });
        const edge = this.renderer.project({ x: contact.ghost.x + cue.radius, y: cue.radius, z: contact.ghost.z });
        if (centre && edge) {
          const radius = Math.hypot(edge.x - centre.x, edge.y - centre.y);
          ctx.save(); ctx.strokeStyle = 'rgba(238, 255, 249, .88)'; ctx.lineWidth = 1.2; ctx.setLineDash([4, 4]);
          ctx.shadowColor = 'rgba(97,244,199,.45)'; ctx.shadowBlur = 5;
          ctx.beginPath(); ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2); ctx.stroke();
          ctx.restore();
        }
      }

      if (this.assists.tangent) this.drawTangentGuide(ctx, contact);
      if (this.assists.pocket) this.drawPocketCorridor(ctx, contact);
      const labelPoint = this.renderer.project({ x: contact.ghost.x, y: cue.radius * 2.2, z: contact.ghost.z });
      if (labelPoint) {
        ctx.save(); ctx.font = '600 9px ui-monospace, monospace';
        const label = `切球 ${contact.cutAngle.toFixed(1)}°`;
        const w = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(5,20,16,.82)'; ctx.fillRect(labelPoint.x - w / 2 - 5, labelPoint.y - 11, w + 10, 17);
        ctx.fillStyle = '#d9f8ed'; ctx.textAlign = 'center'; ctx.fillText(label, labelPoint.x, labelPoint.y); ctx.restore();
      }
    }

    drawAimAllowance(ctx) {
      if (Math.abs(this.tipX) < 0.025) return;
      const cue = this.world.getCueBall();
      if (!cue || cue.pocketed) return;
      const end = V2.add(cue.pos, V2.scale(this.aimDirection, 0.48));
      ctx.save();
      ctx.strokeStyle = 'rgba(225,238,233,.32)'; ctx.lineWidth = 0.9; ctx.setLineDash([3, 5]);
      this.screenLine(ctx, cue.pos, end, 0.014);
      const p = this.renderer.project({ x: end.x, y: 0.014, z: end.z });
      if (p) {
        ctx.fillStyle = 'rgba(220,235,229,.58)'; ctx.font = '7px ui-monospace, monospace';
        ctx.fillText('原瞄向', p.x + 4, p.y - 3);
      }
      ctx.restore();
    }

    drawCushionImpactGuide(ctx) {
      const event = this.predictedRailEvent;
      if (!event?.incoming || !event?.outgoing) return;
      const incoming = V2.normalize(event.incoming);
      const outgoing = V2.normalize(event.outgoing);
      const start = V2.sub(event.position, V2.scale(incoming, 0.19));
      const end = V2.add(event.position, V2.scale(outgoing, 0.19));
      const normalEnd = V2.add(event.position, V2.scale(event.normal, 0.14));
      ctx.save(); ctx.lineWidth = 1; ctx.setLineDash([3, 4]);
      ctx.strokeStyle = 'rgba(229,189,101,.60)'; this.screenLine(ctx, start, event.position, 0.016);
      ctx.strokeStyle = 'rgba(97,244,199,.74)'; this.screenLine(ctx, event.position, end, 0.016);
      ctx.strokeStyle = 'rgba(224,239,233,.32)'; this.screenLine(ctx, event.position, normalEnd, 0.016);
      const p = this.renderer.project({ x: event.position.x, y: 0.045, z: event.position.z });
      if (p) {
        const label = `${this.railEffectLabel(event, true)}  ${event.incidentAngle.toFixed(1)}°→${event.reboundAngle.toFixed(1)}°`;
        ctx.font = '600 8px ui-monospace, monospace';
        const width = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(5,20,16,.86)'; ctx.fillRect(p.x - width / 2 - 6, p.y - 17, width + 12, 16);
        ctx.fillStyle = '#e6f8f1'; ctx.textAlign = 'center'; ctx.fillText(label, p.x, p.y - 6);
      }
      ctx.restore();
    }

    drawWorldPath(ctx, path) {
      let started = false; ctx.beginPath();
      for (const point of path) {
        const screen = this.renderer.project({ x: point.x, y: 0.009, z: point.z });
        if (!screen) continue;
        if (!started) { ctx.moveTo(screen.x, screen.y); started = true; } else ctx.lineTo(screen.x, screen.y);
      }
      if (started) ctx.stroke();
    }

    drawPathDots(ctx, path, color) {
      ctx.fillStyle = color;
      for (let i = 18; i < path.length; i += 28) {
        const p = this.renderer.project({ x: path[i].x, y: 0.012, z: path[i].z });
        if (!p) continue;
        ctx.beginPath(); ctx.arc(p.x, p.y, 1.7, 0, Math.PI * 2); ctx.fill();
      }
    }

    drawTangentGuide(ctx, contact) {
      const tangent = V2.perp(contact.normal);
      const cuePath = this.prediction.paths.get('cue') || [];
      let sign = 1;
      if (cuePath.length > 4) {
        const last = cuePath[Math.min(cuePath.length - 1, 30)];
        const delta = V2.sub(last, contact.ghost);
        sign = V2.dot(delta, tangent) >= 0 ? 1 : -1;
      }
      const start = contact.ghost;
      const end = V2.add(start, V2.scale(tangent, 0.31 * sign));
      ctx.save(); ctx.strokeStyle = 'rgba(239, 249, 245, .54)'; ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
      this.screenLine(ctx, start, end, 0.012);
      const p = this.renderer.project({ x: end.x, y: 0.012, z: end.z });
      if (p) { ctx.fillStyle = 'rgba(235,247,243,.7)'; ctx.font = '8px sans-serif'; ctx.fillText('90° 分离线', p.x + 4, p.y - 2); }
      ctx.restore();
    }

    choosePocket(ball, outgoing) {
      let best = null;
      for (const pocket of this.world.table.pockets) {
        const vector = V2.sub(pocket, ball.pos), distance = V2.length(vector), direction = V2.normalize(vector);
        const angle = Math.acos(clamp(V2.dot(direction, outgoing), -1, 1));
        const obstruction = this.world.balls.some((other) => {
          if (other === ball || other.pocketed || other.id === 'cue') return false;
          const rel = V2.sub(other.pos, ball.pos); const along = V2.dot(rel, direction);
          if (along <= 0 || along >= distance) return false;
          const side = Math.abs(V2.cross(rel, direction));
          return side < ball.radius + other.radius + 0.004;
        });
        const score = angle * 2.2 + distance * 0.12 + (obstruction ? 4 : 0);
        if (!best || score < best.score) best = { pocket, direction, distance, angle, obstruction, score };
      }
      return best;
    }

    drawPocketCorridor(ctx, contact) {
      const choice = this.choosePocket(contact.ball, contact.normal);
      if (!choice || choice.angle > 72 * Math.PI / 180 || choice.obstruction) return;
      const perpendicular = V2.perp(choice.direction);
      const halfWidth = Math.max(0.008, this.world.table.pocketRadius - contact.ball.radius * 0.7);
      const startA = V2.add(contact.ball.pos, V2.scale(perpendicular, halfWidth));
      const startB = V2.add(contact.ball.pos, V2.scale(perpendicular, -halfWidth));
      const endA = V2.add(choice.pocket, V2.scale(perpendicular, halfWidth * 0.34));
      const endB = V2.add(choice.pocket, V2.scale(perpendicular, -halfWidth * 0.34));
      ctx.save(); ctx.strokeStyle = 'rgba(229,189,101,.30)'; ctx.lineWidth = 1; ctx.setLineDash([5, 6]);
      this.screenLine(ctx, startA, endA, 0.009); this.screenLine(ctx, startB, endB, 0.009);
      ctx.restore();
    }

    drawEffects(ctx, time) {
      this.effects = this.effects.filter((effect) => time - effect.born < effect.life);
      this.effects.forEach((effect) => {
        const age = (time - effect.born) / effect.life;
        const p = this.renderer.project({ x: effect.position.x, y: 0.025, z: effect.position.z });
        if (!p) return;
        const color = effect.type === 'pocket' ? '229,189,101' : effect.type === 'rail' ? '190,224,212' : '97,244,199';
        ctx.save(); ctx.strokeStyle = `rgba(${color},${(1 - age) * .7})`; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.arc(p.x, p.y, 3 + age * 15 * Math.min(effect.strength, 1.8), 0, Math.PI * 2); ctx.stroke();
        if (effect.type === 'ball') {
          for (let i = 0; i < 4; i += 1) {
            const a = i * Math.PI / 2 + age;
            ctx.beginPath(); ctx.moveTo(p.x + Math.cos(a) * 3, p.y + Math.sin(a) * 3); ctx.lineTo(p.x + Math.cos(a) * (4 + age * 10), p.y + Math.sin(a) * (4 + age * 10)); ctx.stroke();
          }
        }
        ctx.restore();
      });
    }

    updatePowerUI() {
      const value = Math.round(this.power * 100);
      $('#powerSlider').value = value; $('#powerValue').textContent = `${value}%`; $('#powerFill').style.width = `${value}%`;
      $('#dragPowerBar').style.width = `${value}%`; $('#dragPowerLabel').textContent = `${value}%`;
      this.updateSpinUI();
    }

    updateElevationUI() {
      $('#elevationSlider').value = this.elevation; $('#elevationValue').textContent = `${this.elevation}°`; $('#elevationFill').style.width = `${this.elevation / 35 * 100}%`;
      this.updateHud();
    }

    updateHud() {
      const marker = $('#hudMarker');
      if (!marker || !this.world) return;
      // Ball face: ±1 tip offset maps to the drawn ball radius.
      marker.style.left = `${50 + this.tipX * 50}%`;
      marker.style.top = `${50 - this.tipY * 50}%`;
      const impact = this.lastImpactMetrics || this.world.cueImpactMetrics(this.shotOptions());
      const safe = $('#hudSafe');
      safe.style.width = `${impact.safeOffset * 100}%`;
      safe.style.height = `${impact.safeOffset * 100}%`;
      marker.classList.toggle('warning', impact.miscueMargin < 0.035);
      $('#hudPowerBar').style.width = `${Math.round(this.power * 100)}%`;
      $('#hudPower').textContent = `${Math.round(this.power * 100)}%`;
      const describe = (value, negative, positive) => {
        const pct = Math.round(Math.abs(value) * 100);
        return pct < 2 ? null : `${value > 0 ? positive : negative} ${pct}%`;
      };
      const parts = [describe(this.tipX, '左', '右'), describe(this.tipY, '低', '高')].filter(Boolean);
      $('#hudTip').textContent = parts.length ? parts.join(' · ') : '中心';
      const trim = $('#hudTrim');
      trim.textContent = `${this.aimTrim > 0 ? '右 +' : this.aimTrim < 0 ? '左 −' : ''}${Math.abs(this.aimTrim).toFixed(2)}°`;
      trim.classList.toggle('hot', Math.abs(this.aimTrim) > 0.005);
      $('#hudSpeed').textContent = `${this.elevation}° · ${impact.horizontalSpeed.toFixed(1)} m/s`;
    }

    updateSpinUI() {
      const marker = $('#spinMarker');
      marker.style.left = `${50 + this.tipX * 39}%`; marker.style.top = `${50 - this.tipY * 39}%`;
      $('#spinXValue').textContent = `${this.tipX >= 0 ? '+' : ''}${Math.round(this.tipX * 100)}%`;
      $('#spinYValue').textContent = `${this.tipY >= 0 ? '+' : ''}${Math.round(this.tipY * 100)}%`;
      if (!this.world) return;
      const impact = this.world.cueImpactMetrics(this.shotOptions());
      this.lastImpactMetrics = impact;
      $('#spinRpmValue').textContent = `${Math.round(Math.abs(impact.omega.y) * 60 / (2 * Math.PI))} rpm`;
      const allowance = impact.aimAllowancePerMetre * 1000;
      $('#spinAllowanceValue').textContent = allowance < 0.05 ? '0 mm/m' : `${impact.tipX > 0 ? '向右' : '向左'} ${allowance.toFixed(1)} mm/m`;
      marker.classList.toggle('warning', impact.miscueMargin < 0.035);
      this.updateHud();
    }

    updateEquipmentHint() {
      const cue = this.world.getCueSpec(), tip = this.world.getTipSpec(), table = this.world.table;
      const cloth = $('#clothPreset')?.selectedOptions[0]?.text || '标准台呢';
      const endMass = (cue.effectiveEndMass * 1000).toFixed(1);
      $('#equipmentHint').textContent = `${table.name} · ${cloth}${table.clothNapStrength ? ' / 顺毛参与阻力' : ''} · ${cue.detail}（前端有效质量 ${endMass} g）/ ${tip.label}`;
    }

    updateMotionUI(moving) {
      $('#motionBadge').textContent = moving ? '运动中' : '静止'; $('#motionBadge').classList.toggle('moving', moving);
      $('#keyHud').classList.toggle('dimmed', moving);
      $('.stage-status').classList.toggle('busy', moving);
      $('#statusEyebrow').textContent = moving ? 'SIMULATING · 物理解算中' : 'READY · 准备击球';
      $('#statusText').textContent = moving ? '观察旋转、碰撞与走位' : this.activeDrill ? '实验球位已固定；打一杆后撤销可做对照' : '移动指针瞄准，向后拖动击球';
      $('#shootButton').disabled = moving;
    }

    updateLiveTelemetry() {
      const cue = this.world.getCueBall();
      const speed = cue && !cue.pocketed ? Math.hypot(cue.vel.x, cue.vel.z) : 0;
      const rpm = cue && !cue.pocketed ? Math.hypot(cue.omega.x, cue.omega.y, cue.omega.z) * 60 / (2 * Math.PI) : 0;
      $('#speedValue').textContent = speed.toFixed(2); $('#liveRpmValue').textContent = Math.round(rpm);
      const stateLabels = { stationary: '静止', sliding: '滑动', rolling: '纯滚动', spinning: '原地旋转', pocketed: '已落袋' };
      $('#motionStateValue').textContent = stateLabels[cue?.state] || '静止';
      if (cue && !cue.pocketed) {
        const slip = Math.hypot(cue.vel.x + cue.omega.z * cue.radius, cue.vel.z - cue.omega.x * cue.radius);
        $('#slipValue').textContent = slip > 0.012 ? `滑差 ${slip.toFixed(2)}` : '无滑动';
      } else $('#slipValue').textContent = '—';
      $('#energyValue').textContent = this.world.totalEnergy().toFixed(2);
      const progress = this.world.inShot ? clamp(this.world.shotTime / Math.max(0.2, this.predictedShotDuration), 0, 1) : 0;
      $('#timelineProgress').style.width = `${progress * 100}%`; $('#timelineKnob').style.left = `${progress * 100}%`;
    }

    updateScoreboard() {
      $('#scoreP1').textContent = this.rule.scores[0]; $('#scoreP2').textContent = this.rule.scores[1];
      $$('.scoreboard .player').forEach((element, index) => element.classList.toggle('active', index === this.rule.currentPlayer));
      $('#shotLabel').textContent = `第 ${this.shotNumber} 杆`;
      let hint = '瞄准线显示考虑当前杆法后的模拟轨迹';
      if ((this.world.mode === 'eight' || this.world.mode === 'chineseEight') && this.rule.groups[0]) hint = `P1 ${this.rule.groups[0] === 'solid' ? '全色' : '花色'} · P2 ${this.rule.groups[1] === 'solid' ? '全色' : '花色'}`;
      if (this.world.mode === 'nine') hint = `当前应先击打 ${this.lowestNineBall() ?? '—'} 号球`;
      if (this.world.mode === 'snooker') hint = `当前目标：${this.snookerTargetLabel()}`;
      $('#shotHint').textContent = hint;
    }

    updateAllUI() {
      this.updatePowerUI(); this.updateElevationUI(); this.updateSpinUI(); this.updateEquipmentHint(); this.updateScoreboard(); this.updateMotionUI(this.world.isMoving());
      $('#gameMode').value = this.world.mode;
      $('#cueType').value = this.world.cueType;
      $('#tipType').value = this.world.tipType;
    }

    updateFps(time) {
      this.frameCount += 1;
      if (time - this.fpsTime >= 1000) {
        const fps = Math.round(this.frameCount * 1000 / (time - this.fpsTime));
        $('#fpsCounter').textContent = `${fps} FPS`; this.frameCount = 0; this.fpsTime = time;
      }
    }

    toast(message) {
      const element = $('#toast'); element.textContent = message; element.classList.add('show');
      clearTimeout(this.toastTimer); this.toastTimer = setTimeout(() => element.classList.remove('show'), 2300);
    }
  }

  window.addEventListener('DOMContentLoaded', () => { window.cueLab = new CueLabApp(); });
})();
