(function (global) {
  'use strict';

  const { V2, V3, Quat, clamp } = global.BilliardsMath;
  const G = 9.81;

  // Baseline values are aligned with Pooltool's generic pool-ball parameters.
  // See README for papers and exact sources. Units are SI throughout this file.
  const POOL_PARAMS = Object.freeze({
    radius: 0.028575,
    mass: 0.170097,
    muSlide: 0.20,
    muRoll: 0.010,
    muSpin: 0.0127,
    restitutionBall: 0.95,
    restitutionCushion: 0.82,
    frictionCushion: 0.20,
  });

  const CHINESE_PARAMS = Object.freeze({
    radius: 0.028575,
    mass: 0.1695,
    muSlide: 0.205,
    muRoll: 0.0095,
    muSpin: 0.0127,
    restitutionBall: 0.95,
    restitutionCushion: 0.82,
    frictionCushion: 0.23,
  });

  const SNOOKER_PARAMS = Object.freeze({
    radius: 0.02619375,
    mass: 0.140,
    muSlide: 0.20,
    muRoll: 0.008,
    muSpin: 0.0115,
    restitutionBall: 0.94,
    restitutionCushion: 0.81,
    frictionCushion: 0.20,
  });

  // Tip diameter and effective front-end mass are kept separate: tip size changes
  // usable contact geometry, while front-end mass is the dominant squirt control.
  const CUE_SPECS = Object.freeze({
    small: Object.freeze({
      id: 'small', label: '小头杆', detail: '中式低偏移木前节', tipDiameter: 0.010, shaftRadius: 0.0061,
      cueMass: 0.515, effectiveEndMass: 0.0052, spinEfficiency: 0.98,
      maxOffset: 0.90, powerEfficiency: 0.985,
    }),
    large: Object.freeze({
      id: 'large', label: '大头杆', detail: '高性能低偏移前节', tipDiameter: 0.0125, shaftRadius: 0.0073,
      cueMass: 0.535, effectiveEndMass: 0.0064, spinEfficiency: 0.96,
      maxOffset: 0.88, powerEfficiency: 1.0,
    }),
  });

  // Alciatore's measured ball-ball sliding friction falls off exponentially with
  // contact slip speed; this is what makes soft-speed shots throw the most.
  function ballBallFriction(slipSpeed) {
    return 0.009951 + 0.108 * Math.exp(-1.088 * slipSpeed);
  }

  const TIP_PRESETS = Object.freeze({
    soft: Object.freeze({
      id: 'soft', label: '软皮头', friction: 0.72,
      energyEfficiency: 0.982, spinTransfer: 1.015, safeOffset: 0.91,
    }),
    medium: Object.freeze({
      id: 'medium', label: '中等皮头', friction: 0.68,
      energyEfficiency: 0.990, spinTransfer: 1.0, safeOffset: 0.89,
    }),
    hard: Object.freeze({
      id: 'hard', label: '硬皮头', friction: 0.63,
      energyEfficiency: 0.996, spinTransfer: 0.975, safeOffset: 0.86,
    }),
  });

  const TABLES = Object.freeze({
    chinese: {
      width: 2.54,
      height: 1.26,
      railWidth: 0.142,
      pocketRadius: 0.050,
      cornerMouth: 0.085,
      sideMouth: 0.085,
      jawRadius: 0.028,
      cushionContactHeight: 0.037,
      cushionTopHeight: 0.042,
      captureCorner: 1.45,
      captureSide: 1.05,
      sideShelfFactor: 0.68,
      clothNap: { x: 1, z: 0 },
      clothNapStrength: 0.035,
      cueStart: -0.635,
      rackApex: 0.635,
      style: 'chinese',
      slateThickness: 0.046,
      rubberProfile: 'steel-rail-rounded',
      clothName: '中式比赛级顺毛台呢',
      name: '乔氏金腿式赛事台',
    },
    pool: {
      width: 2.54,
      height: 1.27,
      railWidth: 0.135,
      pocketRadius: 0.063,
      cornerMouth: 0.114,
      sideMouth: 0.127,
      jawRadius: 0.010,
      cushionContactHeight: 0.0363,
      cushionTopHeight: 0.048,
      captureCorner: 1.56,
      captureSide: 1.24,
      sideShelfFactor: 0.88,
      clothNap: { x: 1, z: 0 },
      clothNapStrength: 0,
      cueStart: -0.66,
      rackApex: 0.635,
      style: 'pool',
      name: '9 英尺美式球台',
    },
    snooker: {
      width: 3.569,
      height: 1.778,
      railWidth: 0.145,
      pocketRadius: 0.059,
      cornerMouth: 0.086,
      sideMouth: 0.090,
      jawRadius: 0.024,
      cushionContactHeight: 0.034,
      cushionTopHeight: 0.039,
      captureCorner: 1.45,
      captureSide: 1.08,
      sideShelfFactor: 0.70,
      clothNap: { x: 1, z: 0 },
      clothNapStrength: 0.028,
      cueStart: -1.12,
      style: 'snooker',
      name: '12 英尺斯诺克球台',
    },
  });

  const POOL_COLORS = {
    1: '#edc83d', 2: '#2c69ce', 3: '#d54842', 4: '#7a4da5',
    5: '#ed812d', 6: '#278459', 7: '#873b38', 8: '#141817',
    9: '#edc83d', 10: '#2c69ce', 11: '#d54842', 12: '#7a4da5',
    13: '#ed812d', 14: '#278459', 15: '#873b38',
  };

  const SNOOKER_COLORS = {
    red: '#bd2f35', yellow: '#e3c83a', green: '#28744d', brown: '#6e3828',
    blue: '#2867a3', pink: '#e5a0ad', black: '#171b1a', cue: '#f2f4ec',
  };

  function copyTable(table) {
    return {
      ...table,
      clothNap: { ...table.clothNap },
      pockets: table.pockets.map((p) => ({
        ...p,
        throat: p.throat ? { ...p.throat } : null,
        outward: p.outward ? { ...p.outward } : null,
      })),
      cushions: table.cushions.map((s) => ({ ...s, normal: { ...s.normal } })),
      jaws: table.jaws.map((p) => ({
        ...p,
        normal: p.normal ? { ...p.normal } : null,
        tangent: p.tangent ? { ...p.tangent } : null,
      })),
    };
  }

  function configureTable(kind) {
    const base = TABLES[kind];
    const table = { ...base, clothNap: { ...base.clothNap } };
    // A jaw circle is mounted one radius behind its rail face.  This makes its
    // inner arc tangent to the straight cushion instead of bulging into it.
    // The corner formula measures the requested mouth along the line joining
    // the two arc centres; the side-pocket centres lie on one parallel line.
    table.cornerGap = (table.cornerMouth + 2 * table.jawRadius) / Math.sqrt(2) - table.jawRadius;
    table.sideGap = (table.sideMouth + 2 * table.jawRadius) / 2;
    const hx = table.width / 2;
    const hz = table.height / 2;
    const q = table.jawRadius;
    const diagonal = Math.SQRT1_2;
    const cornerInset = (table.cornerGap - q) / 2;
    const cornerSinkOffset = q * 0.34;
    const sideSinkOffset = q * 0.60;
    const sideThroatOffset = q * 0.20;
    const cornerPocket = (sx, sz, id) => ({
      x: sx * (hx + cornerSinkOffset),
      z: sz * (hz + cornerSinkOffset),
      throat: { x: sx * (hx - cornerInset), z: sz * (hz - cornerInset) },
      outward: { x: sx * diagonal, z: sz * diagonal },
      minCaptureDepth: 0.008,
      type: 'corner', id,
    });
    const sidePocket = (sz, id) => ({
      x: 0,
      z: sz * (hz + sideSinkOffset),
      throat: { x: 0, z: sz * (hz + sideThroatOffset) },
      outward: { x: 0, z: sz },
      minCaptureDepth: 0,
      type: 'side', id,
    });
    table.pockets = [
      cornerPocket(-1, -1, 'bl'),
      sidePocket(-1, 'bm'),
      cornerPocket(1, -1, 'br'),
      cornerPocket(-1, 1, 'tl'),
      sidePocket(1, 'tm'),
      cornerPocket(1, 1, 'tr'),
    ];
    table.cushions = [
      // Bottom and top long rails, split around the side pockets.
      { id: 'bottom-left', axis: 'x', value: -hz, min: -hx + table.cornerGap, max: -table.sideGap, normal: { x: 0, z: 1 } },
      { id: 'bottom-right', axis: 'x', value: -hz, min: table.sideGap, max: hx - table.cornerGap, normal: { x: 0, z: 1 } },
      { id: 'top-left', axis: 'x', value: hz, min: -hx + table.cornerGap, max: -table.sideGap, normal: { x: 0, z: -1 } },
      { id: 'top-right', axis: 'x', value: hz, min: table.sideGap, max: hx - table.cornerGap, normal: { x: 0, z: -1 } },
      // Short end rails.
      { id: 'left', axis: 'z', value: -hx, min: -hz + table.cornerGap, max: hz - table.cornerGap, normal: { x: 1, z: 0 } },
      { id: 'right', axis: 'z', value: hx, min: -hz + table.cornerGap, max: hz - table.cornerGap, normal: { x: -1, z: 0 } },
    ];
    table.jaws = table.cushions.flatMap((s) => {
      const points = s.axis === 'x'
        ? [{ x: s.min, z: s.value }, { x: s.max, z: s.value }]
        : [{ x: s.value, z: s.min }, { x: s.value, z: s.max }];
      return points.map((tangent, index) => ({
        x: tangent.x - s.normal.x * q,
        z: tangent.z - s.normal.z * q,
        tangent: { ...tangent },
        normal: { ...s.normal },
        segmentId: s.id,
        id: `jaw-${s.id}-${index}`,
        radius: q,
      }));
    });
    return table;
  }

  function initialBallRotation(id) {
    const text = String(id);
    let seed = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      seed ^= text.charCodeAt(i);
      seed = Math.imul(seed, 16777619);
    }
    const unit = (shift) => (((seed >>> shift) ^ Math.imul(seed, 2654435761 + shift * 97)) >>> 0) / 4294967295;
    const ax = unit(1) * Math.PI * 2, ay = unit(7) * Math.PI * 2, az = unit(13) * Math.PI * 2;
    const sx = Math.sin(ax / 2), cx = Math.cos(ax / 2);
    const sy = Math.sin(ay / 2), cy = Math.cos(ay / 2);
    const sz = Math.sin(az / 2), cz = Math.cos(az / 2);
    return Quat.normalize([
      sx * cy * cz - cx * sy * sz,
      cx * sy * cz + sx * cy * sz,
      cx * cy * sz - sx * sy * cz,
      cx * cy * cz + sx * sy * sz,
    ]);
  }

  function makeBall(spec, params) {
    return {
      id: spec.id,
      number: spec.number ?? null,
      label: spec.label || String(spec.number ?? ''),
      kind: spec.kind || 'solid',
      color: spec.color || '#eeeeea',
      value: spec.value || 0,
      pos: { x: spec.x || 0, z: spec.z || 0 },
      vel: { x: 0, z: 0 },
      omega: { x: 0, y: 0, z: 0 },
      rotation: initialBallRotation(spec.id),
      radius: params.radius,
      mass: params.mass,
      inertia: (2 / 5) * params.mass * params.radius * params.radius,
      state: 'stationary',
      pocketed: false,
      pocketId: null,
      sinkTime: 0,
      sinkDepth: 0,
      sinkTarget: null,
      lastSpeed: 0,
    };
  }

  function rackPool(mode, params, table) {
    const balls = [makeBall({ id: 'cue', label: '母球', kind: 'cue', color: '#f0f3eb', x: table.cueStart, z: 0 }, params)];
    const R = params.radius;
    const spacing = 2 * R + 0.00075;
    if (mode === 'practice') {
      const setup = [
        [1, 0.10, 0.00], [2, 0.52, -0.27], [3, 0.61, 0.28],
        [8, 0.91, 0.02], [9, 0.25, 0.36], [11, 0.92, -0.36],
      ];
      setup.forEach(([number, x, z]) => balls.push(makeBall({
        id: String(number), number, kind: number > 8 ? 'stripe' : 'solid', color: POOL_COLORS[number], x, z,
      }, params)));
      return balls;
    }

    if (mode === 'nine') {
      const order = [1, 2, 3, 4, 9, 5, 6, 7, 8];
      const counts = [1, 2, 3, 2, 1];
      const apex = table.rackApex;
      let index = 0;
      counts.forEach((count, row) => {
        const x = apex + row * Math.sqrt(3) * (spacing / 2);
        for (let j = 0; j < count; j += 1) {
          const number = order[index++];
          const z = (j - (count - 1) / 2) * spacing;
          balls.push(makeBall({ id: String(number), number, kind: number > 8 ? 'stripe' : 'solid', color: POOL_COLORS[number], x, z }, params));
        }
      });
      return balls;
    }

    // 8 ball in the centre; the two rear corners are one solid and one stripe.
    const order = [1, 9, 2, 10, 8, 3, 11, 4, 12, 5, 13, 6, 14, 15, 7];
    const apex = table.rackApex;
    let index = 0;
    for (let row = 0; row < 5; row += 1) {
      const x = apex + row * Math.sqrt(3) * (spacing / 2);
      for (let j = 0; j <= row; j += 1) {
        const number = order[index++];
        const z = (j - row / 2) * spacing;
        balls.push(makeBall({ id: String(number), number, kind: number > 8 ? 'stripe' : 'solid', color: POOL_COLORS[number], x, z }, params));
      }
    }
    return balls;
  }

  function rackSnooker(params) {
    const balls = [];
    const R = params.radius;
    const spacing = 2 * R + 0.0008;
    balls.push(makeBall({ id: 'cue', label: '母球', kind: 'cue', color: SNOOKER_COLORS.cue, x: -1.12, z: -0.22 }, params));
    const colors = [
      ['yellow', '黄球', 2, -0.89, -0.292], ['green', '绿球', 3, -0.89, 0.292],
      ['brown', '棕球', 4, -0.89, 0], ['blue', '蓝球', 5, 0, 0],
      ['pink', '粉球', 6, 0.89, 0], ['black', '黑球', 7, 1.43, 0],
    ];
    colors.forEach(([id, label, value, x, z]) => balls.push(makeBall({ id, label, value, kind: 'snooker', color: SNOOKER_COLORS[id], x, z }, params)));
    const apex = 0.955;
    let red = 1;
    for (let row = 0; row < 5; row += 1) {
      const x = apex + row * Math.sqrt(3) * (spacing / 2);
      for (let j = 0; j <= row; j += 1) {
        balls.push(makeBall({ id: `red${red}`, label: `红球 ${red}`, value: 1, kind: 'snooker', color: SNOOKER_COLORS.red, x, z: (j - row / 2) * spacing }, params));
        red += 1;
      }
    }
    return balls;
  }

  function cloneBall(ball) {
    return {
      ...ball,
      pos: { ...ball.pos }, vel: { ...ball.vel }, omega: { ...ball.omega }, rotation: [...ball.rotation],
      sinkTarget: ball.sinkTarget ? { ...ball.sinkTarget } : null,
    };
  }

  class PhysicsWorld {
    constructor(mode = 'chineseEight', options = {}) {
      this.silent = Boolean(options.silent);
      this.cueType = CUE_SPECS[options.cueType] ? options.cueType : 'small';
      this.tipType = TIP_PRESETS[options.tipType] ? options.tipType : 'medium';
      this.eventHandler = null;
      this.time = 0;
      this.shotTime = 0;
      this.inShot = false;
      this.collisionCooldown = new Map();
      this.lastCueMetrics = null;
      this.lastCushionEvent = null;
      this.setMode(mode);
    }

    setMode(mode) {
      this.mode = mode;
      const snooker = mode === 'snooker';
      const chinese = mode === 'chineseEight';
      this.params = { ...(snooker ? SNOOKER_PARAMS : chinese ? CHINESE_PARAMS : POOL_PARAMS) };
      this.table = configureTable(snooker ? 'snooker' : chinese ? 'chinese' : 'pool');
      this.balls = snooker ? rackSnooker(this.params) : rackPool(mode, this.params, this.table);
      this.setClothPreset('standard');
      this.time = 0;
      this.shotTime = 0;
      this.inShot = false;
      this.lastCueMetrics = null;
      this.lastCushionEvent = null;
      this.collisionCooldown.clear();
    }

    reset(mode = this.mode) {
      this.setMode(mode);
      this.emit({ type: 'reset' });
    }

    setClothPreset(preset) {
      this.clothPreset = preset;
      const rollScale = this.mode === 'snooker' ? 0.9 : this.mode === 'chineseEight' ? 0.95 : 1;
      const values = {
        fast: { slide: 0.17, roll: 0.0065 },
        standard: { slide: 0.20, roll: 0.010 },
        slow: { slide: 0.24, roll: 0.016 },
      }[preset] || { slide: 0.20, roll: 0.010 };
      this.params.muSlide = values.slide;
      this.params.muRoll = values.roll * rollScale;
    }

    setCueType(type) {
      if (!CUE_SPECS[type]) return false;
      this.cueType = type;
      return true;
    }

    getCueSpec() { return CUE_SPECS[this.cueType] || CUE_SPECS.small; }

    setTipType(type) {
      if (!TIP_PRESETS[type]) return false;
      this.tipType = type;
      return true;
    }

    getTipSpec() { return TIP_PRESETS[this.tipType] || TIP_PRESETS.medium; }

    cueImpactMetrics(options = {}) {
      const cue = this.getCueBall();
      const R = cue?.radius || this.params.radius;
      const spec = CUE_SPECS[options.cueType] || this.getCueSpec();
      const tipSpec = TIP_PRESETS[options.tipType] || this.getTipSpec();
      let direction = V2.normalize(options.direction || { x: 1, z: 0 });
      const speedInput = clamp(options.speed || 1, 0.05, 7.2);
      const requestedTipX = options.tipX || 0;
      const requestedTipY = options.tipY || 0;
      const frictionContactLimit = tipSpec.friction / Math.sqrt(1 + tipSpec.friction * tipSpec.friction);
      const frictionSafeOffset = clamp(frictionContactLimit / 0.63, 0.78, 0.93);
      const safeOffset = Math.min(spec.maxOffset, tipSpec.safeOffset, frictionSafeOffset);
      let tipX = clamp(requestedTipX, -safeOffset, safeOffset);
      let tipY = clamp(requestedTipY, -safeOffset, safeOffset);
      const offsetMagnitude = Math.hypot(tipX, tipY);
      if (offsetMagnitude > safeOffset) {
        const scale = safeOffset / offsetMagnitude;
        tipX *= scale; tipY *= scale;
      }
      const elevation = clamp(options.elevation || 0, 0, 40) * Math.PI / 180;
      const offset = Math.hypot(tipX, tipY);
      const ballMass = cue?.mass || this.params.mass;
      const cueRestitution = 0.73;
      const transfer = (1 + cueRestitution) * spec.cueMass / (spec.cueMass + ballMass);
      const referenceTransfer = (1 + cueRestitution) * 0.525 / (0.525 + 0.1695);
      const efficiency = transfer / referenceTransfer * spec.powerEfficiency * tipSpec.energyEfficiency * (1 - 0.082 * offset * offset);
      const speed = speedInput * efficiency;
      // Rigid-impulse squirt (Cross 2008): the gripping tip must accelerate
      // sideways with the contact point, and the shaft's effective end mass
      // resists that, deflecting the ball opposite to the English:
      //   tan α = (5/2)(b/R)c / (1 + (5/2)c² + M/mₑ),  c = √(1 − (b/R)²).
      // Squirt is nearly speed-independent, matching Dr. Dave's measurements.
      const contactCos = Math.sqrt(Math.max(0.14, 1 - offset * offset));
      const massRatio = ballMass / spec.effectiveEndMass;
      const squirt = -Math.atan(
        (2.5 * tipX * contactCos) / (1 + 2.5 * contactCos * contactCos + massRatio),
      );
      const cs = Math.cos(squirt), ss = Math.sin(squirt);
      direction = { x: direction.x * cs - direction.z * ss, z: direction.x * ss + direction.z * cs };
      const angularScale = 2.5 * speed * 0.84 * spec.spinEfficiency * tipSpec.spinTransfer / R;
      const sideTorque = tipX * angularScale * 0.94;
      // Vertical tip offset always torques about the horizontal side axis, so
      // follow/draw take no cos(elevation) factor; the side-spin axis tilts
      // with the cue, which is what later bends elevated-English shots.
      const omega = {
        x: direction.z * tipY * angularScale + direction.x * sideTorque * Math.sin(elevation),
        y: sideTorque * Math.cos(elevation),
        z: -direction.x * tipY * angularScale + direction.z * sideTorque * Math.sin(elevation),
      };
      // The impulse points forward-and-down along the cue; the slate absorbs
      // the vertical part, so only the horizontal component survives as speed.
      const horizontalSpeed = speed * Math.cos(elevation);
      const requestedOffset = Math.hypot(requestedTipX, requestedTipY);
      const miscueMargin = safeOffset - requestedOffset;
      const aimAllowancePerMetre = Math.tan(Math.abs(squirt));
      return {
        spec, tipSpec, direction, speed, speedInput, horizontalSpeed, tipX, tipY, elevation, squirt, omega,
        safeOffset, frictionContactLimit, miscueMargin, aimAllowancePerMetre,
      };
    }

    onEvent(handler) { this.eventHandler = handler; }

    emit(event) {
      if (this.eventHandler) this.eventHandler({ ...event, worldTime: this.time, shotTime: this.shotTime });
    }

    getCueBall() { return this.balls.find((b) => b.id === 'cue'); }
    getBall(id) { return this.balls.find((b) => b.id === id); }
    activeBalls() { return this.balls.filter((b) => !b.pocketed); }

    isMoving() {
      return this.balls.some((b) => !b.pocketed && (Math.hypot(b.vel.x, b.vel.z) > 0.005 || Math.hypot(b.omega.x, b.omega.y, b.omega.z) > 0.85));
    }

    strike(options) {
      const cue = this.getCueBall();
      if (!cue || cue.pocketed || this.isMoving()) return false;
      const impact = this.cueImpactMetrics(options);
      cue.vel.x = impact.direction.x * impact.horizontalSpeed;
      cue.vel.z = impact.direction.z * impact.horizontalSpeed;
      cue.omega.x += impact.omega.x;
      cue.omega.y += impact.omega.y;
      cue.omega.z += impact.omega.z;
      // Elevation tilts the side-spin axis in cueImpactMetrics.  The normal
      // cloth-slip solver then produces swerve directly, so no scripted curve
      // force is needed for ordinary elevated-English shots.
      cue.state = 'sliding';
      cue.lastSpeed = impact.horizontalSpeed;
      this.inShot = true;
      this.shotTime = 0;
      this.lastCueMetrics = {
        ...impact, spec: { ...impact.spec }, tipSpec: { ...impact.tipSpec },
        omega: { ...impact.omega }, direction: { ...impact.direction },
      };
      this.emit({
        type: 'cue', ballId: cue.id, position: { ...cue.pos }, speed: impact.horizontalSpeed,
        tipX: impact.tipX, tipY: impact.tipY, elevation: impact.elevation,
        cueType: impact.spec.id, tipType: impact.tipSpec.id, squirt: impact.squirt,
      });
      return true;
    }

    step(dt) {
      if (!(dt > 0)) return;
      this.time += dt;
      if (this.inShot) this.shotTime += dt;

      for (const ball of this.balls) {
        if (ball.pocketed) {
          ball.sinkTime += dt;
          if (ball.sinkTarget) {
            ball.pos.x += ball.vel.x * dt;
            ball.pos.z += ball.vel.z * dt;
            const pull = 1 - Math.exp(-9.5 * dt);
            ball.pos.x += (ball.sinkTarget.x - ball.pos.x) * pull;
            ball.pos.z += (ball.sinkTarget.z - ball.pos.z) * pull;
            const damping = Math.exp(-7.5 * dt);
            ball.vel.x *= damping; ball.vel.z *= damping;
            Quat.integrate(ball.rotation, ball.omega, dt);
            ball.omega.x *= damping; ball.omega.y *= damping; ball.omega.z *= damping;
          }
          ball.sinkDepth = Math.min(ball.radius * 3.2, ball.sinkDepth + dt * ball.radius * 4.5);
          continue;
        }
        this.evolveBall(ball, dt);
        ball.pos.x += ball.vel.x * dt;
        ball.pos.z += ball.vel.z * dt;
        Quat.integrate(ball.rotation, ball.omega, dt);
      }

      // Two sequential impulse passes make clustered racks stable at a fixed 300 Hz.
      for (let pass = 0; pass < 2; pass += 1) {
        this.resolveBallPairs();
        for (const ball of this.balls) {
          if (!ball.pocketed) this.resolveCushions(ball);
        }
      }

      for (const ball of this.balls) if (!ball.pocketed) this.checkPocket(ball);
      if (this.inShot && !this.isMoving()) {
        this.inShot = false;
        this.emit({ type: 'settled', shotTime: this.shotTime });
      }
    }

    evolveBall(ball, dt) {
      const R = ball.radius;
      const speed = Math.hypot(ball.vel.x, ball.vel.z);
      const slipX = ball.vel.x + ball.omega.z * R;
      const slipZ = ball.vel.z - ball.omega.x * R;
      const slip = Math.hypot(slipX, slipZ);
      const nap = this.table.clothNap || { x: 1, z: 0 };
      const napProjection = speed > 1e-8 ? (ball.vel.x * nap.x + ball.vel.z * nap.z) / speed : 0;
      const clothResistance = 1 - (this.table.clothNapStrength || 0) * napProjection;

      if (slip > 0.012) {
        // Contact-slip decays 3.5× as fast as the centre velocity because friction also spins the sphere.
        const acceleration = Math.min(this.params.muSlide * G * clothResistance, slip / (3.5 * dt));
        const ax = -acceleration * slipX / slip;
        const az = -acceleration * slipZ / slip;
        ball.vel.x += ax * dt;
        ball.vel.z += az * dt;
        ball.omega.x += -(2.5 / R) * az * dt;
        ball.omega.z += (2.5 / R) * ax * dt;
        ball.state = 'sliding';
      } else if (speed > 0.004) {
        const deceleration = this.params.muRoll * G * clothResistance;
        const dv = Math.min(speed, deceleration * dt);
        ball.vel.x -= ball.vel.x / speed * dv;
        ball.vel.z -= ball.vel.z / speed * dv;
        ball.omega.x = ball.vel.z / R;
        ball.omega.z = -ball.vel.x / R;
        ball.state = 'rolling';
      }

      const spin = Math.abs(ball.omega.y);
      if (spin > 0) {
        // Fast spin presents a larger moving contact patch; the nonlinear term also prevents
        // unrealistic, minute-long stationary spin after extreme break-speed English.
        const baseSpinDeceleration = 2.5 * this.params.muSpin * G / R;
        const spinDeceleration = baseSpinDeceleration * (1 + Math.min(2.4, spin / 82));
        ball.omega.y = Math.sign(ball.omega.y) * Math.max(0, spin - spinDeceleration * dt);
      }

      const newSpeed = Math.hypot(ball.vel.x, ball.vel.z);
      const newSlip = Math.hypot(ball.vel.x + ball.omega.z * R, ball.vel.z - ball.omega.x * R);
      if (newSpeed < 0.0055 && newSlip < 0.016) {
        ball.vel.x = 0; ball.vel.z = 0; ball.omega.x = 0; ball.omega.z = 0;
        if (Math.abs(ball.omega.y) < 0.85) ball.omega.y = 0;
        ball.state = Math.abs(ball.omega.y) > 0 ? 'spinning' : 'stationary';
      }
      ball.lastSpeed = newSpeed;
    }

    resolveBallPairs() {
      const balls = this.balls;
      for (let i = 0; i < balls.length; i += 1) {
        const a = balls[i];
        if (a.pocketed) continue;
        for (let j = i + 1; j < balls.length; j += 1) {
          const b = balls[j];
          if (b.pocketed) continue;
          const dx = b.pos.x - a.pos.x;
          const dz = b.pos.z - a.pos.z;
          const minDistance = a.radius + b.radius;
          const distanceSq = dx * dx + dz * dz;
          if (distanceSq >= minDistance * minDistance) continue;
          let distance = Math.sqrt(distanceSq);
          let nx = 1, nz = 0;
          if (distance > 1e-8) { nx = dx / distance; nz = dz / distance; }
          else distance = minDistance;

          const invA = 1 / a.mass, invB = 1 / b.mass;
          const correction = Math.max(0, minDistance - distance + 1e-5) / (invA + invB) * 0.76;
          a.pos.x -= nx * correction * invA; a.pos.z -= nz * correction * invA;
          b.pos.x += nx * correction * invB; b.pos.z += nz * correction * invB;

          const relNormal = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
          if (relNormal >= -1e-5) continue;
          const normalImpulse = -(1 + this.params.restitutionBall) * relNormal / (invA + invB);

          // Full contact-point slip: the equator contact arms are ±R·n̂, so the
          // relative surface velocity has an in-plane part (side spin + cut)
          // and a vertical part (follow/draw rubbing).  Solving both in one
          // friction cone is what makes a rolling cue ball throw less than a
          // stun shot and lets follow/draw transfer between balls.
          const rA = a.radius, rB = b.radius;
          const tx = -nz, tz = nx;
          const surfAX = a.vel.x + a.omega.y * nz * rA;
          const surfAZ = a.vel.z - a.omega.y * nx * rA;
          const surfAY = (a.omega.z * nx - a.omega.x * nz) * rA;
          const surfBX = b.vel.x - b.omega.y * nz * rB;
          const surfBZ = b.vel.z + b.omega.y * nx * rB;
          const surfBY = -(b.omega.z * nx - b.omega.x * nz) * rB;
          const slipT = (surfBX - surfAX) * tx + (surfBZ - surfAZ) * tz;
          const slipY = surfBY - surfAY;
          const slipSpeed = Math.hypot(slipT, slipY);
          const mu = ballBallFriction(slipSpeed);

          const denomT = invA + invB + rA * rA / a.inertia + rB * rB / b.inertia;
          // The slate carries the vertical linear reaction, so vertical rubbing
          // only exchanges spin (same approximation as the cushion solver).
          const denomY = rA * rA / a.inertia + rB * rB / b.inertia;
          let impulseT = -slipT / denomT;
          let impulseY = -slipY / denomY;
          const rawFriction = Math.hypot(impulseT, impulseY);
          const frictionLimit = mu * normalImpulse;
          if (rawFriction > frictionLimit && rawFriction > 1e-12) {
            const scale = frictionLimit / rawFriction;
            impulseT *= scale; impulseY *= scale;
          }

          const impulseX = normalImpulse * nx + impulseT * tx;
          const impulseZ = normalImpulse * nz + impulseT * tz;
          a.vel.x -= impulseX * invA; a.vel.z -= impulseZ * invA;
          b.vel.x += impulseX * invB; b.vel.z += impulseZ * invB;

          // τ = (±R n̂) × f with friction f = (impulseT·t̂ + impulseY·ŷ); the
          // normal impulse passes through both centres and adds no torque.
          const fX = impulseT * tx, fY = impulseY, fZ = impulseT * tz;
          const crossX = -nz * fY, crossY = nz * fX - nx * fZ, crossZ = nx * fY;
          a.omega.x -= crossX * rA / a.inertia;
          a.omega.y -= crossY * rA / a.inertia;
          a.omega.z -= crossZ * rA / a.inertia;
          b.omega.x -= crossX * rB / b.inertia;
          b.omega.y -= crossY * rB / b.inertia;
          b.omega.z -= crossZ * rB / b.inertia;
          a.state = b.state = 'sliding';

          const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
          const previous = this.collisionCooldown.get(key) || -1;
          if (this.time - previous > 0.028) {
            this.collisionCooldown.set(key, this.time);
            this.emit({
              type: 'ball-ball', aId: a.id, bId: b.id, impulse: normalImpulse,
              speed: Math.abs(relNormal), position: { x: a.pos.x + nx * a.radius, z: a.pos.z + nz * a.radius },
              normal: { x: nx, z: nz },
            });
          }
        }
      }
    }

    resolveCushions(ball) {
      const R = ball.radius;
      for (const segment of this.table.cushions) {
        const coordinate = segment.axis === 'x' ? ball.pos.x : ball.pos.z;
        // The round jaw owns the mouth side of the common tangent.  Extending
        // the plane past this point causes a visible normal discontinuity and
        // can apply two conflicting impulses to a slow grazing ball.
        if (coordinate < segment.min - 1e-6 || coordinate > segment.max + 1e-6) continue;
        const bx = segment.axis === 'x' ? ball.pos.x : segment.value;
        const bz = segment.axis === 'x' ? segment.value : ball.pos.z;
        const signedDistance = (ball.pos.x - bx) * segment.normal.x + (ball.pos.z - bz) * segment.normal.z;
        if (signedDistance < R) {
          ball.pos.x += segment.normal.x * (R - signedDistance + 1e-5);
          ball.pos.z += segment.normal.z * (R - signedDistance + 1e-5);
          this.applyCushionImpulse(ball, segment.normal, segment.id);
        }
      }

      // Rounded jaw endpoints prevent balls from clipping through pocket corners.
      for (const jaw of this.table.jaws) {
        const dx = ball.pos.x - jaw.x, dz = ball.pos.z - jaw.z;
        const distanceSq = dx * dx + dz * dz;
        const contactRadius = R + (jaw.radius || 0);
        if (distanceSq >= contactRadius * contactRadius || distanceSq < 1e-12) continue;
        const distance = Math.sqrt(distanceSq);
        const normal = { x: dx / distance, z: dz / distance };
        ball.pos.x += normal.x * (contactRadius - distance + 1e-5);
        ball.pos.z += normal.z * (contactRadius - distance + 1e-5);
        this.applyCushionImpulse(ball, normal, jaw.id || 'jaw');
      }
    }

    applyCushionImpulse(ball, normal, cushionId) {
      const centreNormalSpeed = ball.vel.x * normal.x + ball.vel.z * normal.z;
      if (centreNormalSpeed >= -1e-5) return;

      const R = ball.radius;
      const tx = -normal.z, tz = normal.x;
      // The cushion nose sits above the ball centre.  The raised contact point is
      // what lets follow/draw spin participate in the same impulse as side spin.
      const contactHeight = clamp(this.table.cushionContactHeight - R, R * 0.10, R * 0.49);
      const horizontalReach = Math.sqrt(Math.max(R * R - contactHeight * contactHeight, R * R * 0.72));
      const contactArm = { x: -normal.x * horizontalReach, y: contactHeight, z: -normal.z * horizontalReach };
      const normal3 = { x: normal.x, y: 0, z: normal.z };
      const tangent3 = { x: tx, y: 0, z: tz };
      const up3 = { x: 0, y: 1, z: 0 };
      const velocity3 = { x: ball.vel.x, y: 0, z: ball.vel.z };
      const contactVelocity = V3.add(velocity3, V3.cross(ball.omega, contactArm));
      const rotationalNormalSpeed = V3.dot(contactVelocity, normal3) - centreNormalSpeed;
      const linearTangentSpeed = ball.vel.x * tx + ball.vel.z * tz;
      const sideSurfaceSpeed = ball.omega.y * horizontalReach;

      // Mathavan's measured behaviour shows that topspin can increase rebound
      // speed while draw reduces it.  This bounded correction represents the
      // rubber/slate coupled contact without requiring a soft-body ODE solver.
      const followRatio = clamp(-rotationalNormalSpeed / Math.max(-centreNormalSpeed, 0.16), -0.75, 0.75);
      const speedLoss = 0.014 * clamp((-centreNormalSpeed - 1.5) / 4.5, 0, 1);
      const lowSpeedBlend = clamp((-centreNormalSpeed - 0.012) / 0.060, 0, 1);
      const restitution = clamp(this.params.restitutionCushion + 0.13 * followRatio - speedLoss, 0.64, 0.91) * lowSpeedBlend;
      const normalImpulse = -(1 + restitution) * centreNormalSpeed * ball.mass;

      // The slate reaction carries the offset part of the normal load.  Applying
      // the full horizontal impulse at the raised point would double-count that
      // support and create rotational energy, so the normal component acts on
      // the centre; the raised arm is retained for the two friction components.
      ball.vel.x += normal.x * normalImpulse / ball.mass;
      ball.vel.z += normal.z * normalImpulse / ball.mass;

      // Solve both cushion-plane tangent directions.  If the unconstrained
      // impulse lies inside the Coulomb cone the patch sticks (the soft-English
      // region); otherwise it slides at the friction limit.
      const afterNormalVelocity = V3.add(
        { x: ball.vel.x, y: 0, z: ball.vel.z },
        V3.cross(ball.omega, contactArm),
      );
      const tangentSpeed = V3.dot(afterNormalVelocity, tangent3);
      const verticalSpeed = V3.dot(afterNormalVelocity, up3);
      const tangentArm = V3.cross(contactArm, tangent3);
      const verticalArm = V3.cross(contactArm, up3);
      const tangentDenom = 1 / ball.mass + V3.dot(tangentArm, tangentArm) / ball.inertia;
      const verticalDenom = 1 / ball.mass + V3.dot(verticalArm, verticalArm) / ball.inertia;
      let tangentImpulse = -tangentSpeed / tangentDenom;
      let verticalImpulse = -verticalSpeed / verticalDenom * 0.82;
      const rawFriction = Math.hypot(tangentImpulse, verticalImpulse);
      const frictionLimit = this.params.frictionCushion * normalImpulse;
      const frictionMode = rawFriction <= frictionLimit + 1e-9 ? 'stick' : 'slide';
      if (rawFriction > frictionLimit && rawFriction > 1e-12) {
        const scale = frictionLimit / rawFriction;
        tangentImpulse *= scale; verticalImpulse *= scale;
      }
      const frictionImpulse = {
        x: tangent3.x * tangentImpulse,
        y: verticalImpulse,
        z: tangent3.z * tangentImpulse,
      };
      ball.vel.x += frictionImpulse.x / ball.mass;
      ball.vel.z += frictionImpulse.z / ball.mass;
      // The slate supplies the opposing vertical reaction, so vertical cushion
      // friction changes spin without allowing the ball centre to sink into it.
      const frictionTorque = V3.cross(contactArm, frictionImpulse);
      ball.omega.x += frictionTorque.x / ball.inertia;
      ball.omega.y += frictionTorque.y / ball.inertia;
      ball.omega.z += frictionTorque.z / ball.inertia;
      ball.state = 'sliding';

      let english = 'neutral';
      if (Math.abs(sideSurfaceSpeed) > 0.035) {
        if (Math.abs(linearTangentSpeed) < 0.045) english = 'side';
        else english = linearTangentSpeed * sideSurfaceSpeed < 0 ? 'running' : 'reverse';
      }
      const reboundNormal = ball.vel.x * normal.x + ball.vel.z * normal.z;
      const reboundTangent = ball.vel.x * tx + ball.vel.z * tz;
      const incidentAngle = Math.atan2(Math.abs(linearTangentSpeed), Math.max(1e-7, -centreNormalSpeed)) * 180 / Math.PI;
      const reboundAngle = Math.atan2(Math.abs(reboundTangent), Math.max(1e-7, reboundNormal)) * 180 / Math.PI;
      const event = {
        type: 'cushion', ballId: ball.id, cushionId, speed: Math.abs(centreNormalSpeed),
        impulse: normalImpulse, position: { ...ball.pos }, normal: { ...normal },
        english, frictionMode, followRatio, restitution, incidentAngle, reboundAngle,
        angleChange: reboundAngle - incidentAngle,
        incoming: { x: velocity3.x, z: velocity3.z },
        outgoing: { x: ball.vel.x, z: ball.vel.z },
      };
      this.lastCushionEvent = event;

      const key = `rail:${ball.id}:${cushionId}`;
      const previous = this.collisionCooldown.get(key) || -1;
      if (this.time - previous > 0.035) {
        this.collisionCooldown.set(key, this.time);
        this.emit(event);
      }
    }

    captureBall(ball, pocket) {
      ball.pocketed = true;
      ball.pocketId = pocket.id;
      ball.sinkTime = 0;
      ball.sinkDepth = 0;
      ball.sinkTarget = { x: pocket.x, z: pocket.z };
      ball.vel.x *= 0.42; ball.vel.z *= 0.42;
      ball.omega.x *= 0.46; ball.omega.y *= 0.46; ball.omega.z *= 0.46;
      ball.state = 'pocketed';
      this.emit({ type: 'pocket', ballId: ball.id, pocketId: pocket.id, speed: ball.lastSpeed, position: { x: pocket.x, z: pocket.z } });
    }

    checkPocket(ball) {
      if (ball.pocketed) return;
      for (const pocket of this.table.pockets) {
        const distance = Math.hypot(ball.pos.x - pocket.x, ball.pos.z - pocket.z);
        const capture = ball.radius * (pocket.type === 'corner' ? this.table.captureCorner : this.table.captureSide);
        const fromThroat = pocket.throat
          ? { x: ball.pos.x - pocket.throat.x, z: ball.pos.z - pocket.throat.z }
          : { x: 0, z: 0 };
        const depth = pocket.outward ? V2.dot(fromThroat, pocket.outward) : 0;
        const crossedMouth = !pocket.outward || depth >= (pocket.minCaptureDepth || 0);
        if (distance < capture && crossedMouth) {
          this.captureBall(ball, pocket);
          return;
        }
      }

      // Safety capture below the outer rail; physically this region is the pocket liner.
      const hx = this.table.width / 2 + this.table.railWidth * 0.7;
      const hz = this.table.height / 2 + this.table.railWidth * 0.7;
      if (Math.abs(ball.pos.x) > hx || Math.abs(ball.pos.z) > hz) {
        const pocket = this.table.pockets.reduce((best, p) => V2.distance(ball.pos, p) < V2.distance(ball.pos, best) ? p : best, this.table.pockets[0]);
        this.captureBall(ball, pocket);
      }
    }

    findAimContact(direction) {
      const cue = this.getCueBall();
      if (!cue || cue.pocketed) return null;
      const d = V2.normalize(direction);
      let best = null;
      for (const ball of this.balls) {
        if (ball.id === 'cue' || ball.pocketed) continue;
        const mx = cue.pos.x - ball.pos.x, mz = cue.pos.z - ball.pos.z;
        const radius = cue.radius + ball.radius;
        const b = mx * d.x + mz * d.z;
        const c = mx * mx + mz * mz - radius * radius;
        if (c > 0 && b > 0) continue;
        const discriminant = b * b - c;
        if (discriminant < 0) continue;
        const t = -b - Math.sqrt(discriminant);
        if (t < 0 || (best && t >= best.distance)) continue;
        const ghost = { x: cue.pos.x + d.x * t, z: cue.pos.z + d.z * t };
        const normal = V2.normalize(V2.sub(ball.pos, ghost));
        const dot = clamp(V2.dot(d, normal), -1, 1);
        best = { ball, distance: t, ghost, normal, cutAngle: Math.acos(dot) * 180 / Math.PI };
      }
      return best;
    }

    predictShot(options, maxTime = 5.5) {
      const clone = this.clone(true);
      const events = [];
      clone.onEvent((event) => events.push(event));
      if (!clone.strike(options)) return { paths: new Map(), events: [], firstHit: null, cueDistance: 0, duration: 0 };
      const initial = new Map(clone.balls.map((b) => [b.id, { ...b.pos }]));
      const paths = new Map(clone.balls.map((b) => [b.id, [{ ...b.pos, t: 0 }]]));
      const dt = 1 / 300;
      const sampleEvery = 5;
      let step = 0;
      let stillFrames = 0;
      while (clone.shotTime < maxTime && step < maxTime / dt) {
        clone.step(dt);
        if (step % sampleEvery === 0) {
          clone.balls.forEach((ball) => {
            const path = paths.get(ball.id);
            const start = initial.get(ball.id);
            const moved = Math.hypot(ball.pos.x - start.x, ball.pos.z - start.z) > 0.0015;
            if ((moved || path.length > 1 || ball.id === 'cue') && path.length < 420) {
              path.push({ x: ball.pos.x, z: ball.pos.z, t: clone.shotTime, pocketed: ball.pocketed, sink: ball.sinkDepth });
            }
          });
        }
        if (!clone.isMoving()) stillFrames += 1; else stillFrames = 0;
        if (stillFrames > 5) break;
        step += 1;
      }
      for (const [id, path] of [...paths]) if (path.length <= 1 && id !== 'cue') paths.delete(id);
      const firstHit = events.find((e) => e.type === 'ball-ball' && (e.aId === 'cue' || e.bId === 'cue')) || null;
      const cuePath = paths.get('cue') || [];
      let cueDistance = 0;
      for (let i = 1; i < cuePath.length; i += 1) cueDistance += Math.hypot(cuePath[i].x - cuePath[i - 1].x, cuePath[i].z - cuePath[i - 1].z);
      return { paths, events, firstHit, cueDistance, duration: clone.shotTime };
    }

    totalEnergy() {
      return this.balls.reduce((sum, ball) => {
        if (ball.pocketed) return sum;
        const linear = 0.5 * ball.mass * (ball.vel.x * ball.vel.x + ball.vel.z * ball.vel.z);
        const angular = 0.5 * ball.inertia * (ball.omega.x * ball.omega.x + ball.omega.y * ball.omega.y + ball.omega.z * ball.omega.z);
        return sum + linear + angular;
      }, 0);
    }

    snapshot() {
      return {
        mode: this.mode, params: { ...this.params }, clothPreset: this.clothPreset,
        cueType: this.cueType, tipType: this.tipType,
        balls: this.balls.map(cloneBall), time: this.time, shotTime: this.shotTime, inShot: this.inShot,
      };
    }

    restore(snapshot) {
      if (snapshot.mode !== this.mode) this.setMode(snapshot.mode);
      this.params = { ...snapshot.params };
      this.clothPreset = snapshot.clothPreset;
      this.cueType = CUE_SPECS[snapshot.cueType] ? snapshot.cueType : this.cueType;
      this.tipType = TIP_PRESETS[snapshot.tipType] ? snapshot.tipType : this.tipType;
      this.balls = snapshot.balls.map(cloneBall);
      this.time = snapshot.time;
      this.shotTime = snapshot.shotTime;
      this.inShot = snapshot.inShot;
      this.lastCushionEvent = null;
      this.collisionCooldown.clear();
    }

    clone(silent = true) {
      const copy = Object.create(PhysicsWorld.prototype);
      copy.silent = silent;
      copy.eventHandler = null;
      copy.time = this.time;
      copy.shotTime = 0;
      copy.inShot = false;
      copy.mode = this.mode;
      copy.cueType = this.cueType;
      copy.tipType = this.tipType;
      copy.params = { ...this.params };
      copy.table = copyTable(this.table);
      copy.clothPreset = this.clothPreset;
      copy.balls = this.balls.map(cloneBall);
      copy.collisionCooldown = new Map();
      copy.lastCueMetrics = this.lastCueMetrics ? { ...this.lastCueMetrics } : null;
      copy.lastCushionEvent = null;
      return copy;
    }

    respotCue() {
      const cue = this.getCueBall();
      if (!cue) return;
      const preferred = this.mode === 'snooker' ? { x: this.table.cueStart, z: -0.22 } : { x: this.table.cueStart, z: 0 };
      this.respotBall(cue, preferred);
    }

    respotBall(ballOrId, preferred) {
      const ball = typeof ballOrId === 'string' ? this.getBall(ballOrId) : ballOrId;
      if (!ball) return false;
      const R = ball.radius;
      let found = null;
      for (let ring = 0; ring < 16 && !found; ring += 1) {
        const count = ring === 0 ? 1 : ring * 8;
        for (let i = 0; i < count; i += 1) {
          const angle = count === 1 ? 0 : i / count * Math.PI * 2;
          const candidate = { x: preferred.x + Math.cos(angle) * ring * R * 0.38, z: preferred.z + Math.sin(angle) * ring * R * 0.38 };
          const inBounds = Math.abs(candidate.x) < this.table.width / 2 - R && Math.abs(candidate.z) < this.table.height / 2 - R;
          const clear = this.balls.every((other) => other === ball || other.pocketed || V2.distance(candidate, other.pos) > R + other.radius + 0.001);
          if (inBounds && clear) { found = candidate; break; }
        }
      }
      if (!found) return false;
      ball.pos = found; ball.vel = { x: 0, z: 0 }; ball.omega = { x: 0, y: 0, z: 0 };
      ball.rotation = Quat.identity(); ball.pocketed = false; ball.pocketId = null; ball.sinkTime = 0; ball.sinkDepth = 0; ball.sinkTarget = null; ball.state = 'stationary';
      return true;
    }
  }

  global.BilliardsPhysics = {
    PhysicsWorld, POOL_PARAMS, CHINESE_PARAMS, SNOOKER_PARAMS, CUE_SPECS, TIP_PRESETS,
    TABLES, POOL_COLORS, SNOOKER_COLORS,
  };
})(window);
