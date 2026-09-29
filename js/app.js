(function () {
  'use strict';

  const { PhysicsWorld, POOL_COLORS, PALLADIUM_COLORS } = window.BilliardsPhysics;
  const { BilliardsRenderer } = window.BilliardsRenderer;
  const { V2, clamp, smoothstep } = window.BilliardsMath;
  const { createDrill } = window.BilliardsDrills;

  const BALL_SKINS = {
    tv: { label: 'TV 高清经典', colors: POOL_COLORS, cueColor: '#f0f3eb' },
    palladium: { label: 'Palladium 三叶徽章', colors: PALLADIUM_COLORS, cueColor: '#f2e9d2' },
  };

  // Hold-to-adjust keys are integrated per frame for smooth, fine control:
  // WASD moves the tip contact point, Q/E scales cue speed, Z/C trims the
  // horizontal aim angle for English compensation practice and X resets that
  // trim.  Rates are deliberately slow — squirt compensation lives in tenths
  // of a degree — and holding Shift boosts them 4× for coarse moves.
  const ADJUST_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'z', 'c']);
  const TIP_RATE = 0.32;      // tip offset (fraction of R) per second
  const POWER_RATE = 0.20;    // power fraction per second
  const TRIM_RATE = 0.55;     // aim trim degrees per second
  const SHIFT_BOOST = 4;
  const $ = (selector) => document.querySelector(selector);
  const $$ = (selector) => [...document.querySelectorAll(selector)];

  // Slow motion trades nothing away: the physics step is BASE_STEP scaled by
  // the playback rate, so every gear costs the same ~1000 steps per real
  // second while the temporal resolution grows as the playback slows — at
  // 1/100 the world integrates on a 10 µs grid and the cushion rubber can be
  // watched compressing frame by frame.
  const BASE_STEP = 1 / 1000;
  const SLOW_MOTION_RATES = [1, 1 / 4, 1 / 20, 1 / 50, 1 / 100];
  const SLOW_MOTION_LABELS = ['1×', '1/4', '1/20', '1/50', '1/100'];

  // Impact sounds are modal-synthesised: each hit excites a small bank of
  // exponentially decaying partials plus a short noise transient.  Phenolic
  // balls ring bright and fast (2–9 kHz, ~10–30 ms), harder hits excite the
  // upper partials more, rubber cushions thump low, and every voice is panned
  // by where on the table it happened.  A master compressor keeps the break
  // from clipping.
  class SoundEngine {
    constructor() { this.context = null; this.enabled = true; this.master = null; }
    ensure() {
      if (!this.enabled) return null;
      if (!this.context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return null;
        this.context = new AudioContext();
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -15;
        compressor.knee.value = 18;
        compressor.ratio.value = 7;
        compressor.attack.value = 0.001;
        compressor.release.value = 0.09;
        this.master = this.context.createGain();
        this.master.gain.value = 0.9;
        this.master.connect(compressor);
        compressor.connect(this.context.destination);
      }
      if (this.context.state === 'suspended') this.context.resume().catch(() => {});
      return this.context;
    }
    setEnabled(value) {
      this.enabled = value;
      if (value) this.ensure();
    }
    voice(pan) {
      const ctx = this.context;
      if (!ctx.createStereoPanner) return this.master;
      const panner = ctx.createStereoPanner();
      panner.pan.value = clamp(pan || 0, -0.85, 0.85);
      panner.connect(this.master);
      return panner;
    }
    tone(destination, frequency, amplitude, decay, delay = 0, frequencyEnd = null) {
      const ctx = this.context;
      const start = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(frequency * (1 + (Math.random() - 0.5) * 0.018), start);
      if (frequencyEnd) osc.frequency.exponentialRampToValueAtTime(frequencyEnd, start + decay * 4);
      gain.gain.setValueAtTime(amplitude, start);
      gain.gain.setTargetAtTime(0, start, decay);
      osc.connect(gain);
      gain.connect(destination);
      osc.start(start);
      osc.stop(start + decay * 9 + 0.03);
    }
    burst(destination, duration, amplitude, frequency, q, delay = 0) {
      const ctx = this.context;
      const start = ctx.currentTime + delay;
      const frames = Math.max(8, Math.floor(ctx.sampleRate * duration * 3));
      const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < frames; i += 1) channel[i] = Math.random() * 2 - 1;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = frequency;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(amplitude, start);
      gain.gain.setTargetAtTime(0, start, duration / 2);
      source.connect(filter);
      filter.connect(gain);
      gain.connect(destination);
      source.start(start);
      source.stop(start + duration * 3);
    }
    click(kind, intensity = 0.5, pan = 0) {
      const ctx = this.ensure();
      if (!ctx) return;
      const i = clamp(intensity, 0, 1);
      const out = this.voice(pan);
      if (kind === 'ball') {
        // Phenolic "clack": stiff, bright, very short; velocity tilts the
        // spectrum toward the upper partials.
        const amp = 0.045 + 0.24 * i;
        const bright = 0.35 + 0.65 * i;
        this.burst(out, 0.0035, amp * 0.75, 3800, 0.8);
        this.tone(out, 1180, amp * 0.30, 0.0065);
        this.tone(out, 2090, amp * 0.52, 0.0050);
        this.tone(out, 3170, amp * 0.42 * bright, 0.0040);
        this.tone(out, 4640, amp * 0.30 * bright, 0.0031);
        this.tone(out, 6300, amp * 0.20 * bright * bright, 0.0025);
        this.tone(out, 8600, amp * 0.12 * bright * bright, 0.0019);
      } else if (kind === 'rail') {
        // Rubber cushion: soft low thump with a hint of cloth hiss.
        const amp = 0.05 + 0.20 * i;
        this.burst(out, 0.008, amp * 0.30, 950, 1.1);
        this.tone(out, 118, amp * 0.85, 0.030);
        this.tone(out, 208, amp * 0.60, 0.021);
        this.tone(out, 385, amp * 0.34, 0.014);
        this.tone(out, 760, amp * 0.16, 0.008);
      } else if (kind === 'cue') {
        // Leather tip on the ball: a dry mid "tock".
        const amp = 0.05 + 0.20 * i;
        this.burst(out, 0.003, amp * 0.5, 2300, 1.2);
        this.tone(out, 640, amp * 0.28, 0.010);
        this.tone(out, 1320, amp * 0.45, 0.0065);
        this.tone(out, 2540, amp * 0.30, 0.0045);
        this.tone(out, 4150, amp * 0.14, 0.0032);
      } else if (kind === 'miscue') {
        // Tip skidding off the ball: scratchy, no clean ring.
        const amp = 0.10 + 0.14 * i;
        this.burst(out, 0.030, amp * 0.9, 1500, 0.5);
        this.burst(out, 0.055, amp * 0.5, 620, 0.7, 0.012);
        this.tone(out, 340, amp * 0.30, 0.030);
      } else if (kind === 'pocket') {
        // Drop into the liner: leather flump, falling pitch, then the ball
        // knocking about in the pocket.
        const amp = 0.09 + 0.24 * i;
        this.burst(out, 0.045, amp * 0.55, 330, 0.6);
        this.tone(out, 168, amp * 0.8, 0.05, 0, 76);
        this.tone(out, 1750, amp * 0.16, 0.004, 0.055);
        this.tone(out, 2300, amp * 0.10, 0.003, 0.118);
        this.burst(out, 0.02, amp * 0.2, 700, 0.9, 0.055);
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

      // Every rack gets a fresh seed for its small disorder, so breaks vary
      // like real racks do.  A shared replay link (?shoot=1) or an explicit
      // ?rack=<seed> pins the seed so the same link replays the same break.
      const startup = new URLSearchParams(window.location.search);
      const rackParam = Number.parseInt(startup.get('rack'), 10);
      this.fixedRackSeed = Number.isFinite(rackParam) ? rackParam : startup.get('shoot') === '1' ? 1 : null;
      this.world = new PhysicsWorld('chineseEight', { cueType: 'small', tipType: 'medium', rackSeed: this.nextRackSeed() });
      this.renderer.setTable(this.world.table);
      this.sound = new SoundEngine();
      this.aimDirection = { x: 1, z: 0 };
      this.tipX = 0;
      this.tipY = 0;
      this.power = 0.62;
      this.elevation = 3;
      this.keys = new Set();
      this.shiftHeld = false;
      this.aimTrim = 0;
      this.drag = null;
      this.viewDrag = null;
      this.lastRightUp = 0;
      this.placement = false;
      this.placementDrag = null;
      this.strokeCache = null;
      this.ballSkin = 'tv';
      this.pullback = 0;
      this.paused = false;
      this.slowMotionRate = 1;
      this.guidesEnabled = true;
      this.gridEnabled = false;
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
      this.defaultDrillHint = $('#drillHint').textContent;
      this.predictedRailEvent = null;
      this.pendingSettle = false;
      this.predictedShotDuration = 1;
      this.accumulator = 0;
      this.lastFrameTime = performance.now();
      this.frameCount = 0;
      this.fpsTime = performance.now();
      this.wasMoving = false;
      this.toastTimer = null;
      this.assists = { trajectory: true, ghost: true, tangent: false, pocket: false };
      this.focused = false;

      this.bindUI();
      this.restorePreferences();
      this.preferencesReady = true;
      this.world.onEvent((event) => this.handlePhysicsEvent(event));
      this.updateAllUI();
      this.applyStartupParams();
      // A seed from the link (?rack= or ?shoot=1) pins the rack(s) the link
      // itself sets up; racks the player asks for afterwards vary again.
      this.fixedRackSeed = null;
      this.updateToggleButtons();
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
        this.elevation = clamp(Math.round(elevation), 0, 60);
        this.updateElevationUI(); this.updateSpinUI();
      }
      const aim = num('aim');
      if (aim != null) {
        const radians = aim * Math.PI / 180;
        this.aimDirection = { x: Math.cos(radians), z: Math.sin(radians) };
      }
      const trim = num('trim');
      if (trim != null) this.rotateAim(trim);
      const yaw = num('yaw'), pitch = num('pitch');
      if (yaw != null || pitch != null) {
        this.renderer.orbit = {
          yaw: (yaw ?? 0) * Math.PI / 180,
          pitch: clamp((pitch ?? 40) * Math.PI / 180, 0.10, 1.50),
        };
      }
      // ?slow=<4|20|50|100> shares a slow-motion gear (denominator form).
      const slowDenominator = num('slow');
      if (slowDenominator != null) this.setSlowMotionRate(1 / slowDenominator, true);
      const skin = params.get('skin');
      if (skin) this.setBallSkin(skin, true);
      if (params.get('place') === '1') this.togglePlacement();
      if (params.get('shoot') === '1') {
        // Optional t=<seconds> fast-forwards the shot so a shared link (or a
        // headless screenshot) lands exactly mid-flight.  The replay is
        // silenced: its collision sounds would all queue on the suspended
        // AudioContext and fire as one burst at the user's first click.
        const fastForward = clamp(num('t') ?? 0, 0, 12);
        const soundWasEnabled = this.sound.enabled;
        this.sound.enabled = false;
        this.shoot();
        if (fastForward > 0 && this.world.inShot) {
          // Same 1 kHz step and trail cadence as the live loop, so a shared
          // link replays exactly what the interactive session would show.
          for (let i = 0; i < fastForward / BASE_STEP && this.world.isMoving(); i += 1) {
            this.world.step(BASE_STEP);
            this.trailFrame += 1;
            if (this.trailsEnabled && this.trailFrame % 17 === 0) this.captureTrails();
          }
        }
        this.sound.enabled = soundWasEnabled;
      }
    }

    emptyShotRecord() {
      return { firstContact: null, potted: [], offTable: [], railAfterContact: false, railBalls: [],
        lowestAtStart: null, expectedAtStart: null, cueRail: null, returnedCueRail: null };
    }

    nextRackSeed() {
      return this.fixedRackSeed ?? ((Math.random() * 4294967296) >>> 0 || 1);
    }

    createRuleState(mode) {
      const pool = mode === 'chineseEight' || mode === 'eight' || mode === 'nine';
      return {
        mode,
        currentPlayer: 0,
        scores: [0, 0],
        groups: [null, null],
        winner: null,
        snookerExpected: 'red',
        // The break is played with the cue ball in hand behind the head
        // string (CBSA §2.4: 开球线后).  After a foul the incoming player gets
        // ball in hand anywhere on the table (§22) — 'table'.
        breakShot: mode === 'chineseEight' || mode === 'eight',
        ballInHand: pool ? 'kitchen' : null,
        // An illegal break hands the opponent a decision (§5.2).
        pendingChoice: null,
        breakWarning: null,
      };
    }

    bindUI() {
      $$('[data-panel]').forEach((button) => {
        button.addEventListener('click', () => this.selectPanel(button));
        button.addEventListener('keydown', (event) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const tabs = $$('[data-panel]');
          const next = event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[tabs.length - 1] : tabs.find((tab) => tab !== button);
          this.selectPanel(next); next.focus();
        });
      });
      $('#focusToggle').addEventListener('click', () => this.toggleFocus());
      $('#panelHelp').addEventListener('click', () => this.openHelp());
      $('#tableTheme').addEventListener('change', (event) => {
        this.renderer.tableTheme = event.target.value;
        this.savePreferences();
      });
      $('#gameMode').addEventListener('change', (event) => this.changeMode(event.target.value));
      $('#resetButton').addEventListener('click', () => this.resetRack());
      $('#soundToggle').addEventListener('click', () => {
        this.sound.setEnabled(!this.sound.enabled);
        $('#soundToggle').classList.toggle('muted', !this.sound.enabled);
        $('#soundToggle').setAttribute('aria-pressed', String(this.sound.enabled));
        $('#soundSetting').checked = this.sound.enabled;
        this.savePreferences();
        this.toast(this.sound.enabled ? '碰撞声音已开启' : '声音已关闭');
      });
      $('#soundSetting').addEventListener('change', (event) => {
        this.sound.setEnabled(event.target.checked);
        $('#soundToggle').classList.toggle('muted', !this.sound.enabled);
        this.updateToggleButtons(); this.savePreferences();
      });

      $('#helpButton').addEventListener('click', () => this.openHelp());
      $('#closeHelp').addEventListener('click', () => this.closeHelp());
      $('#helpDialog').addEventListener('click', (event) => {
        if (event.target === $('#helpDialog')) this.closeHelp();
      });

      $('#shootButton').addEventListener('click', () => this.performPrimaryAction());
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
        this.updateToggleButtons(); this.savePreferences();
      });
      $('#trailToggle').addEventListener('click', () => {
        this.trailsEnabled = !this.trailsEnabled; $('#trailToggle').classList.toggle('active', this.trailsEnabled);
        if (!this.trailsEnabled) this.actualTrails.clear();
        this.updateToggleButtons(); this.savePreferences();
      });
      $('#cameraButton').addEventListener('click', () => {
        const mode = this.renderer.toggleCamera();
        $('#cameraButton').classList.toggle('active', mode === 'top');
        this.updateToggleButtons();
        this.schedulePrediction(true);
      });

      const assistMap = {
        assistTrajectory: 'trajectory', assistGhost: 'ghost', assistTangent: 'tangent', assistPocket: 'pocket',
      };
      // The button label always names the action it will take next (enable
      // whatever is off, otherwise disable everything), so it must follow every
      // path that changes an assist — including the individual switches.
      const updateAssistAllLabel = () => {
        const anyOff = Object.values(this.assists).some((value) => !value);
        $('#assistAll').textContent = anyOff ? '全部开启' : '全部关闭';
        this.savePreferences();
      };
      Object.entries(assistMap).forEach(([id, key]) => $(`#${id}`).addEventListener('change', (event) => {
        this.assists[key] = event.target.checked;
        updateAssistAllLabel();
      }));
      $('#assistAll').addEventListener('click', () => {
        const shouldEnable = Object.values(this.assists).some((value) => !value);
        Object.entries(assistMap).forEach(([id, key]) => { this.assists[key] = shouldEnable; $(`#${id}`).checked = shouldEnable; });
        updateAssistAllLabel();
      });
      updateAssistAllLabel();

      $('#undoButton').addEventListener('click', () => this.undo());
      $('#pauseButton').addEventListener('click', () => this.togglePause());
      $('#slowButton').addEventListener('click', () => this.cycleSlowMotion());

      this.glCanvas.addEventListener('pointerdown', (event) => this.pointerDown(event));
      this.glCanvas.addEventListener('pointermove', (event) => this.pointerMove(event));
      this.glCanvas.addEventListener('pointerup', (event) => this.pointerUp(event));
      this.glCanvas.addEventListener('pointercancel', (event) => this.pointerUp(event, true));
      this.glCanvas.addEventListener('contextmenu', (event) => event.preventDefault());
      this.glCanvas.addEventListener('wheel', (event) => {
        event.preventDefault();
        this.renderer.setZoom(event.deltaY > 0 ? 1.08 : 0.93);
      }, { passive: false });
      // A GPU reset fires webglcontextlost; without preventDefault the browser
      // never restores the context and the table freezes silently.  The
      // renderer owns no DOM listeners, so recovery is a fresh instance with
      // the camera state carried over.
      this.glCanvas.addEventListener('webglcontextlost', (event) => {
        event.preventDefault();
        // The forced pause is the handler's, not the user's: remember which,
        // so restore does not resume a shot the user had deliberately frozen.
        this.pausedBeforeContextLoss = this.paused;
        this.setPaused(true);
        this.toast('渲染上下文丢失，正在等待浏览器恢复…');
      });
      this.glCanvas.addEventListener('webglcontextrestored', () => {
        try {
          const old = this.renderer;
          this.renderer = new BilliardsRenderer(this.glCanvas);
          this.renderer.setTable(this.world.table);
          this.renderer.setBallStyle(this.ballSkin);
          this.renderer.tableTheme = old.tableTheme;
          this.renderer.cameraMode = old.cameraMode;
          this.renderer.zoom = old.zoom;
          this.renderer.orbit = old.orbit ? { ...old.orbit } : null;
          this.renderer.updateCamera();
          this.setPaused(this.pausedBeforeContextLoss === true);
          this.toast('渲染已恢复');
        } catch (error) {
          console.error(error);
          $('#webglError').hidden = false;
        }
      });

      $('#placementToggle').addEventListener('click', () => this.togglePlacement());
      $$('#ruleChoice [data-choice]').forEach((button) => button.addEventListener('click', () => this.applyRuleChoice(button.dataset.choice)));
      $('#trayClear').addEventListener('click', () => this.clearTableToTray());
      $('#ballSkin').addEventListener('change', (event) => this.setBallSkin(event.target.value));

      window.addEventListener('keydown', (event) => {
        // Preserve native Space activation for focused controls. On the
        // table, Space remains the primary action; sliders keep arrow keys.
        const active = document.activeElement;
        const typing = active && (active.tagName === 'TEXTAREA' || active.isContentEditable
          || (active.tagName === 'INPUT' && !/^(range|checkbox|radio|button)$/.test(active.type)));
        if (typing) return;
        if (event.code === 'Space' && active?.matches('button, input, select')) return;
        this.shiftHeld = event.shiftKey;
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        if ($('#helpDialog').open) return; // the dialog owns the keyboard (Esc closes it natively)
        const key = event.key.toLowerCase();
        const shortcut = event.code === 'Space' || event.key === 'Escape'
          || ADJUST_KEYS.has(key) || 'rgmxbf'.includes(key);
        if (shortcut && active && active !== document.body && typeof active.blur === 'function') active.blur();
        if (ADJUST_KEYS.has(key)) {
          this.keys.add(key);
          event.preventDefault();
          return;
        }
        if (event.repeat) return;
        if (event.code === 'Space') { event.preventDefault(); this.performPrimaryAction(); }
        else if (key === 'r') this.resetRack();
        else if (key === 'g') this.toggleGuides();
        else if (key === 'm') { $('#slowButton').click(); }
        else if (key === 'x') this.resetAimTrim();
        else if (key === 'b') this.togglePlacement();
        else if (key === 'f') this.toggleFocus();
        else if (event.key === 'Escape') this.togglePause();
      });
      window.addEventListener('keyup', (event) => {
        this.shiftHeld = event.shiftKey;
        this.keys.delete(event.key.toLowerCase());
      });
      window.addEventListener('blur', () => { this.keys.clear(); this.shiftHeld = false; });
      window.addEventListener('resize', () => this.schedulePrediction(true));
    }

    bindSpinControl() {
      const control = $('#spinControl');
      let activePointer = null;
      control.addEventListener('keydown', (event) => {
        const delta = event.shiftKey ? 0.08 : 0.02;
        const changes = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, delta], ArrowDown: [0, -delta] };
        if (event.key === 'Home') { event.preventDefault(); this.setSpin(0, 0); }
        else if (changes[event.key]) {
          event.preventDefault();
          this.setSpin(this.tipX + changes[event.key][0], this.tipY + changes[event.key][1]);
        }
      });
      const update = (event) => {
        const rect = control.getBoundingClientRect();
        let x = (event.clientX - (rect.left + rect.width / 2)) / (rect.width * 0.39);
        let y = ((rect.top + rect.height / 2) - event.clientY) / (rect.height * 0.39);
        const length = Math.hypot(x, y);
        if (length > 0.9) { x *= 0.9 / length; y *= 0.9 / length; }
        this.setSpin(x, y);
      };
      control.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return; // right-click must not re-aim the tip
        activePointer = event.pointerId; control.setPointerCapture(activePointer); update(event); this.sound.ensure();
      });
      control.addEventListener('contextmenu', (event) => event.preventDefault());
      control.addEventListener('pointermove', (event) => { if (event.pointerId === activePointer) update(event); });
      const release = (event) => { if (event.pointerId === activePointer) activePointer = null; };
      control.addEventListener('pointerup', release); control.addEventListener('pointercancel', release);
    }

    pointerDown(event) {
      if (event.button === 2) {
        if (this.drag || this.placementDrag || this.renderer.cameraMode !== 'perspective') return;
        this.viewDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: 0 };
        this.glCanvas.setPointerCapture(event.pointerId);
        this.stage.classList.add('orbiting');
        return;
      }
      // A second primary pointer (second finger) must not usurp a live charge
      // or placement drag — its release would fire a shot nobody meant.  On
      // touch it reads as a pinch or a resting palm, so abort the charge
      // outright rather than letting the first finger's release fire.
      if (event.button !== 0 || this.viewDrag || this.drag || this.placementDrag
        || this.world.isMoving() || this.paused) {
        if (this.drag && event.pointerType === 'touch' && event.pointerId !== this.drag.pointerId) {
          this.finishChargeDrag(true);
        }
        return;
      }
      this.sound.ensure();
      if (this.placement) { this.beginPlacementDrag(event); return; }
      if (this.rule.ballInHand && this.beginCueInHandDrag(event)) return;
      this.updateAimFromPointer(event);
      this.drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: 0 };
      this.glCanvas.setPointerCapture(event.pointerId);
      this.stage.classList.add('charging');
      this.positionPowerFloat(event);
    }

    pointerMove(event) {
      // Chorded mouse buttons share one pointer: releasing one button while
      // another stays held arrives as pointermove (pointerup only fires for
      // the last button up).  Each drag therefore also ends here the moment
      // its own button leaves the buttons bitmask — otherwise an orbit or a
      // charge would outlive its button and stick to the bare hover.
      if (this.viewDrag && event.pointerId === this.viewDrag.pointerId) {
        if ((event.buttons & 2) === 0) { this.endViewDrag(false); return; }
        const dx = event.clientX - this.viewDrag.x, dy = event.clientY - this.viewDrag.y;
        this.viewDrag.x = event.clientX; this.viewDrag.y = event.clientY;
        this.viewDrag.moved += Math.abs(dx) + Math.abs(dy);
        this.renderer.orbitBy(dx, dy);
        return;
      }
      if (this.placementDrag && event.pointerId === this.placementDrag.pointerId) {
        if ((event.buttons & 1) === 0) { this.endPlacementDrag(false); return; }
        this.movePlacementBall(event);
        return;
      }
      if (this.drag && event.pointerId === this.drag.pointerId) {
        if ((event.buttons & 1) === 0) { this.finishChargeDrag(false); return; }
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
      } else if (!this.drag && !this.viewDrag && !this.placementDrag
        && event.pointerType !== 'touch'
        && !this.world.isMoving() && !this.paused && !this.placement) {
        // Hover aiming belongs to a bare mouse/pen pointer only: while any
        // drag is live, moves from OTHER pointers must not re-aim the locked
        // charge — and on touch the only pointers that can ever reach this
        // branch are extra fingers (touch aiming happens inside the charge
        // drag itself), so touch never hover-aims at all.
        this.updateAimFromPointer(event);
      }
    }

    pointerUp(event, cancelled = false) {
      // pointerup means every button is up, so whichever drag is still alive
      // ends here regardless of which button happened to be released last.
      if (this.viewDrag && event.pointerId === this.viewDrag.pointerId) {
        this.endViewDrag(cancelled);
        return;
      }
      if (this.placementDrag && event.pointerId === this.placementDrag.pointerId) {
        this.endPlacementDrag(cancelled);
        return;
      }
      if (!this.drag || event.pointerId !== this.drag.pointerId) return;
      this.finishChargeDrag(cancelled);
    }

    endViewDrag(cancelled) {
      const now = performance.now();
      if (!cancelled && this.viewDrag.moved < 6 && now - this.lastRightUp < 380) {
        if (this.renderer.resetOrbit()) this.toast('视角已复位');
      }
      this.lastRightUp = now;
      this.viewDrag = null;
      this.stage.classList.remove('orbiting');
    }

    finishChargeDrag(cancelled) {
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
      const step = dt * (this.shiftHeld ? SHIFT_BOOST : 1);
      const dTipX = (has('d') ? 1 : 0) - (has('a') ? 1 : 0);
      const dTipY = (has('w') ? 1 : 0) - (has('s') ? 1 : 0);
      const dPower = (has('e') ? 1 : 0) - (has('q') ? 1 : 0);
      const dTrim = (has('c') ? 1 : 0) - (has('z') ? 1 : 0);
      if (dTipX || dTipY) this.setSpin(this.tipX + dTipX * TIP_RATE * step, this.tipY + dTipY * TIP_RATE * step);
      if (dPower) {
        this.power = clamp(this.power + dPower * POWER_RATE * step, 0.03, 1);
        this.updatePowerUI(); this.schedulePrediction();
      }
      if (dTrim) this.rotateAim(dTrim * TRIM_RATE * step);
    }

    resetAimTrim() {
      if (!this.aimTrim) { this.toast('当前没有让点微调'); return; }
      this.rotateAim(-this.aimTrim);
      this.aimTrim = 0;
      this.updateHud();
      this.toast('让点微调已复位');
    }

    togglePlacement() {
      if (!this.placement && this.world.isMoving()) { this.toast('请等球静止后再进入摆球模式'); return; }
      if (!this.placement && this.rule.pendingChoice) { this.toast('请先选择非法开球的处理方式'); return; }
      this.placement = !this.placement;
      this.placementDrag = null;
      this.stage.classList.remove('grabbing');
      $('#placementToggle').classList.toggle('active', this.placement);
      $('#ballTray').hidden = !this.placement;
      this.stage.classList.toggle('placing', this.placement);
      if (this.placement) {
        if (this.paused) this.setPaused(false); // dragging needs the live loop
        this.prediction = null;
        this.clearPredictionMetrics();
        this.undoStack.length = 0;
        this.actualTrails.clear();
        this.renderBallTray();
        $('#statusEyebrow').textContent = 'LAYOUT · 摆球模式';
        $('#statusText').textContent = '左键拖球摆位；拖入袋口收进托盘；点托盘放回';
        this.toast('摆球模式：自由拖动母球与彩球；再按 B 或按钮完成布局');
      } else {
        // The rearranged table is no longer the drill's fixed layout: keep the
        // drill marked active and every shot would still settle through the
        // drill branch, never scoring or passing the turn.
        this.clearDrillSelection();
        this.rule = this.createRuleState(this.world.mode);
        // A hand-made layout is practice, not a rack: no break is owed and
        // the cue ball stays exactly where it was placed.
        this.rule.breakShot = false; this.rule.ballInHand = null;
        this.shotRecord = this.emptyShotRecord();
        this.updateAllUI();
        this.schedulePrediction(true);
        this.toast('布局完成，规则状态已重置，开始练习');
      }
    }

    exitPlacementSilently() {
      if (!this.placement) return;
      this.placement = false;
      this.placementDrag = null;
      $('#placementToggle').classList.remove('active');
      $('#ballTray').hidden = true;
      this.stage.classList.remove('placing');
      this.stage.classList.remove('grabbing');
    }

    clearDrillSelection() {
      this.activeDrill = null;
      $$('[data-drill]').forEach((button) => { button.classList.remove('active'); button.setAttribute('aria-pressed', 'false'); });
      $('#drillHint').textContent = this.defaultDrillHint;
    }

    renderBallTray() {
      const tray = $('#trayChips');
      tray.innerHTML = '';
      const balls = this.world.balls.filter((ball) => ball.pocketed && ball.id !== 'cue');
      $('#trayEmpty').hidden = balls.length > 0;
      balls.forEach((ball) => {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = `tray-chip ${ball.kind}`;
        chip.style.setProperty('--chip', ball.color);
        chip.textContent = ball.number ?? '';
        chip.title = `放回 ${ball.label || ball.id}`;
        chip.addEventListener('click', () => this.spawnFromTray(ball.id));
        tray.appendChild(chip);
      });
    }

    sendToTray(ball) {
      ball.pocketed = true; ball.offTable = false; ball.pocketId = 'tray';
      ball.sinkTime = 1; ball.sinkDepth = ball.radius * 3.2; ball.sinkTarget = null;
      ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 };
      ball.state = 'pocketed';
      ball.pocketFall = null; ball.posY = 0; ball.velY = 0; ball.railContact = null; ball.railTravel = null;
    }

    spawnFromTray(id) {
      const ball = this.world.getBall(id);
      if (!ball || !ball.pocketed) return;
      ball.pocketed = false; ball.pocketId = null;
      ball.sinkTime = 0; ball.sinkDepth = 0; ball.sinkTarget = null;
      ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 };
      ball.state = 'stationary';
      if (!this.world.respotBall(ball, { x: 0, z: 0 })) {
        this.sendToTray(ball);
        this.toast('台面中心附近没有空位');
      }
      this.renderBallTray();
    }

    clearTableToTray() {
      this.world.balls.forEach((ball) => {
        if (ball.id !== 'cue' && !ball.pocketed) this.sendToTray(ball);
      });
      this.renderBallTray();
      this.toast('台面已清空，母球保留；点托盘中的球放回');
    }

    beginPlacementDrag(event) {
      const point = this.renderer.screenToTable(event.clientX, event.clientY, this.world.params.radius);
      if (!point) return;
      let pick = null;
      for (const ball of this.world.activeBalls()) {
        const distance = Math.hypot(ball.pos.x - point.x, ball.pos.z - point.z);
        if (distance < (pick?.distance ?? Infinity)) pick = { ball, distance };
      }
      if (!pick || pick.distance > pick.ball.radius * 2.4) return;
      this.placementDrag = { ball: pick.ball, pointerId: event.pointerId, overPocket: null };
      this.glCanvas.setPointerCapture(event.pointerId);
      this.stage.classList.add('grabbing');
    }

    // Ball in hand (自由球): pressing on the cue ball picks it up; pressing
    // anywhere else still aims and strokes as usual.
    beginCueInHandDrag(event) {
      const cue = this.world.getCueBall();
      if (!cue || cue.pocketed) return false;
      const point = this.renderer.screenToTable(event.clientX, event.clientY, cue.radius);
      const near = point && Math.hypot(point.x - cue.pos.x, point.z - cue.pos.z) <= cue.radius * 2.2;
      // On a phone the ball is only a few pixels across: also accept a
      // finger-sized screen distance, so a near miss picks the ball up
      // instead of turning into a stroke.
      const centre = this.renderer.project({ x: cue.pos.x, y: cue.radius, z: cue.pos.z });
      const rect = this.glCanvas.getBoundingClientRect();
      const slop = event.pointerType === 'touch' ? 28 : 12;
      const onScreen = centre && Math.hypot(event.clientX - rect.left - centre.x, event.clientY - rect.top - centre.y) <= slop;
      if (!near && !onScreen) return false;
      this.placementDrag = { ball: cue, pointerId: event.pointerId, overPocket: null, inHand: true };
      this.glCanvas.setPointerCapture(event.pointerId);
      this.stage.classList.add('grabbing');
      return true;
    }

    movePlacementBall(event) {
      const drag = this.placementDrag;
      // A held ball can never be dragged out of a live shot.
      if (this.world.isMoving()) { this.endPlacementDrag(true); return; }
      const ball = drag.ball;
      const point = this.renderer.screenToTable(event.clientX, event.clientY, ball.radius);
      if (!point) return;
      const t = this.world.table, R = ball.radius;
      drag.overPocket = ball.id !== 'cue'
        ? t.pockets.find((p) => Math.hypot(point.x - p.x, point.z - p.z) < 0.075) || null
        : null;
      // After a break foul the cue ball goes behind the head string only.
      const kitchen = drag.inHand && this.rule.ballInHand === 'kitchen';
      const x = clamp(point.x, -t.width / 2 + R, kitchen ? t.cueStart : t.width / 2 - R);
      const z = clamp(point.z, -t.height / 2 + R, t.height / 2 - R);
      const clear = this.world.balls.every((other) => other === ball || other.pocketed
        || Math.hypot(other.pos.x - x, other.pos.z - z) > R + other.radius + 0.0004);
      if (clear) { ball.pos.x = x; ball.pos.z = z; }
      ball.vel.x = 0; ball.vel.z = 0;
      ball.omega = { x: 0, y: 0, z: 0 };
      ball.state = 'stationary';
      if (drag.inHand) this.schedulePrediction();
    }

    endPlacementDrag(cancelled) {
      const drag = this.placementDrag;
      this.placementDrag = null;
      this.stage.classList.remove('grabbing');
      if (!drag || cancelled) return;
      if (drag.inHand) { this.schedulePrediction(true); return; }
      if (drag.overPocket && drag.ball.id !== 'cue') {
        this.sendToTray(drag.ball);
        this.renderBallTray();
        this.toast(`${drag.ball.label || drag.ball.id} 已收进托盘`);
      }
    }

    // Up to ~80 % the slider keeps its established feel; the last fifth is
    // the break zone.  A real power break sends the cue ball at 8–11 m/s,
    // while the old curve topped out near 6 m/s and could not open a rack.
    speedFromPower() {
      const breakZone = smoothstep(0.8, 1, this.power);
      return 0.18 + 6.15 * Math.pow(this.power, 1.34) + 3.15 * breakZone * breakZone;
    }

    // The stick is a solid tapered rod: it has to pass over the cushion, the
    // rail cap and any ball lying behind the cue ball.  Find the lowest
    // elevation (at least the player's own, and at most 45° — a raised
    // bridge on the rail) at which the whole stick clears.  A ball frozen to
    // or tucked under the cushion cannot be struck low at all, because the
    // tip would have to pass through the rubber; the contact is then lifted
    // to the lowest point the stick can actually reach.  Draw, predict and
    // strike all share this geometry, so the rendered cue never dives through
    // the rail and the picture matches the physics.
    strokeGeometry() {
      const cue = this.world.getCueBall();
      const base = { elevation: clamp(this.elevation, 0, 60), tipX: this.tipX, tipY: this.tipY,
        raised: false, liftedTip: false, blocked: false };
      if (!cue || cue.pocketed) return base;
      const key = [cue.pos.x, cue.pos.z, this.aimDirection.x, this.aimDirection.z, this.elevation, this.tipX, this.tipY,
        this.world.cueType, this.world.mode, ...this.world.balls.flatMap((b) => (b.pocketed ? [] : [b.pos.x, b.pos.z]))].join('|');
      if (this.strokeCache?.key === key) return this.strokeCache.value;
      const value = this.solveStroke(cue, base);
      this.strokeCache = { key, value };
      return value;
    }

    solveStroke(cue, base) {
      const ceiling = Math.max(45, base.elevation);
      const lowestClear = (tipY) => {
        if (this.cueClears(cue, base.elevation, base.tipX, tipY)) return base.elevation;
        let clearAt = null;
        for (let e = Math.floor(base.elevation * 2 + 1) / 2; e <= ceiling + 1e-9; e += 0.5) {
          if (this.cueClears(cue, e, base.tipX, tipY)) { clearAt = e; break; }
        }
        if (clearAt == null) return null;
        let low = Math.max(base.elevation, clearAt - 0.5), high = clearAt;
        for (let i = 0; i < 6; i += 1) {
          const mid = (low + high) / 2;
          if (this.cueClears(cue, mid, base.tipX, tipY)) high = mid; else low = mid;
        }
        return high;
      };
      const elevation = lowestClear(base.tipY);
      if (elevation != null) return { ...base, elevation, raised: elevation > base.elevation + 1e-6 };
      for (let tipY = base.tipY + 0.02; tipY <= 0.9 + 1e-9; tipY += 0.02) {
        const lifted = lowestClear(tipY);
        if (lifted != null) return { ...base, tipY, elevation: lifted, raised: lifted > base.elevation + 1e-6, liftedTip: true };
      }
      return { ...base, elevation: ceiling, raised: ceiling > base.elevation, blocked: true };
    }

    // Whether the stick, drawn exactly as the renderer draws it, stays clear
    // of the cushion/rail profile and of every other ball.
    cueClears(cue, elevationDegrees, tipX, tipY) {
      const t = this.world.table, R = cue.radius, d = this.aimDirection;
      const tipR = this.world.getCueSpec().tipDiameter / 2;
      const el = elevationDegrees * Math.PI / 180, c = Math.cos(el), s = Math.sin(el);
      const reach = 0.82 * R, offset = Math.hypot(tipX, tipY) * 0.82;
      const depth = R * Math.sqrt(Math.max(0.2, 1 - offset * offset));
      const px = cue.pos.x - d.z * tipX * reach + d.x * s * tipY * reach - d.x * c * depth;
      const pz = cue.pos.z + d.x * tipX * reach + d.z * s * tipY * reach - d.z * c * depth;
      const py = R + c * tipY * reach + s * depth;
      // Stick radius from the tip back: tip, ferrule, tapered shaft, butt.
      const radius = (u) => (u < 0.0125 ? tipR : u < 0.0325 ? tipR * 1.02
        : u < 0.7325 ? tipR * (1.05 + (u - 0.0325) / 0.7 * 0.9975)
          : tipR * (2.0475 + Math.min(1, (u - 0.7435) / 0.6) * 0.86));
      const margin = 0.0005, length = 1.35;
      const nose = t.cushionContactHeight || 0.037, top = t.cushionTopHeight || 0.042, railTop = top + 0.017;
      const chinese = t.style === 'chinese';
      const ramp = chinese ? 0.0035 : 0.006;
      const obstacle = (beyond) => {
        if (beyond < 0) return 0;
        if (beyond < ramp) return nose + (top - nose) * beyond / ramp;
        if (beyond < 0.056) return chinese ? top + 0.014 * (beyond - 0.0035) / (0.058 - 0.0035) : top;
        return railTop;
      };
      for (let u = 0.005; u <= length; u += 0.003) {
        const x = px - d.x * c * u, z = pz - d.z * c * u, y = py + s * u;
        const beyond = Math.max(Math.abs(x) - t.width / 2, Math.abs(z) - t.height / 2);
        if (beyond > t.railWidth) break;
        if (y - radius(u) / c < obstacle(beyond) + margin) return false;
      }
      // Other balls: shortest distance from each centre to the stick's axis.
      const ax = -d.x * c, ay = s, az = -d.z * c;
      for (const ball of this.world.balls) {
        if (ball === cue || ball.pocketed) continue;
        const bx = ball.pos.x - px, by = ball.radius + (ball.posY || 0) - py, bz = ball.pos.z - pz;
        const u = clamp(bx * ax + by * ay + bz * az, 0.005, length);
        const gap = Math.hypot(bx - ax * u, by - ay * u, bz - az * u);
        if (gap < ball.radius + radius(u) + margin) return false;
      }
      return true;
    }

    effectiveElevation() {
      return this.strokeGeometry().elevation;
    }

    shotOptions() {
      const stroke = this.strokeGeometry();
      return {
        direction: { ...this.aimDirection }, speed: this.speedFromPower(),
        tipX: stroke.tipX, tipY: stroke.tipY, elevation: stroke.elevation,
        cueType: this.world.cueType, tipType: this.world.tipType,
      };
    }

    shoot() {
      if (!this.renderer || this.paused || this.world.isMoving()) return;
      if (this.placement) { this.toast('摆球模式中；按 B 或按钮完成布局后再击球'); return; }
      if (this.placementDrag) { this.toast('先松开母球完成摆放，再击球'); return; }
      if (this.rule.winner != null) { this.toast(`本局已结束，P${this.rule.winner + 1} 获胜；重新摆球可开始下一局`); return; }
      if (this.rule.pendingChoice) { this.toast('请先选择非法开球的处理方式'); return; }
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
        this.rule.ballInHand = null;
        $('#statusText').textContent = '观察旋转、碰撞与走位';
      }
    }

    handlePhysicsEvent(event) {
      const pan = event.position ? clamp(event.position.x / (this.world.table.width / 2), -1, 1) * 0.7 : 0;
      if (event.type === 'cue') {
        if (event.miscue) {
          this.sound.click('miscue', clamp(event.speed / 4, 0.3, 1), pan);
          this.toast('疵杆！击点超出皮头摩擦极限，动量与旋转大量损失');
        } else {
          this.sound.click('cue', clamp(event.speed / 6, 0.15, 1), pan);
        }
        this.addEffect(event.position, 'cue', event.speed);
      } else if (event.type === 'ball-ball') {
        this.sound.click('ball', clamp(event.speed / 4, 0.1, 1), pan);
        this.addEffect(event.position, 'ball', event.speed);
        if (!this.shotRecord.firstContact && (event.aId === 'cue' || event.bId === 'cue')) {
          this.shotRecord.firstContact = event.aId === 'cue' ? event.bId : event.aId;
        }
      } else if (event.type === 'cushion') {
        this.sound.click('rail', clamp(event.speed / 4, 0.08, 0.85), pan);
        this.addEffect(event.position, 'rail', event.speed);
        // CBSA §9.2 counts cushion contacts made after the cue ball has
        // touched an object ball; §5.1 counts object balls reaching a cushion.
        // A ball frozen to that cushion only counts once it has left it and
        // come back (CBSA §13.2, WPA §2.7).
        if (!event.frozen) {
          if (this.shotRecord.firstContact) this.shotRecord.railAfterContact = true;
          if (event.ballId !== 'cue' && !this.shotRecord.railBalls.includes(event.ballId)) this.shotRecord.railBalls.push(event.ballId);
        }
        if (event.ballId === 'cue') {
          // Keep the FIRST cue-ball rail: that is what the prediction's
          // “首库效应” reads and what the English drills compare.
          if (!this.shotRecord.cueRail) this.shotRecord.cueRail = event;
          if (event.returned) this.shotRecord.returnedCueRail = event;
          $('#statusText').textContent = `${this.railEffectLabel(event)} · 入 ${event.incidentAngle.toFixed(1)}° → 出 ${event.reboundAngle.toFixed(1)}° · 胶边压缩 ${(event.compression * 1000).toFixed(1)} mm`;
        }
      } else if (event.type === 'pocket') {
        this.sound.click('pocket', clamp(event.speed / 3, 0.2, 1), pan);
        this.addEffect(event.position, 'pocket', event.speed);
        this.shotRecord.potted.push(event.ballId);
      } else if (event.type === 'offTable') {
        // A ball that leaves the table has necessarily crossed a cushion.
        this.sound.click('rail', 0.5, pan);
        this.shotRecord.offTable.push(event.ballId);
        if (this.shotRecord.firstContact) this.shotRecord.railAfterContact = true;
        const ball = this.world.getBall(event.ballId);
        this.toast(`${event.ballId === 'cue' ? '母球' : ball?.number != null ? `${ball.number} 号球` : ball?.label || event.ballId}飞出台面`);
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
      const cueFoul = this.shotRecord.potted.includes('cue') || this.shotRecord.offTable.includes('cue');
      if (this.activeDrill) {
        if (cueFoul) this.world.respotCue();
        const returned = this.shotRecord.returnedCueRail, rail = returned || this.shotRecord.cueRail;
        this.toast(rail
          ? `${returned ? '' : '首库 · '}${this.railEffectLabel(rail)}：入射 ${rail.incidentAngle.toFixed(1)}°，反弹 ${rail.reboundAngle.toFixed(1)}°，胶边压缩 ${(rail.compression * 1000).toFixed(1)} mm`
          : '实验完成；点击同一场景可复位后做对照');
        return;
      }
      if (mode === 'practice') {
        const objectPots = this.shotRecord.potted.filter((id) => id !== 'cue').length;
        this.rule.scores[0] += objectPots;
        if (cueFoul) { this.world.respotCue(); this.toast(this.shotRecord.offTable.includes('cue') ? '母球飞出台面，已自动复位' : '母球落袋，已自动复位'); }
        else if (objectPots) this.toast(`进球 ${objectPots} 颗 · 可以继续练习`);
        return;
      }
      if (mode === 'eight' || mode === 'chineseEight') this.evaluateEightBall(cueFoul);
      else if (mode === 'nine') this.evaluateNineBall(cueFoul);
      else this.evaluateSnooker(cueFoul);
    }

    // Chinese eight-ball follows the CBSA 《中式台球竞赛总则》(2017); the
    // American game shares the same skeleton and differs where WPA does
    // (group choice on an open table).
    evaluateEightBall(cueFoul) {
      const chinese = this.world.mode === 'chineseEight';
      const record = this.shotRecord;
      const player = this.rule.currentPlayer, opponent = 1 - player;
      const breakShot = Boolean(this.rule.breakShot);
      this.rule.breakShot = false;
      const first = this.world.getBall(record.firstContact);
      const group = this.rule.groups[player];
      // The 8 is racked with kind 'solid' for rendering; it must never count
      // as one of the solids player's own balls, or that player could neither
      // clear their group nor be fouled for striking the 8 early.
      const before = this.undoStack.at(-1)?.world.balls || this.world.balls;
      const ownRemainingBefore = group ? before.filter((b) => !b.pocketed && b.kind === group && b.number !== 8).length : null;
      const expectedEight = Boolean(group) && ownRemainingBefore === 0;
      const objectPots = record.potted.filter((id) => id !== 'cue').map((id) => this.world.getBall(id)).filter(Boolean);
      const objectsOff = record.offTable.filter((id) => id !== 'cue');
      const eightDown = record.potted.includes('8'), eightOff = record.offTable.includes('8');
      const reasons = [];
      if (record.potted.includes('cue')) reasons.push('母球落袋');
      if (record.offTable.includes('cue')) reasons.push('母球飞出台面');
      if (!first) reasons.push('母球未碰到目标球');
      if (objectsOff.length) reasons.push('目标球飞出台面');
      if (first && !breakShot) {
        if (group && expectedEight && first.number !== 8) reasons.push('应先碰 8 号球');
        else if (group && !expectedEight && (first.number === 8 || first.kind !== group)) reasons.push(first.number === 8 ? '提前先碰 8 号球' : '先碰了对方球组');
        else if (!group && first.number === 8) reasons.push('开放球局先碰 8 号球');
        // §9.2: with nothing potted, some ball (the cue ball included) must
        // reach a cushion after the first contact.
        if (!objectPots.length && !record.railAfterContact) reasons.push('击球后没有球碰库');
      }
      const foul = reasons.length > 0;

      if (breakShot) {
        // §5.4: an 8 potted (or jumped) on the break is spotted, never a loss.
        if (eightDown || eightOff) this.world.respotBall('8', { x: this.world.table.rackApex, z: 0 });
        const spotted = eightDown || eightOff ? '，8 号球已放回置球点' : '';
        if (foul) {
          // §5.3/§5.5: a break foul gives the opponent the cue ball in hand
          // behind the head string.
          this.world.respotCue();
          this.rule.currentPlayer = opponent;
          this.rule.ballInHand = 'kitchen';
          this.toast(`开球犯规（${reasons.join('、')}），P${opponent + 1} 开球线后自由球${spotted}`);
          return;
        }
        if (!objectPots.length && record.railBalls.length < 4) {
          if (this.rule.breakWarning === player) {
            this.rule.winner = opponent;
            this.toast(`P${player + 1} 再次开球不合法，判负本局`);
            return;
          }
          this.rule.pendingChoice = { kind: 'illegalBreak', chooser: opponent, breaker: player };
          this.toast(`非法开球：只有 ${record.railBalls.length} 颗目标球碰库，请 P${opponent + 1} 选择处理方式`);
          return;
        }
        this.rule.breakWarning = null;
        if (objectPots.length) this.toast(`开球进球，P${player + 1} 继续击球 · 球局仍开放${spotted}`);
        else { this.rule.currentPlayer = opponent; this.toast(`合法开球，${record.railBalls.length} 颗目标球碰库 · 轮到 P${opponent + 1}`); }
        return;
      }

      if (eightDown || eightOff) {
        const legalWin = eightDown && !foul && expectedEight;
        this.rule.winner = legalWin ? player : opponent;
        this.toast(legalWin ? `漂亮！P${player + 1} 合法打进 8 号球` : eightOff ? `8 号球飞出台面，P${opponent + 1} 获胜`
          : `8 号球提前或犯规落袋，P${opponent + 1} 获胜`);
        return;
      }
      const groupPots = objectPots.filter((ball) => ball.number !== 8);
      if (!this.rule.groups[0] && !foul) {
        // CBSA §7.2/§7.5: the table stays open until a player pots a ball of
        // the group he struck first.  WPA lets any legally potted ball decide.
        const assigned = chinese
          ? (groupPots.some((ball) => ball.kind === first.kind) ? first : null)
          : groupPots.find((ball) => ball.kind === 'solid' || ball.kind === 'stripe');
        if (assigned) {
          this.rule.groups[player] = assigned.kind;
          this.rule.groups[opponent] = assigned.kind === 'solid' ? 'stripe' : 'solid';
          this.toast(`P${player + 1} 分组：${assigned.kind === 'solid' ? '全色球' : '花色球'}`);
        }
      }
      const ownGroup = this.rule.groups[player];
      const legalPots = ownGroup ? groupPots.filter((ball) => ball.kind === ownGroup).length
        : chinese ? 0 : groupPots.length;
      this.rule.scores[player] += legalPots;
      if (foul) {
        // §22: ball in hand anywhere.  An unpocketed cue ball stays where it
        // stopped; the incoming player may pick it up and place it.
        if (record.potted.includes('cue') || record.offTable.includes('cue')) this.world.respotCue();
        this.rule.currentPlayer = opponent;
        this.rule.ballInHand = 'table';
        this.toast(`P${player + 1} 犯规（${reasons.join('、')}），P${opponent + 1} 获得自由球`);
      } else if (!legalPots) {
        this.rule.currentPlayer = opponent;
        if (!ownGroup && groupPots.length && chinese) this.toast('先碰的球组没有进球，球局仍开放，交换球权');
      }
    }

    lowestNineBall() {
      const balls = this.world.balls.filter((b) => !b.pocketed && Number.isInteger(b.number) && b.number <= 9);
      return balls.length ? Math.min(...balls.map((b) => b.number)) : null;
    }

    evaluateNineBall(cueFoul) {
      const player = this.rule.currentPlayer, opponent = 1 - player;
      const first = this.world.getBall(this.shotRecord.firstContact);
      const objectsOff = this.shotRecord.offTable.filter((id) => id !== 'cue');
      const foul = cueFoul || !first || first.number !== this.shotRecord.lowestAtStart || objectsOff.length > 0;
      const ninePotted = this.shotRecord.potted.includes('9');
      if (ninePotted && !foul) {
        this.rule.scores[player] += 1; this.rule.winner = player; this.toast(`P${player + 1} 合法打进 9 号球，赢得本局`); return;
      }
      // A 9 pocketed on a foul or jumped off the table is spotted.
      if ((ninePotted && foul) || objectsOff.includes('9')) this.world.respotBall('9', { x: this.world.table.rackApex, z: 0 });
      const legalPots = this.shotRecord.potted.filter((id) => id !== 'cue').length;
      this.rule.scores[player] += foul ? 0 : legalPots;
      if (foul) {
        // Ball in hand anywhere; a cue ball still on the cloth stays put.
        if (cueFoul) this.world.respotCue();
        this.rule.currentPlayer = opponent;
        this.rule.ballInHand = 'table';
        const wrongFirst = first && first.number !== this.shotRecord.lowestAtStart;
        const reason = wrongFirst ? `应先碰 ${this.shotRecord.lowestAtStart} 号球`
          : this.shotRecord.offTable.includes('cue') ? '母球飞出台面' : cueFoul ? '母球落袋'
            : objectsOff.length ? '目标球飞出台面' : '母球未碰到目标球';
        this.toast(`犯规：${reason}，P${opponent + 1} 获得自由球`);
      } else if (!legalPots) this.rule.currentPlayer = opponent;
    }

    snookerColorOrder() { return ['yellow', 'green', 'brown', 'blue', 'pink', 'black']; }

    snookerSpot(id) {
      return BilliardsPhysics.snookerSpots(this.world.table)[id];
    }

    evaluateSnooker(cueFoul) {
      const player = this.rule.currentPlayer, opponent = 1 - player;
      const expected = this.shotRecord.expectedAtStart;
      const first = this.world.getBall(this.shotRecord.firstContact);
      const objectPots = this.shotRecord.potted.filter((id) => id !== 'cue').map((id) => this.world.getBall(id)).filter(Boolean);
      const redsBefore = this.undoStack.at(-1).world.balls.filter((b) => !b.pocketed && b.kind === 'snooker' && b.value === 1).length;
      const expectedRed = expected === 'red';
      const firstLegal = first && (expectedRed ? first.value === 1 : expected === 'color' ? first.value > 1 : first.id === expected);
      // A ball forced off the table is a foul; colours come back to their spots.
      const objectsOff = this.shotRecord.offTable.filter((id) => id !== 'cue').map((id) => this.world.getBall(id)).filter(Boolean);
      let foul = cueFoul || !firstLegal || objectsOff.length > 0;
      let points = 0;

      if (expectedRed) {
        if (objectPots.some((b) => b.value !== 1)) foul = true;
        if (!foul) points = objectPots.filter((b) => b.value === 1).length;
        if (points) this.rule.snookerExpected = 'color';
      } else if (expected === 'color') {
        const colors = objectPots.filter((b) => b.value > 1);
        // Potting nothing with a legal first contact is a plain miss, not a
        // foul; potting a red or more than one ball while on a colour is.
        if (colors.length > 1 || colors.length !== objectPots.length) foul = true;
        if (!foul && colors.length === 1) {
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
        // A miss on the ball-on passes the turn; only potting the wrong ball
        // (or extra balls) is a foul.
        if (objectPots.length > 1 || (objectPots.length === 1 && objectPots[0].id !== expected)) foul = true;
        if (!foul && objectPots.length === 1) {
          points = target?.value || 0;
          const order = this.snookerColorOrder();
          const next = order.indexOf(expected) + 1;
          if (next < order.length) this.rule.snookerExpected = order[next];
          else { this.rule.winner = this.rule.scores[player] + points >= this.rule.scores[opponent] ? player : opponent; }
        }
      }

      if (foul) {
        // Official penalty: at least 4, raised to the value of the ball on,
        // the ball first struck, or any ball wrongly potted.
        const onValue = expectedRed ? 1 : expected === 'color' ? 0 : (this.world.getBall(expected)?.value || 0);
        const penalty = Math.max(4, onValue, first?.value || 0, ...[...objectPots, ...objectsOff].map((b) => b.value || 0));
        this.rule.scores[opponent] += penalty;
        [...objectPots, ...objectsOff].filter((b) => b.value > 1).forEach((b) => this.world.respotBall(b, this.snookerSpot(b.id)));
        this.rule.currentPlayer = opponent;
        this.toast(`犯规，P${opponent + 1} 获得 ${penalty} 分`);
      } else if (points > 0) {
        this.rule.scores[player] += points;
        if (this.rule.winner != null) this.toast(`黑球收官，P${this.rule.winner + 1} 获胜本局`);
        else this.toast(`P${player + 1} 得 ${points} 分 · 下一目标：${this.snookerTargetLabel()}`);
      } else {
        this.rule.currentPlayer = opponent;
      }
      // Whenever the turn passes, "ball on" resets: red while reds remain
      // (a striker left on 'color' must not hand that state to the opponent),
      // yellow once the final red's colour chance has gone; a clearance-phase
      // colour stays the target for the incoming player.
      if ((foul || points === 0) && (this.rule.snookerExpected === 'red' || this.rule.snookerExpected === 'color')) {
        const redsRemaining = this.world.balls.some((b) => !b.pocketed && b.value === 1);
        this.rule.snookerExpected = redsRemaining ? 'red' : 'yellow';
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
      if (event.returned) return compact ? '回吸同库' : `回吸同库 · 离库 ${(event.returnDistance * 100).toFixed(1)} cm`;
      const english = { running: '顺塞', reverse: '反塞', side: '纯侧塞', neutral: '无侧塞' }[event.english] || '无侧塞';
      const ratio = event.spinRatio || 0;
      const rotation = ratio < -0.10 ? '后旋入库' : ratio > 1.15 ? '过量前旋'
        : ratio >= 0.85 ? '自然滚动' : ratio > 0.10 ? '前旋入库' : '滑行入库';
      if (compact) return event.english === 'neutral' ? rotation
        : event.frictionMode === 'stick' ? `${english}·软` : english;
      const parts = [english];
      if (event.frictionMode === 'stick' && event.english !== 'neutral') parts.push('软塞黏着区');
      else if (event.frictionMode === 'slide' && event.english !== 'neutral') parts.push('滑移区');
      parts.push(rotation);
      return parts.join(' · ');
    }

    loadDrill(kind) {
      if (this.world.isMoving()) { this.toast('请等待球静止后再切换实验'); return; }
      this.cancelActiveDrags();
      this.exitPlacementSilently();
      if (this.world.mode !== 'chineseEight') this.world.setMode('chineseEight');
      else this.world.reset('chineseEight');
      this.applyBallSkinColors();
      this.world.setCueType($('#cueType').value);
      this.world.setTipType($('#tipType').value);
      this.world.setClothPreset($('#clothPreset').value);
      this.renderer.setTable(this.world.table);

      const place = (ball, position) => {
        ball.pos = { ...position }; ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 };
        ball.posY = 0; ball.velY = 0;
        ball.railContact = null; ball.railTravel = null; ball.pocketFall = null;
        ball.rotation = [0, 0, 0, 1]; ball.pocketed = false; ball.offTable = false; ball.pocketId = null;
        ball.sinkTime = 0; ball.sinkDepth = 0; ball.sinkTarget = null; ball.lastSpeed = 0; ball.state = 'stationary';
      };
      this.world.balls.forEach((ball) => {
        ball.pocketed = true; ball.pocketId = 'drill'; ball.sinkTime = 1; ball.sinkDepth = ball.radius * 3.2; ball.sinkTarget = null;
        ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 }; ball.state = 'pocketed';
      });
      const cue = this.world.getCueBall();
      const setup = createDrill(kind, this.world.table, cue.radius);
      place(cue, setup.cue);
      if (setup.target) place(this.world.getBall('1'), setup.target);
      this.aimDirection = { ...setup.aim };
      this.tipX = setup.spin.x; this.tipY = setup.spin.y;
      this.power = setup.power; this.elevation = setup.elevation;
      this.activeDrill = setup.id;
      this.rule = this.createRuleState('chineseEight'); this.shotNumber = 1;
      // A drill is a fixed layout, not a rack: no break, no cue ball in hand.
      this.rule.breakShot = false; this.rule.ballInHand = null;
      this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
      this.shotRecord = this.emptyShotRecord(); this.prediction = null;
      $('#gameMode').value = 'chineseEight';
      $$('[data-drill]').forEach((button) => {
        const active = button.dataset.drill === setup.id;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
      $('#drillHint').textContent = setup.hint;
      this.updateAllUI(); this.schedulePrediction(true);
      this.toast(`已载入：${$(`[data-drill="${kind}"]`)?.textContent || '物理实验'}`);
    }

    // Any live drag must die with the table it was aimed at — otherwise the
    // held pointer's release fires a stray shot into the fresh layout.
    cancelActiveDrags() {
      if (this.drag) this.finishChargeDrag(true);
      if (this.viewDrag) this.endViewDrag(true);
      if (this.placementDrag) this.endPlacementDrag(true);
    }

    changeMode(mode) {
      if (this.world.isMoving()) {
        $('#gameMode').value = this.world.mode;
        this.toast('请等球静止后再切换项目');
        return;
      }
      this.cancelActiveDrags();
      this.exitPlacementSilently();
      this.clearDrillSelection();
      this.world.setMode(mode, this.nextRackSeed());
      this.applyBallSkinColors();
      this.renderer.setTable(this.world.table);
      this.rule = this.createRuleState(mode);
      this.shotNumber = 1; this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
      this.aimDirection = { x: 1, z: 0 }; this.setPaused(false);
      this.world.setClothPreset($('#clothPreset').value);
      this.schedulePrediction(true); this.updateAllUI();
      this.toast(`${$('#gameMode').selectedOptions[0].text} · 已完成摆球`);
    }

    resetRack() {
      const mode = this.world.mode;
      this.cancelActiveDrags();
      this.exitPlacementSilently();
      this.clearDrillSelection();
      this.world.reset(mode, this.nextRackSeed());
      this.world.setClothPreset($('#clothPreset').value);
      this.applyBallSkinColors();
      this.renderer.setTable(this.world.table);
      this.rule = this.createRuleState(mode); this.shotNumber = 1;
      this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
      this.aimDirection = { x: 1, z: 0 }; this.setPaused(false);
      this.schedulePrediction(true); this.updateAllUI(); this.toast('已重新摆球');
    }

    undo() {
      // Restoring the pre-strike snapshot is atomic, so undo can also abort
      // an active shot. Clear gestures and queued shot events with it.
      const snapshot = this.undoStack.pop();
      if (!snapshot) { this.toast('暂无可撤销的击球'); return; }
      this.cancelActiveDrags();
      this.accumulator = 0;
      this.world.restore(snapshot.world); this.rule = snapshot.rule; this.shotNumber = snapshot.shotNumber; this.aimDirection = snapshot.aimDirection;
      this.applyBallSkinColors();
      this.shotRecord = this.emptyShotRecord();
      this.pendingSettle = false;
      this.setPaused(false);
      this.actualTrails.clear(); this.effects.length = 0; this.schedulePrediction(true); this.updateAllUI(); this.toast('已撤销上一杆');
    }

    setPaused(value) {
      this.paused = value;
      $('#pauseButton').classList.toggle('paused', value);
      $('#pauseButton span').textContent = value ? '继续' : '暂停';
      $('#pauseButton').setAttribute('aria-label', value ? '继续模拟' : '暂停模拟');
    }

    setBallSkin(skin, quiet = false) {
      if (!BALL_SKINS[skin]) return;
      this.ballSkin = skin;
      $('#ballSkin').value = skin;
      this.renderer.setBallStyle(skin);
      this.applyBallSkinColors();
      if (!quiet) this.savePreferences();
      this.schedulePrediction(true);
      if (!quiet) this.toast(`球组外观：${BALL_SKINS[skin].label}`);
    }

    // Recolour the live rack to the active skin.  Ball colours are plain data
    // on the balls (racking copies them from the default palette), so this
    // runs after every re-rack, mode change, drill load and undo restore.
    applyBallSkinColors() {
      const skin = BALL_SKINS[this.ballSkin] || BALL_SKINS.tv;
      this.world.balls.forEach((ball) => {
        if (ball.kind === 'cue') ball.color = skin.cueColor;
        else if (ball.number != null && skin.colors[ball.number]) ball.color = skin.colors[ball.number];
      });
      if (this.placement) this.renderBallTray();
    }

    setSlowMotionRate(rate, quiet = false) {
      const index = SLOW_MOTION_RATES.indexOf(rate);
      if (index < 0) return;
      this.slowMotionRate = rate;
      const label = SLOW_MOTION_LABELS[index];
      const slow = rate < 1;
      $('#slowButton').classList.toggle('active', slow);
      $('#slowButton .speed-glyph').textContent = label;
      $('#physicsRate').textContent = `PHYSICS ${Math.round(1 / (rate * BASE_STEP) / 1000)} kHz`;
      if (!quiet) {
        this.toast(slow
          ? `慢动作 ${label} · 物理步长细化到 ${rate * BASE_STEP * 1e6} µs`
          : '实时速度 · 物理步长 1 ms');
      }
    }

    cycleSlowMotion() {
      const index = SLOW_MOTION_RATES.indexOf(this.slowMotionRate);
      this.setSlowMotionRate(SLOW_MOTION_RATES[(index + 1) % SLOW_MOTION_RATES.length]);
    }

    togglePause() {
      this.setPaused(!this.paused);
      this.toast(this.paused ? '模拟已暂停' : '继续模拟');
    }

    toggleGuides() {
      this.guidesEnabled = !this.guidesEnabled;
      $('#guideToggle').classList.toggle('active', this.guidesEnabled);
      if (this.guidesEnabled) this.schedulePrediction(true);
      else { this.prediction = null; this.clearPredictionMetrics(); }
      this.updateToggleButtons(); this.savePreferences();
    }

    selectPanel(button) {
      $$('[data-panel]').forEach((tab) => {
        const selected = tab === button;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        $(`#${tab.dataset.panel}`).hidden = !selected;
      });
      $('.panel-scroll').scrollTop = 0;
    }

    toggleFocus() {
      this.focused = !this.focused;
      $('#app').classList.toggle('focused', this.focused);
      $('#focusToggle').setAttribute('aria-pressed', String(this.focused));
      $('#focusToggle span').textContent = this.focused ? '显示设置' : '专注球台';
      $('#controlPanel').inert = this.focused;
      this.cancelActiveDrags();
    }

    performPrimaryAction() {
      if (this.placement) this.togglePlacement();
      else if (this.paused) this.setPaused(false);
      else if (this.rule.winner != null) this.resetRack();
      else if (this.rule.pendingChoice) { this.toast('请先选择非法开球的处理方式'); $('#ruleChoice')?.focus(); }
      else this.shoot();
    }

    // CBSA §5.2: after an illegal break the opponent may re-rack and break,
    // make the breaker break again (a second illegal break loses the rack),
    // or accept the table with the cue ball in hand.
    applyRuleChoice(choice) {
      const pending = this.rule.pendingChoice;
      if (!pending || this.world.isMoving()) return;
      this.rule.pendingChoice = null;
      if (choice === 'accept') {
        this.rule.currentPlayer = pending.chooser;
        this.rule.ballInHand = 'table';
        this.toast(`P${pending.chooser + 1} 接受台面，获得自由球`);
      } else {
        const breaker = choice === 'rebreak-breaker' ? pending.breaker : pending.chooser;
        const warning = choice === 'rebreak-breaker' ? pending.breaker : null;
        const scores = [...this.rule.scores];
        this.cancelActiveDrags();
        this.exitPlacementSilently();
        this.world.reset(this.world.mode, this.nextRackSeed());
        this.world.setClothPreset($('#clothPreset').value);
        this.applyBallSkinColors();
        this.renderer.setTable(this.world.table);
        this.rule = this.createRuleState(this.world.mode);
        this.rule.scores = scores;
        this.rule.currentPlayer = breaker;
        this.rule.breakWarning = warning;
        this.shotNumber = 1;
        this.undoStack.length = 0; this.actualTrails.clear(); this.effects.length = 0;
        this.aimDirection = { x: 1, z: 0 };
        this.toast(warning != null ? `重新摆球，P${breaker + 1} 再次开球（再犯判负）` : `重新摆球，由 P${breaker + 1} 开球`);
      }
      this.updateAllUI(); this.schedulePrediction(true);
    }

    updateRuleChoiceUI() {
      const pending = this.rule.pendingChoice;
      const panel = $('#ruleChoice');
      panel.hidden = !pending;
      if (!pending) return;
      $('#ruleChoiceText').textContent = `P${pending.breaker + 1} 开球后没有进球，碰库的目标球不足 4 颗。请 P${pending.chooser + 1} 选择：`;
      $('#ruleChoiceSelf').textContent = `P${pending.chooser + 1} 重新开球`;
      $('#ruleChoiceBreaker').textContent = `P${pending.breaker + 1} 再开一次`;
      $('#ruleChoiceAccept').textContent = `P${pending.chooser + 1} 自由球接着打`;
    }

    updateToggleButtons() {
      const states = { guideToggle: this.guidesEnabled, diamondToggle: this.gridEnabled, trailToggle: this.trailsEnabled, cameraButton: this.renderer.cameraMode === 'top', soundToggle: this.sound.enabled };
      Object.entries(states).forEach(([id, value]) => {
        $(`#${id}`).setAttribute('aria-pressed', String(value));
        if (id !== 'soundToggle') $(`#${id}`).classList.toggle('active', value);
      });
      $('#cameraButton').setAttribute('aria-label', this.renderer.cameraMode === 'top' ? '切换透视视角' : '切换俯视视角');
    }

    restorePreferences() {
      try {
        const saved = JSON.parse(localStorage.getItem('cuelab.preferences') || '{}');
        for (const key of ['guidesEnabled', 'gridEnabled', 'trailsEnabled']) if (typeof saved[key] === 'boolean') this[key] = saved[key];
        if (['club', 'blue', 'classic'].includes(saved.tableTheme)) this.renderer.tableTheme = saved.tableTheme;
        if (BALL_SKINS[saved.ballSkin]) this.setBallSkin(saved.ballSkin, true);
        if (typeof saved.sound === 'boolean') this.sound.enabled = saved.sound;
        for (const key of Object.keys(this.assists)) if (typeof saved.assists?.[key] === 'boolean') this.assists[key] = saved.assists[key];
      } catch { /* File URLs and private browsing may restrict storage. */ }
      $('#tableTheme').value = this.renderer.tableTheme;
      $('#soundToggle').classList.toggle('muted', !this.sound.enabled);
      $('#soundSetting').checked = this.sound.enabled;
      Object.entries({ assistTrajectory: 'trajectory', assistGhost: 'ghost', assistTangent: 'tangent', assistPocket: 'pocket' }).forEach(([id, key]) => { $(`#${id}`).checked = this.assists[key]; });
      $('#assistAll').textContent = Object.values(this.assists).some((value) => !value) ? '全部开启' : '全部关闭';
      this.updateToggleButtons();
    }

    savePreferences() {
      // bindUI sets initial labels before restorePreferences; don't overwrite
      // a returning player's settings during that initialization.
      if (!this.preferencesReady) return;
      try {
        localStorage.setItem('cuelab.preferences', JSON.stringify({
          guidesEnabled: this.guidesEnabled, gridEnabled: this.gridEnabled, trailsEnabled: this.trailsEnabled,
          tableTheme: this.renderer.tableTheme, ballSkin: this.ballSkin, sound: this.sound.enabled, assists: this.assists,
        }));
      } catch { /* Preferences are optional; offline play must still work. */ }
    }

    openHelp() {
      const dialog = $('#helpDialog');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      // showModal focuses the × button; a habitual Space would then "click"
      // it, silently closing the dialog and re-arming every shortcut.
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    }

    closeHelp() {
      const dialog = $('#helpDialog');
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }

    schedulePrediction(immediate = false) {
      this.predictionDirty = true;
      if (!this.guidesEnabled || this.placement || this.world.isMoving()) {
        clearTimeout(this.predictionTimer); this.predictionTimer = null;
        if (!this.guidesEnabled && !this.placement && !this.world.isMoving()) this.refreshStrokeReadouts();
        return;
      }
      // Throttle, not debounce: while a timer is pending, let it fire — it
      // reads the latest aim state anyway.  Re-arming on every pointermove
      // would starve the guide line for as long as the input keeps flowing.
      if (immediate) { clearTimeout(this.predictionTimer); this.predictionTimer = null; }
      else if (this.predictionTimer != null) return;
      const delay = immediate ? 0 : Math.max(0, 70 - (performance.now() - this.lastPredictionAt));
      this.predictionTimer = setTimeout(() => { this.predictionTimer = null; this.updatePrediction(); }, delay);
    }

    updatePrediction() {
      if (!this.predictionDirty || !this.guidesEnabled || this.placement || this.world.isMoving()) return;
      this.predictionDirty = false;
      this.refreshStrokeReadouts();
      this.lastPredictionAt = performance.now();
      // The preview runs in slices: the first one here so the guide appears
      // at once, the rest a few milliseconds per frame until the balls stop.
      // A long break used to cost one 40 ms stall per aim change plus a
      // 200 ms freeze to finish its tail once the aim went quiet.
      this.predictionJob = this.world.beginPrediction(this.shotOptions(), 12);
      this.predictionPublished = null;
      if (!this.predictionJob) {
        this.prediction = this.world.predictShot(this.shotOptions(), 12, 0);
        this.updatePredictionMetrics();
        return;
      }
      this.advancePredictionJob(10);
    }

    advancePredictionJob(budgetMs) {
      const job = this.predictionJob;
      if (!job) return;
      // Anything that replaced or cleared the preview since (a shot, a reset,
      // a caller installing its own) retires this run.
      if (this.predictionPublished && this.prediction !== this.predictionPublished) { this.predictionJob = null; return; }
      const done = this.world.advancePrediction(job, budgetMs);
      this.prediction = this.predictionPublished = this.world.predictionResult(job);
      this.updatePredictionMetrics();
      if (done) this.predictionJob = null;
    }

    // Metrics echo the prediction; whenever the prediction is switched off
    // rather than recomputed, the readouts must blank instead of freezing at
    // the last aim's numbers.
    clearPredictionMetrics() {
      this.predictedRailEvent = null;
      ['#firstHitMetric', '#cutAngleMetric', '#pathMetric', '#railEffectMetric', '#allowanceMetric']
        .forEach((id) => { $(id).textContent = '—'; });
    }

    updatePredictionMetrics() {
      if (!this.prediction) return;
      const event = this.prediction.firstHit;
      if (event) {
        const id = event.aId === 'cue' ? event.bId : event.aId;
        const ball = this.world.getBall(id);
        $('#firstHitMetric').textContent = ball?.number != null ? `${ball.number} 号球` : ball?.label || id;
      } else {
        // No ball contact predicted: report what actually happens first —
        // a cushion, a direct pocket drop, or nothing at all.
        const firstTouch = this.prediction.events.find((e) => (e.type === 'cushion' || e.type === 'pocket' || e.type === 'offTable') && e.ballId === 'cue');
        $('#firstHitMetric').textContent = firstTouch ? ({ cushion: '库边', pocket: '直接落袋', offTable: '飞出台面' }[firstTouch.type])
          : this.prediction.truncated ? '尚未到达' : '无接触';
      }
      const contact = this.predictedAimContact();
      $('#cutAngleMetric').textContent = contact ? `${contact.cutAngle.toFixed(1)}°` : '—';
      $('#pathMetric').textContent = `${this.prediction.truncated ? '≥ ' : ''}${this.prediction.cueDistance.toFixed(2)} m`;
      this.updateElevationUI();
      this.predictedRailEvent = this.prediction.events.find((item) => item.type === 'cushion' && item.ballId === 'cue') || null;
      $('#railEffectMetric').textContent = this.railEffectLabel(this.predictedRailEvent, true);
      const impact = this.world.cueImpactMetrics(this.shotOptions());
      const allowance = impact.aimAllowancePerMetre * 1000;
      $('#allowanceMetric').textContent = allowance < 0.05 ? '0 mm/m' : `${impact.tipX > 0 ? '右' : '左'} ${allowance.toFixed(1)} mm/m`;
    }

    predictedAimContact() {
      const event = this.prediction?.firstHit, cue = this.world.getCueBall();
      if (!event || !cue) return null;
      // A straight aiming ray cannot describe squirt, swerves or jump shots.
      // Build planar teaching aids from the simulated first collision only;
      // a spatial impact has no meaningful table-plane ghost or 90° line.
      if (Math.abs(event.normal.y || 0) > 1e-5 || (event.position.y || 0) > cue.radius + 1e-5) return null;
      const cueIsA = event.aId === 'cue';
      const target = this.world.getBall(cueIsA ? event.bId : event.aId);
      const incoming = cueIsA ? event.incomingA : event.incomingB;
      if (!target || !incoming || V2.length(incoming) < 1e-8) return null;
      const normal = V2.scale(event.normal, cueIsA ? 1 : -1);
      const ghost = V2.sub(event.position, V2.scale(normal, cue.radius));
      const ball = { ...target, pos: V2.add(event.position, V2.scale(normal, target.radius)) };
      return { ball, ghost, normal,
        cutAngle: Math.acos(clamp(V2.dot(V2.normalize(incoming), normal), -1, 1)) * 180 / Math.PI };
    }

    frame(time) {
      const rawDelta = Math.min(0.05, (time - this.lastFrameTime) / 1000 || 0);
      this.lastFrameTime = time;
      this.applyKeyControls(rawDelta);
      if (!this.paused) {
        this.accumulator += rawDelta * this.slowMotionRate;
        // The step shrinks with the playback rate, so a slower gear means a
        // finer physics grid at a constant ~1000 steps per real second.
        const fixed = this.slowMotionRate * BASE_STEP;
        // Trails sample on simulated time (~16.7 ms), not on step count, so
        // their density does not depend on the gear.
        const captureEvery = Math.max(1, Math.round(1 / 60 / fixed));
        let steps = 0;
        // Nothing to integrate on a table at rest; resuming from an idle
        // stretch must not replay it as a backlog either.
        if (!this.world.inShot && !this.world.isMoving()) this.accumulator = 0;
        while (this.accumulator >= fixed && steps < 60) {
          this.world.step(fixed);
          this.accumulator -= fixed; steps += 1; this.trailFrame += 1;
          if (this.trailsEnabled && this.trailFrame % captureEvery === 0) this.captureTrails();
        }
        // A stalled tab dumps its backlog instead of death-spiralling.
        if (steps === 60 && this.accumulator > fixed * 10) this.accumulator = 0;
      }
      if (this.pendingSettle) this.settleShot();
      if (this.predictionJob && !this.world.isMoving()) this.advancePredictionJob(6);

      const moving = this.world.isMoving();
      if (moving !== this.wasMoving) {
        this.wasMoving = moving;
        this.updateMotionUI(moving);
        if (!moving) this.schedulePrediction(true);
      }
      // The stroke geometry only matters while the stick is on show; solving
      // it for every frame of a moving rack would be wasted work.
      const showCue = !moving && !this.paused && !this.placement && !this.rule.pendingChoice;
      const stroke = showCue ? this.strokeGeometry() : { elevation: this.elevation, tipX: this.tipX, tipY: this.tipY };
      this.renderer.render(this.world, {
        showCue,
        aimDirection: this.aimDirection,
        elevation: stroke.elevation,
        pullback: this.pullback,
        tipX: stroke.tipX,
        tipY: stroke.tipY,
      });
      this.drawGuides(time);
      this.updateLiveTelemetry();
      this.updateActionUI();
      this.updateFps(time);
      requestAnimationFrame((next) => this.frame(next));
    }

    captureTrails() {
      this.world.balls.forEach((ball) => {
        if (ball.pocketed || Math.hypot(ball.vel.x, ball.vel.z) < 0.008) return;
        if (!this.actualTrails.has(ball.id)) this.actualTrails.set(ball.id, []);
        const path = this.actualTrails.get(ball.id);
        path.push({ ...ball.pos, y: ball.posY });
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
      if (this.rule.ballInHand && !this.world.isMoving() && !this.placement) this.drawBallInHand(ctx);
      this.drawEffects(ctx, time);
    }

    // A dashed ring marks a cue ball that may be picked up and placed.
    drawBallInHand(ctx) {
      const cue = this.world.getCueBall();
      if (!cue || cue.pocketed) return;
      const centre = this.renderer.project({ x: cue.pos.x, y: cue.radius, z: cue.pos.z });
      if (!centre) return;
      const radius = this.renderer.ballScreenRadius(cue) * 1.7;
      ctx.save();
      ctx.strokeStyle = 'rgba(236, 201, 109, .9)'; ctx.lineWidth = 1.4; ctx.setLineDash([4, 3]);
      ctx.beginPath(); ctx.arc(centre.x, centre.y, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]); ctx.font = '600 9px ui-monospace, monospace'; ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(5,20,16,.8)';
      const label = this.rule.ballInHand === 'kitchen' ? '线后自由球' : '自由球';
      const w = ctx.measureText(label).width;
      ctx.fillRect(centre.x - w / 2 - 5, centre.y - radius - 19, w + 10, 15);
      ctx.fillStyle = '#f3e3b0'; ctx.fillText(label, centre.x, centre.y - radius - 8);
      ctx.restore();
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
        // Dotted and dimmer than the solid prediction, but still readable on
        // its own while a shot runs (the prediction is hidden then).
        ctx.strokeStyle = id === 'cue' ? 'rgba(97, 244, 199, .5)' : 'rgba(229, 189, 101, .36)';
        ctx.lineWidth = id === 'cue' ? 1.7 : 1.3; ctx.setLineDash([1.5, 4.5]);
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

      const contact = this.predictedAimContact();
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
        if (point.pocketed) break;
        const screen = this.renderer.project({ x: point.x, y: Math.max(0, point.y || 0) + 0.009, z: point.z });
        if (!screen) continue;
        if (!started) { ctx.moveTo(screen.x, screen.y); started = true; } else ctx.lineTo(screen.x, screen.y);
      }
      if (started) ctx.stroke();
    }

    drawPathDots(ctx, path, color) {
      ctx.fillStyle = color;
      for (let i = 18; i < path.length; i += 28) {
        if (path[i].pocketed) break;
        const p = this.renderer.project({ x: path[i].x, y: Math.max(0, path[i].y || 0) + 0.012, z: path[i].z });
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
          if (other.id === ball.id || other.pocketed || other.id === 'cue') return false;
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
        // The rAF timestamp can lag performance.now() (effect.born) by a full
        // slow frame; a negative age once fed ctx.arc a negative radius,
        // which throws and permanently kills the frame loop.
        const age = Math.max(0, (time - effect.born) / effect.life);
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
      $('#powerSlider').style.setProperty('--progress', `${(value - 3) / 97 * 100}%`);
      $('#dragPowerBar').style.width = `${value}%`; $('#dragPowerLabel').textContent = `${value}%`;
      this.updateSpinUI();
    }

    updateElevationUI() {
      const effective = Math.round(this.effectiveElevation());
      $('#elevationSlider').value = this.elevation;
      $('#elevationValue').textContent = effective > this.elevation ? `${this.elevation}°→${effective}°` : `${this.elevation}°`;
      $('#elevationFill').style.width = `${this.elevation / 60 * 100}%`;
      $('#elevationSlider').style.setProperty('--progress', `${this.elevation / 60 * 100}%`);
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
      const stroke = this.strokeGeometry();
      const parts = [describe(stroke.tipX, '左', '右'), describe(stroke.tipY, '低', '高')].filter(Boolean);
      $('#hudTip').textContent = `${parts.length ? parts.join(' · ') : '中心'}${stroke.liftedTip ? '（杆被挡）' : ''}`;
      const trim = $('#hudTrim');
      trim.textContent = `${this.aimTrim > 0 ? '右 +' : this.aimTrim < 0 ? '左 −' : ''}${Math.abs(this.aimTrim).toFixed(2)}°`;
      trim.classList.toggle('hot', Math.abs(this.aimTrim) > 0.005);
      $('#hudSpeed').textContent = `${Math.round(this.effectiveElevation())}° · ${impact.horizontalSpeed.toFixed(1)} m/s`;
    }

    updateSpinUI() {
      const marker = $('#spinMarker');
      marker.style.left = `${50 + this.tipX * 39}%`; marker.style.top = `${50 - this.tipY * 39}%`;
      $('#spinXValue').textContent = `${this.tipX >= 0 ? '+' : ''}${Math.round(this.tipX * 100)}%`;
      $('#spinYValue').textContent = `${this.tipY >= 0 ? '+' : ''}${Math.round(this.tipY * 100)}%`;
      if (!this.world) return;
      this.refreshStrokeReadouts();
      $('#spinControl').setAttribute('aria-label', `母球击点：横向 ${Math.round(this.tipX * 100)}%，纵向 ${Math.round(this.tipY * 100)}%；方向键微调，Home 回中`);
      $$('.presets button').forEach((button) => {
        const [x, y] = button.dataset.spin.split(',').map(Number);
        const active = Math.abs(x - this.tipX) < 0.015 && Math.abs(y - this.tipY) < 0.015;
        button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active));
      });
    }

    // Readouts of the stroke that will actually be played: the automatic
    // cue raise and tip lift depend on aim, ball position and nearby balls,
    // not only on the tip marker, so aiming refreshes them too.
    refreshStrokeReadouts() {
      if (!this.world) return;
      const impact = this.world.cueImpactMetrics(this.shotOptions());
      this.lastImpactMetrics = impact;
      $('#spinRpmValue').textContent = `${Math.round(Math.abs(impact.omega.y) * 60 / (2 * Math.PI))} rpm`;
      const allowance = impact.aimAllowancePerMetre * 1000;
      $('#spinAllowanceValue').textContent = allowance < 0.05 ? '0 mm/m' : `${impact.tipX > 0 ? '向右' : '向左'} ${allowance.toFixed(1)} mm/m`;
      $('#spinMarker').classList.toggle('warning', impact.miscueMargin < 0.035);
      this.updateHud();
      this.updateActionUI();
    }

    updateEquipmentHint() {
      const cue = this.world.getCueSpec(), tip = this.world.getTipSpec(), table = this.world.table;
      const cloth = $('#clothPreset')?.selectedOptions[0]?.text || '标准台呢';
      const endMass = (cue.effectiveEndMass * 1000).toFixed(1);
      $('#equipmentHint').textContent = `${table.name} · ${cloth}${table.clothNapStrength ? ' / 顺毛参与阻力' : ''} · ${cue.detail}（前端有效质量 ${endMass} g）/ ${tip.label}`;
      $('#tableSpecs').textContent = `${table.width.toFixed(2)} × ${table.height.toFixed(2)} m 台面 · ${(this.world.params.radius * 2000).toFixed(2)} mm 比赛球\n角袋 ${Math.round(table.cornerMouth * 1000)} mm · 中袋 ${Math.round(table.sideMouth * 1000)} mm`;
    }

    updateMotionUI(moving) {
      $('#motionBadge').textContent = moving ? '运动中' : '静止'; $('#motionBadge').classList.toggle('moving', moving);
      $('#keyHud').classList.toggle('dimmed', moving);
      $('.stage-status').classList.toggle('busy', moving);
      $('#statusEyebrow').textContent = moving ? 'SIMULATING · 物理解算中' : 'READY · 准备击球';
      $('#statusText').textContent = moving ? '观察旋转、碰撞与走位'
        : this.activeDrill ? '实验球位已固定；打一杆后撤销可做对照'
          : this.rule.pendingChoice ? `非法开球 · 等待 P${this.rule.pendingChoice.chooser + 1} 选择`
            : this.rule.ballInHand === 'kitchen' ? '开球线后自由球：按住母球拖动摆放，再瞄准击球'
              : this.rule.ballInHand ? '自由球：按住母球拖到任意位置，再瞄准击球'
                : '移动指针瞄准，向后拖动击球';
      this.updateActionUI(moving);
    }

    updateActionUI(moving = this.world.isMoving()) {
      const button = $('#shootButton');
      const label = this.placement ? '完成摆球' : this.paused ? '继续模拟' : this.rule.winner != null ? '再来一局'
        : moving ? '球运动中' : this.rule.pendingChoice ? '等待选择' : '击球';
      button.disabled = (moving && !this.paused && !this.placement) || (Boolean(this.rule.pendingChoice) && !moving && !this.paused && !this.placement);
      if (button.querySelector('strong').textContent !== label) button.querySelector('strong').textContent = label;
      $('#undoButton').disabled = this.undoStack.length === 0;
      $('#pauseButton').setAttribute('aria-pressed', String(this.paused));
      const feedback = $('#shotFeedback');
      const impact = this.lastImpactMetrics;
      const scratch = this.prediction?.events.find((event) => (event.type === 'pocket' || event.type === 'offTable') && event.ballId === 'cue');
      const idle = !moving && !this.paused && !this.placement;
      const stroke = idle ? this.strokeGeometry() : { raised: false, liftedTip: false, blocked: false, elevation: this.elevation, tipY: this.tipY };
      const warning = idle && (impact?.miscue || scratch || stroke.liftedTip || stroke.blocked);
      const message = this.placement ? '拖动球调整布局，完成后即可击球。'
        : this.paused ? '模拟已暂停，点击底部按钮继续。'
        : moving ? '正在走位，可以暂停或切换慢动作观察。'
        : this.rule.winner != null ? `P${this.rule.winner + 1} 获胜，点击「再来一局」重新开始。`
        : this.rule.pendingChoice ? '非法开球：请在球台上方的面板中选择处理方式。'
        : impact?.miscue ? '击点接近球边，容易疵杆。向中心收一点。'
        : stroke.blocked ? '球杆被库边或母球后方的球挡住，这个方向打不出去，换个角度或抬高杆。'
        : stroke.liftedTip ? `球杆被库边或后方的球挡住，够不到原击点：击点已上移到${Math.abs(stroke.tipY) < 0.02 ? '中心' : `${stroke.tipY > 0 ? '高' : '低'} ${Math.round(Math.abs(stroke.tipY) * 100)}%`}，杆角 ${Math.round(stroke.elevation)}°。`
        : scratch ? (scratch.type === 'offTable' ? '预测母球会飞出台面，减小力度或降低杆角。' : '预测母球会落袋，试着减小力度或调整杆法。')
        : stroke.raised && stroke.elevation > this.elevation + 1 ? `球杆需要越过库边或后方的球，已自动抬高到 ${Math.round(stroke.elevation)}°${stroke.elevation >= 40 ? '；抬杆弧线含腾空与落地过程' : ''}。`
        : this.effectiveElevation() >= 40 ? '抬杆弧线含腾空与落地过程；起跳幅度尚未按实台标定。'
        : this.rule.ballInHand ? '自由球：按住母球拖动摆放，然后瞄准击球。'
        : '已准备好，瞄准后点击击球或按空格。';
      if (feedback.textContent !== message) feedback.textContent = message;
      feedback.classList.toggle('warning', Boolean(warning));
    }

    updateLiveTelemetry() {
      const cue = this.world.getCueBall();
      const speed = cue && !cue.pocketed ? Math.hypot(cue.vel.x, cue.vel.z) : 0;
      const rpm = cue && !cue.pocketed ? Math.hypot(cue.omega.x, cue.omega.y, cue.omega.z) * 60 / (2 * Math.PI) : 0;
      $('#speedValue').textContent = speed.toFixed(2); $('#liveRpmValue').textContent = Math.round(rpm);
      const stateLabels = { stationary: '静止', sliding: '滑动', rolling: '纯滚动', spinning: '原地旋转', airborne: '腾空', falling: '袋沿下落', pocketed: '已落袋', offTable: '飞出台面' };
      $('#motionStateValue').textContent = stateLabels[cue?.state] || '静止';
      if (cue && !cue.pocketed) {
        const slip = Math.hypot(cue.vel.x + cue.omega.z * cue.radius, cue.vel.z - cue.omega.x * cue.radius);
        $('#slipValue').textContent = cue.posY > 1e-6 || cue.velY > 1e-6 ? `离台 ${(Math.max(0, cue.posY) * 100).toFixed(1)} cm`
          : cue.pocketFall ? '袋沿失去支撑' : slip > 0.012 ? `滑差 ${slip.toFixed(2)}` : '无滑动';
      } else $('#slipValue').textContent = '—';
      $('#energyValue').textContent = this.world.totalEnergy().toFixed(2);
      const progress = this.world.inShot ? clamp(this.world.shotTime / Math.max(0.2, this.predictedShotDuration), 0, 1) : 0;
      $('#timelineProgress').style.width = `${progress * 100}%`; $('#timelineKnob').style.left = `${progress * 100}%`;
    }

    updateScoreboard() {
      $('#scoreP1').textContent = this.rule.scores[0]; $('#scoreP2').textContent = this.rule.scores[1];
      $('#mobileScore').textContent = this.world.mode === 'practice' ? '自由练习' : `P${this.rule.currentPlayer + 1} 击球 · ${this.rule.scores[0]} : ${this.rule.scores[1]}`;
      $$('.scoreboard .player').forEach((element, index) => element.classList.toggle('active', index === this.rule.currentPlayer));
      $('#shotLabel').textContent = `第 ${this.shotNumber} 杆`;
      let hint = '瞄准线显示考虑当前杆法后的模拟轨迹';
      if (this.world.mode === 'eight' || this.world.mode === 'chineseEight') {
        hint = this.rule.groups[0] ? `P1 ${this.rule.groups[0] === 'solid' ? '全色' : '花色'} · P2 ${this.rule.groups[1] === 'solid' ? '全色' : '花色'}`
          : this.rule.breakShot ? '开球：至少进 1 球或 4 颗目标球碰库'
            : this.world.mode === 'chineseEight' ? '开放球局：打进先碰球组的球即确定球组' : '开放球局：合法打进的全色或花色球确定球组';
      }
      if (this.world.mode === 'nine') hint = `当前应先击打 ${this.lowestNineBall() ?? '—'} 号球`;
      if (this.world.mode === 'snooker') hint = this.rule.winner != null ? `本局已结束 · P${this.rule.winner + 1} 获胜` : `当前目标：${this.snookerTargetLabel()}`;
      $('#shotHint').textContent = hint;
    }

    updateAllUI() {
      // Selects first: the world is the source of truth (undo restores cloth,
      // cue and tip physics), and updateEquipmentHint reads their labels.
      $('#gameMode').value = this.world.mode;
      $('#cueType').value = this.world.cueType;
      $('#tipType').value = this.world.tipType;
      $('#clothPreset').value = this.world.clothPreset;
      this.updatePowerUI(); this.updateElevationUI(); this.updateSpinUI(); this.updateEquipmentHint(); this.updateScoreboard(); this.updateMotionUI(this.world.isMoving());
      this.updateRuleChoiceUI();
      // The panel's ball emblem follows the game: an 8, the yellow 9, a red.
      const emblem = $('.panel-ball');
      if (emblem) {
        const kind = { nine: 'nine', snooker: 'snooker' }[this.world.mode] || 'eight';
        emblem.dataset.kind = kind;
        emblem.textContent = kind === 'nine' ? '9' : kind === 'snooker' ? '' : '8';
      }
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
