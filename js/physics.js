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
  // maxOffset is the tip-separation bound of TP A-30 (x/R ≈ 0.45–0.55, tighter
  // for the heavier cue); the chalk-friction cone usually binds first.
  const CUE_SPECS = Object.freeze({
    small: Object.freeze({
      id: 'small', label: '小头杆', detail: '中式低偏移木前节', tipDiameter: 0.010, shaftRadius: 0.0061,
      cueMass: 0.515, effectiveEndMass: 0.0052, spinEfficiency: 0.98,
      maxOffset: 0.54, powerEfficiency: 0.985,
    }),
    large: Object.freeze({
      id: 'large', label: '大头杆', detail: '高性能低偏移前节', tipDiameter: 0.0125, shaftRadius: 0.0073,
      cueMass: 0.535, effectiveEndMass: 0.0064, spinEfficiency: 0.96,
      maxOffset: 0.52, powerEfficiency: 1.0,
    }),
  });

  // Alciatore's measured ball-ball sliding friction falls off exponentially with
  // contact slip speed; this is what makes soft-speed shots throw the most.
  function ballBallFriction(slipSpeed) {
    return 0.009951 + 0.108 * Math.exp(-1.088 * slipSpeed);
  }

  // Rubber-nose compliance (Hunt-Crossley): F = k·δ^{3/2}·(1 + χ·δ̇).
  // The stiffness sets the ~1 ms contact and millimetre-scale compression;
  // the damping reference is scaled per table so a 2.5 m/s stun impact
  // rebounds at that table's restitutionCushion, after which restitution
  // falling with speed emerges from the model instead of a hand curve.
  const CUSHION_STIFFNESS = 1.5e7;   // N·m^-1.5
  // Rubber's own loss channel; calibrated so that together with the loaded
  // slate-friction contact (Mathavan 2010) a 2.5 m/s stun impact rebounds at
  // the table's restitutionCushion.
  const CUSHION_DAMPING_REF = 0.085; // s/m at restitution 0.82
  // Contact sub-grid ceiling; the effective grid is min(this, dt), so the
  // refined steps used in slow motion sharpen the contact integration too.
  const CUSHION_SUBSTEP = 1 / 14400;

  // Tip curvature radius (nickel-dome leather, ~10 mm).  The tip is a curved
  // surface: a cue axis aimed at offset h on the ball face lands its contact
  // point at only b = h·R/(R+ρ), and the miscue limit is a property of b.
  const TIP_CURVATURE_RADIUS = 0.0102;

  // safeOffset is the tip-shape/hold bound; combined with the chalk-friction
  // cone it puts the miscue limit at b/R ≈ 0.50–0.54, matching Dr Dave's
  // measured "about half the radius" boundary (robust across chalk brands).
  const TIP_PRESETS = Object.freeze({
    soft: Object.freeze({
      id: 'soft', label: '软皮头', friction: 0.72,
      energyEfficiency: 0.982, spinTransfer: 1.015, safeOffset: 0.55,
    }),
    medium: Object.freeze({
      id: 'medium', label: '中等皮头', friction: 0.68,
      energyEfficiency: 0.990, spinTransfer: 1.0, safeOffset: 0.53,
    }),
    hard: Object.freeze({
      id: 'hard', label: '硬皮头', friction: 0.63,
      energyEfficiency: 0.996, spinTransfer: 0.975, safeOffset: 0.50,
    }),
  });

  const TABLES = Object.freeze({
    chinese: {
      width: 2.54,
      height: 1.26,
      railWidth: 0.142,
      pocketRadius: 0.050,
      // Joy-style mouths are quoted at the narrowest point between the two jaw
      // arcs (82–85 mm on tournament tables).  CBSA equipment rules add the
      // relative constraint that the middle pocket is 15 mm wider than the
      // corner, which is what makes middle-pocket rail shots playable at all.
      cornerMouth: 0.085,
      sideMouth: 0.100,
      jawRadius: 0.028,
      cushionContactHeight: 0.037,
      cushionTopHeight: 0.042,
      captureCorner: 1.45,
      captureSide: 1.05,
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
      // WPA equipment specification: corner mouth 4.5 in, side mouth 5.0 in
      // (measured tip to tip between the cushion noses), corner facings at
      // 142° to the rail and side facings at 104°.
      cornerMouth: 0.1143,
      sideMouth: 0.127,
      cornerFacingAngle: 142,
      sideFacingAngle: 104,
      cornerFacingLength: 0.055,
      sideFacingLength: 0.042,
      jawRadius: 0.010,
      cushionContactHeight: 0.0363,
      cushionTopHeight: 0.048,
      captureCorner: 1.56,
      captureSide: 1.24,
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
      // WPBSA-style templates: rounded jaws, ~86 mm corner fall and a wider
      // straight-cut middle pocket (~103 mm); both are template-level
      // approximations since the official spec is drawing-based.
      cornerMouth: 0.086,
      sideMouth: 0.103,
      jawRadius: 0.024,
      cushionContactHeight: 0.034,
      cushionTopHeight: 0.039,
      captureCorner: 1.45,
      captureSide: 1.12,
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

  // Dynaspheres Palladium-inspired palette, sampled from the manufacturer's
  // product photography: golden amber, azure, lavender, vermilion, spruce
  // teal and caramel brown on warm ivory resin.
  const PALLADIUM_COLORS = {
    1: '#f2ae2c', 2: '#1263a6', 3: '#df3339', 4: '#8a5b94',
    5: '#e0522b', 6: '#0e5a4a', 7: '#7c3a1b', 8: '#131114',
    9: '#f2ae2c', 10: '#1263a6', 11: '#df3339', 12: '#8a5b94',
    13: '#e0522b', 14: '#0e5a4a', 15: '#7c3a1b',
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
      facings: (table.facings || []).map((f) => ({
        ...f, p0: { ...f.p0 }, p1: { ...f.p1 }, normal: { ...f.normal },
      })),
    };
  }

  function configureTable(kind) {
    const base = TABLES[kind];
    const table = { ...base, clothNap: { ...base.clothNap } };
    const flatFacings = Boolean(table.cornerFacingAngle);
    if (flatFacings) {
      // American pockets: the mouth is measured tip-to-tip between the sharp
      // cushion-nose points, and angled flat facings run behind them.
      table.cornerGap = table.cornerMouth / Math.sqrt(2);
      table.sideGap = table.sideMouth / 2;
    } else {
      // A jaw circle is mounted one radius behind its rail face.  This makes
      // its inner arc tangent to the straight cushion instead of bulging into
      // it.  The corner formula measures the requested mouth along the line
      // joining the two arc centres; the side-pocket centres share one line.
      table.cornerGap = (table.cornerMouth + 2 * table.jawRadius) / Math.sqrt(2) - table.jawRadius;
      table.sideGap = (table.sideMouth + 2 * table.jawRadius) / 2;
    }
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
    table.jaws = flatFacings ? [] : table.cushions.flatMap((s) => {
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

    // WPA-style flat pocket facings: from each cushion end, a straight wall
    // deflects away from the rail line by (180° − facingAngle), so a corner
    // facing meets its rail at 142° and a side facing at 104°.  These walls
    // are what a rattling ball works against on tight cuts.
    table.facings = [];
    if (flatFacings) {
      table.cushions.forEach((s) => {
        [{ end: s.min, sign: -1 }, { end: s.max, sign: 1 }].forEach(({ end, sign }) => {
          const point = s.axis === 'x' ? { x: end, z: s.value } : { x: s.value, z: end };
          const along = s.axis === 'x' ? { x: sign, z: 0 } : { x: 0, z: sign };
          const isSide = Math.abs(Math.abs(end) - table.sideGap) < 1e-9;
          const angle = (isSide ? table.sideFacingAngle : table.cornerFacingAngle) * Math.PI / 180;
          const deflect = Math.PI - angle;
          const c = Math.cos(deflect), d = Math.sin(deflect);
          const direction = { x: along.x * c - s.normal.x * d, z: along.z * c - s.normal.z * d };
          const normal = { x: s.normal.x * c + along.x * d, z: s.normal.z * c + along.z * d };
          const length = isSide ? table.sideFacingLength : table.cornerFacingLength;
          table.facings.push({
            p0: point,
            p1: { x: point.x + direction.x * length, z: point.z + direction.z * length },
            normal,
            pocketType: isSide ? 'side' : 'corner',
            id: `facing-${s.id}-${sign > 0 ? 'max' : 'min'}`,
          });
        });
      });
    }
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
      posY: 0,
      velY: 0,
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
      railContact: null,
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
      railContact: ball.railContact ? { ...ball.railContact } : null,
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
      // The chalked tip grips only while the contact normal stays inside the
      // friction cone: at offset b the normal is tilted by asin(b/R), so the
      // no-slip boundary is b/R = μ/√(1+μ²) — 0.53–0.58 for chalked leather
      // (Cross 2008: μ ≈ 0.577 needed at b/R = 0.5).  Together with the tip
      // shape/separation bounds this puts the miscue limit near the measured
      // "half the radius", instead of the ~0.9R a pure geometry cap allows.
      const frictionContactLimit = tipSpec.friction / Math.sqrt(1 + tipSpec.friction * tipSpec.friction);
      // Those limits live at the CONTACT point b, but tipX/tipY — the UI
      // marker, the presets and the URL params — are AIM units: where the cue
      // axis points on the ball face.  The curved tip lands its contact at
      // b = h·R/(R+ρ), so the aim-unit boundary is the contact limit divided
      // by that compression: ≈ 0.68–0.75 R before the tip skids off, exactly
      // like a real cue, while the measured b/R ≈ 0.5 physics stays put.  The
      // spin/squirt constants are calibrated end-to-end in aim units already.
      const contactScale = R / (R + TIP_CURVATURE_RADIUS);
      const safeOffset = Math.min(0.88, Math.min(spec.maxOffset, tipSpec.safeOffset, frictionContactLimit) / contactScale);
      let tipX = clamp(requestedTipX, -safeOffset, safeOffset);
      let tipY = clamp(requestedTipY, -safeOffset, safeOffset);
      const offsetMagnitude = Math.hypot(tipX, tipY);
      if (offsetMagnitude > safeOffset) {
        const scale = safeOffset / offsetMagnitude;
        tipX *= scale; tipY *= scale;
      }
      const elevation = clamp(options.elevation || 0, 0, 62) * Math.PI / 180;
      const offset = Math.hypot(tipX, tipY);
      const ballMass = cue?.mass || this.params.mass;
      const cueRestitution = 0.73;
      const transfer = (1 + cueRestitution) * spec.cueMass / (spec.cueMass + ballMass);
      const referenceTransfer = (1 + cueRestitution) * 0.525 / (0.525 + 0.1695);
      // Beyond the chalk-friction envelope the tip skids off: a deterministic
      // miscue keeps prediction honest — most momentum and nearly all
      // controlled spin are lost and the deflection roughly doubles.
      const requestedOffsetEarly = Math.hypot(requestedTipX, requestedTipY);
      const miscue = requestedOffsetEarly > safeOffset + 1e-9;
      let efficiency = transfer / referenceTransfer * spec.powerEfficiency * tipSpec.energyEfficiency * (1 - 0.082 * offset * offset);
      if (miscue) efficiency *= 0.30;
      const speed = speedInput * efficiency;
      // Rigid-impulse squirt (Cross 2008): the gripping tip must accelerate
      // sideways with the contact point, and the shaft's effective end mass
      // resists that, deflecting the ball opposite to the English:
      //   tan α = (5/2)(b/R)c / (1 + (5/2)c² + M/mₑ),  c = √(1 − (b/R)²).
      // Squirt is nearly speed-independent, matching Dr. Dave's measurements.
      const contactCos = Math.sqrt(Math.max(0.14, 1 - offset * offset));
      const massRatio = ballMass / spec.effectiveEndMass;
      let squirt = -Math.atan(
        (2.5 * tipX * contactCos) / (1 + 2.5 * contactCos * contactCos + massRatio),
      );
      if (miscue) squirt *= 1.8;
      const cs = Math.cos(squirt), ss = Math.sin(squirt);
      direction = { x: direction.x * cs - direction.z * ss, z: direction.x * ss + direction.z * cs };
      const angularScale = 2.5 * speed * 0.84 * (miscue ? 0.25 : 1) * spec.spinEfficiency * tipSpec.spinTransfer / R;
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
      const miscueMargin = safeOffset - requestedOffsetEarly;
      const aimAllowancePerMetre = Math.tan(Math.abs(squirt));
      // An elevated cue drives the ball into the slate; part of the vertical
      // impulse rebounds as a hop (the legal jump/massé mechanism).  Tiny
      // vertical speeds are swallowed by cloth compliance.
      const liftSpeed = speed * Math.sin(elevation) * 0.62;
      const launchSpeed = liftSpeed > 0.30 ? liftSpeed : 0;
      return {
        spec, tipSpec, direction, speed, speedInput, horizontalSpeed, launchSpeed, tipX, tipY,
        elevation, squirt, omega, miscue,
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
      return this.balls.some((b) => !b.pocketed && (
        b.railContact != null
        || Math.hypot(b.vel.x, b.vel.z) > 0.005
        || Math.hypot(b.omega.x, b.omega.y, b.omega.z) > 0.85
        || b.posY > 1e-4 || Math.abs(b.velY) > 0.05
      ));
    }

    strike(options) {
      const cue = this.getCueBall();
      if (!cue || cue.pocketed || this.isMoving()) return false;
      const impact = this.cueImpactMetrics(options);
      cue.vel.x = impact.direction.x * impact.horizontalSpeed;
      cue.vel.z = impact.direction.z * impact.horizontalSpeed;
      cue.velY = impact.launchSpeed;
      cue.posY = 0;
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
        tipX: impact.tipX, tipY: impact.tipY, elevation: impact.elevation, miscue: impact.miscue,
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
        // Airborne balls (jump/massé) keep their spin frozen and feel only
        // gravity; the cloth solver takes over again on landing, after a
        // single friction kick from the touchdown impulse.
        if (ball.posY > 1e-6 || ball.velY > 1e-6) {
          ball.velY -= G * dt;
          ball.posY += ball.velY * dt;
          if (ball.posY <= 0) {
            ball.posY = 0;
            this.landBall(ball);
            ball.velY = -ball.velY * 0.50;
            if (ball.velY < 0.30) ball.velY = 0;
            ball.state = ball.velY > 0 ? 'airborne' : 'sliding';
          } else {
            ball.state = 'airborne';
          }
        } else if (!ball.railContact) {
          // While a cushion episode owns the ball its bottom patch is loaded
          // far beyond mg and lives inside the episode integrator; running
          // the unloaded cloth solver concurrently would perturb the slip
          // state once per step and make the outcome depend on step size.
          this.evolveBall(ball, dt);
        }
        if (!ball.railContact) {
          ball.pos.x += ball.vel.x * dt;
          ball.pos.z += ball.vel.z * dt;
        }
        Quat.integrate(ball.rotation, ball.omega, dt);
      }

      // Two sequential impulse passes make clustered racks stable at the fixed rate.
      for (let pass = 0; pass < 2; pass += 1) {
        this.resolveBallPairs(dt);
        for (const ball of this.balls) {
          if (!ball.pocketed) this.resolveCushions(ball, dt);
        }
      }

      for (const ball of this.balls) if (!ball.pocketed) this.checkPocket(ball);
      if (this.inShot && !this.isMoving()) {
        this.inShot = false;
        this.emit({ type: 'settled', shotTime: this.shotTime });
      }
    }

    // Touchdown after flight: the normal impulse m(1+e)|vy| sets a Coulomb
    // budget for one friction kick at the contact patch.  This is what makes
    // massé shots grab and hook after the hop instead of skidding on rails.
    landBall(ball) {
      const impactSpeed = -ball.velY;
      if (impactSpeed < 0.05) return;
      const R = ball.radius;
      const slipX = ball.vel.x + ball.omega.z * R;
      const slipZ = ball.vel.z - ball.omega.x * R;
      const slip = Math.hypot(slipX, slipZ);
      if (slip < 1e-4) return;
      const normalImpulse = ball.mass * (1 + 0.50) * impactSpeed;
      // 2/7·m·slip is exactly the impulse that brings the patch to pure roll.
      const friction = Math.min(this.params.muSlide * normalImpulse, slip * ball.mass * (2 / 7));
      const fx = -friction * slipX / slip, fz = -friction * slipZ / slip;
      ball.vel.x += fx / ball.mass;
      ball.vel.z += fz / ball.mass;
      ball.omega.x += (-R * fz) / ball.inertia;
      ball.omega.z += (R * fx) / ball.inertia;
      ball.state = 'sliding';
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

    // Contact geometry for a potentially colliding pair on current positions
    // and velocities.  `toi` is the rewind to the true first touch; it stays
    // 0 when the overlap must be handled in place: slow squeezes, degenerate
    // relative speed, or a ball owned by a cushion episode, which position
    // surgery must never move.
    pairContact(a, b, dt) {
      // A jumping ball passes over one it no longer overlaps in height.
      if (Math.abs(a.posY - b.posY) > (a.radius + b.radius) * 0.8) return null;
      const dx = b.pos.x - a.pos.x;
      const dz = b.pos.z - a.pos.z;
      const minDistance = a.radius + b.radius;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= minDistance * minDistance) return null;
      const rvx = b.vel.x - a.vel.x, rvz = b.vel.z - a.vel.z;
      const closing = dx * rvx + dz * rvz;
      const relSpeedSq = rvx * rvx + rvz * rvz;
      let toi = 0;
      // The closing gate matches the impulse stage's -1e-5 threshold: a pair
      // creeping together slower than that takes the positional relaxation
      // (toi = 0) instead of parking in a window where a micro-TOI suppresses
      // relaxation yet the impulse stage drops the contact as grazing.
      if (closing < -1e-5 * minDistance && relSpeedSq > 1e-12 && !a.railContact && !b.railContact) {
        const discriminant = closing * closing - relSpeedSq * (distanceSq - minDistance * minDistance);
        if (discriminant > 0) toi = Math.max(0, Math.min(dt, (closing + Math.sqrt(discriminant)) / relSpeedSq));
      }
      return { a, b, minDistance, closing, toi };
    }

    // Positional relaxation for overlaps that no rewind will separate (rack
    // clusters, slow squeezes).  It runs as its own sweep so the impulse
    // stage below cannot inherit an order dependence from where relaxation
    // happened to interleave.
    relaxBallOverlaps(dt) {
      const balls = this.balls;
      for (let i = 0; i < balls.length; i += 1) {
        const a = balls[i];
        if (a.pocketed) continue;
        for (let j = i + 1; j < balls.length; j += 1) {
          const b = balls[j];
          if (b.pocketed) continue;
          const contact = this.pairContact(a, b, dt);
          if (!contact || contact.toi > 0) continue;
          const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          const distance = Math.hypot(dx, dz);
          const nx = distance > 1e-8 ? dx / distance : 1;
          const nz = distance > 1e-8 ? dz / distance : 0;
          const invA = 1 / a.mass, invB = 1 / b.mass;
          // A ball owned by a cushion episode must not be teleported into the
          // rubber: free compression would become free spring energy.
          const correction = Math.max(0, contact.minDistance - distance + 1e-5) / (invA + invB) * 0.76;
          const shiftA = a.railContact ? 0 : (b.railContact ? correction * (invA + invB) : correction * invA);
          const shiftB = b.railContact ? 0 : (a.railContact ? correction * (invA + invB) : correction * invB);
          a.pos.x -= nx * shiftA; a.pos.z -= nz * shiftA;
          b.pos.x += nx * shiftB; b.pos.z += nz * shiftB;
        }
      }
    }

    resolveBallPairs(dt = 1 / 1000) {
      this.relaxBallOverlaps(dt);
      // Impulses run strictly in time-of-impact order, one contact (or one
      // simultaneous cluster) at a time, rescanning in between because an
      // applied impulse re-orders, retires or creates the remaining contacts.
      // The legacy single sweep resolved pairs in ball-array order, which
      // handed the first-scanned pair the shared ball's full momentum: a
      // perfectly symmetric split shot came out 2:1 lopsided.
      const balls = this.balls;
      const done = new Set();
      for (let round = 0; round < balls.length * balls.length; round += 1) {
        const contacts = [];
        for (let i = 0; i < balls.length; i += 1) {
          const a = balls[i];
          if (a.pocketed) continue;
          for (let j = i + 1; j < balls.length; j += 1) {
            const b = balls[j];
            if (b.pocketed || done.has(i * balls.length + j)) continue;
            const contact = this.pairContact(a, b, dt);
            if (contact && contact.closing < 0) {
              contact.key = i * balls.length + j;
              contacts.push(contact);
            }
          }
        }
        if (!contacts.length) return;
        // Earliest first touch = largest rewind.
        let first = contacts[0];
        for (const c of contacts) if (c.toi > first.toi) first = c;
        // Contacts that share a ball and tie with the earliest one in touch
        // time are genuinely simultaneous: they must share one impulse system
        // instead of feeding whichever contact the scan reached first.
        const cluster = [first];
        const bodies = new Set([first.a, first.b]);
        for (let grew = true; grew;) {
          grew = false;
          for (const c of contacts) {
            if (cluster.includes(c) || Math.abs(c.toi - first.toi) > 1e-7) continue;
            if (bodies.has(c.a) || bodies.has(c.b)) {
              cluster.push(c); bodies.add(c.a); bodies.add(c.b); grew = true;
            }
          }
        }
        this.resolveContactCluster(cluster, [...bodies], first.toi);
        for (const c of cluster) done.add(c.key);
      }
    }

    resolveContactCluster(cluster, bodies, toi) {
      // Rewind to the true time of impact: a fast pair closes millimetres
      // past tangency within one step, and the centre line — which IS the
      // impact normal — rotates while they interpenetrate.  Taking the normal
      // at first touch keeps thin-cut contact angles, and with them throw and
      // potting lines, honest at speed.  Every ball of the cluster rewinds
      // once, even when it appears in several contacts.
      if (toi > 0) {
        for (const ball of bodies) {
          // A ball owned by a cushion episode joins a cluster only through
          // the tie window, and its position belongs to the episode
          // integrator — never to pair-solver surgery.
          if (ball.railContact) continue;
          ball.pos.x -= ball.vel.x * toi;
          ball.pos.z -= ball.vel.z * toi;
        }
      }
      const live = [];
      for (const contact of cluster) {
        const { a, b } = contact;
        const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
        const distance = Math.hypot(dx, dz);
        const nx = distance > 1e-8 ? dx / distance : 1;
        const nz = distance > 1e-8 ? dz / distance : 0;
        const preRelN = (b.vel.x - a.vel.x) * nx + (b.vel.z - a.vel.z) * nz;
        if (preRelN >= -1e-5) continue;
        live.push({
          a, b, nx, nz, tx: -nz, tz: nx, preRelN,
          invA: 1 / a.mass, invB: 1 / b.mass, lambda: 0,
        });
      }
      if (live.length) {
        // Simultaneous normal impulses: projected Gauss-Seidel with every
        // restitution target taken from the shared pre-impact velocities.
        // A single contact converges on the first sweep to the closed-form
        // pair impulse, so isolated collisions keep their calibrated maths
        // bit for bit; ties iterate to the joint solution, and alternating
        // the sweep direction keeps a symmetric cluster from inheriting
        // scan-order bias.
        const e = this.params.restitutionBall;
        for (let iter = 0; iter < 60; iter += 1) {
          let applied = 0;
          for (let s = 0; s < live.length; s += 1) {
            const c = live[iter % 2 ? live.length - 1 - s : s];
            const relN = (c.b.vel.x - c.a.vel.x) * c.nx + (c.b.vel.z - c.a.vel.z) * c.nz;
            const delta = -(relN + e * c.preRelN) / (c.invA + c.invB);
            const next = Math.max(0, c.lambda + delta);
            const change = next - c.lambda;
            c.lambda = next;
            c.a.vel.x -= c.nx * change * c.invA; c.a.vel.z -= c.nz * change * c.invA;
            c.b.vel.x += c.nx * change * c.invB; c.b.vel.z += c.nz * change * c.invB;
            applied = Math.max(applied, Math.abs(change));
          }
          if (applied < 1e-12) break;
        }
        // Full contact-point slip: the equator contact arms are ±R·n̂, so the
        // relative surface velocity has an in-plane part (side spin + cut)
        // and a vertical part (follow/draw rubbing).  Solving both in one
        // friction cone is what makes a rolling cue ball throw less than a
        // stun shot and lets follow/draw transfer between balls.  The slip is
        // measured AFTER the normal stage: in a multi-contact cluster the
        // OTHER contacts' normal impulses change this contact's tangential
        // relative velocity, and friction built from stale pre-cluster slip
        // can end up pointing along the true slip and pumping energy.  A
        // contact's own normal impulse is tangent-orthogonal and torque-free,
        // so for a single contact both measurements are identical and
        // isolated collisions stay bit-exact.  All slips are snapshotted
        // before any friction is applied, keeping symmetric clusters exact.
        for (const c of live) {
          const { a, b } = c;
          const rA = a.radius, rB = b.radius;
          const surfAX = a.vel.x + a.omega.y * c.nz * rA;
          const surfAZ = a.vel.z - a.omega.y * c.nx * rA;
          const surfAY = (a.omega.z * c.nx - a.omega.x * c.nz) * rA;
          const surfBX = b.vel.x - b.omega.y * c.nz * rB;
          const surfBZ = b.vel.z + b.omega.y * c.nx * rB;
          const surfBY = -(b.omega.z * c.nx - b.omega.x * c.nz) * rB;
          c.slipT = (surfBX - surfAX) * c.tx + (surfBZ - surfAZ) * c.tz;
          c.slipY = surfBY - surfAY;
        }
        for (const c of live) {
          const { a, b } = c;
          const rA = a.radius, rB = b.radius;
          const mu = ballBallFriction(Math.hypot(c.slipT, c.slipY));
          const denomT = c.invA + c.invB + rA * rA / a.inertia + rB * rB / b.inertia;
          // The slate carries the vertical linear reaction, so vertical
          // rubbing only exchanges spin (same approximation as the cushion
          // solver).
          const denomY = rA * rA / a.inertia + rB * rB / b.inertia;
          let impulseT = -c.slipT / denomT;
          let impulseY = -c.slipY / denomY;
          const rawFriction = Math.hypot(impulseT, impulseY);
          const frictionLimit = mu * c.lambda;
          if (rawFriction > frictionLimit && rawFriction > 1e-12) {
            const scale = frictionLimit / rawFriction;
            impulseT *= scale; impulseY *= scale;
          }
          a.vel.x -= impulseT * c.tx * c.invA; a.vel.z -= impulseT * c.tz * c.invA;
          b.vel.x += impulseT * c.tx * c.invB; b.vel.z += impulseT * c.tz * c.invB;
          // τ = (±R n̂) × f with friction f = (impulseT·t̂ + impulseY·ŷ); the
          // normal impulse passes through both centres and adds no torque.
          const fX = impulseT * c.tx, fY = impulseY, fZ = impulseT * c.tz;
          const crossX = -c.nz * fY, crossY = c.nz * fX - c.nx * fZ, crossZ = c.nx * fY;
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
              type: 'ball-ball', aId: a.id, bId: b.id, impulse: c.lambda,
              speed: Math.abs(c.preRelN), position: { x: a.pos.x + c.nx * a.radius, z: a.pos.z + c.nz * a.radius },
              normal: { x: c.nx, z: c.nz },
            });
          }
        }
      }
      // Replay the rewound time with the post-impact velocities.
      if (toi > 0) {
        for (const ball of bodies) {
          if (ball.railContact) continue;
          ball.pos.x += ball.vel.x * toi;
          ball.pos.z += ball.vel.z * toi;
        }
      }
    }

    resolveCushions(ball, dt = 1 / 1000) {
      // A ball whose underside clears the cushion top sails over the rail.
      if (ball.posY > (this.table.cushionTopHeight || 0.042)) {
        if (ball.railContact) this.finishRailContact(ball);
        return;
      }
      if (ball.railContact) {
        // Continuing contact.  The second resolver pass of the same step must
        // not integrate the same interval twice.
        if (ball.railContact.stepStamp === this.time) return;
        // The contact integrator owns this step's whole time slice: undo the
        // ballistic advance — which on a restituting ball can overshoot the
        // shallow remaining compression and would silently discard the energy
        // still stored in the spring — and let the rubber finish its push-off.
        this.integrateRailContact(ball, dt, dt);
        return;
      }
      const contacts = this.scanCushionContacts(ball);
      if (!contacts.length) return;
      const primary = contacts.reduce((best, c) => (c.depth > best.depth ? c : best));
      const approach = -(ball.vel.x * primary.nx + ball.vel.z * primary.nz);
      // Resting contact: hold the ball on the surface without exciting the
      // spring, so frozen balls stay put and never ring against the rubber.
      if (primary.depth < 2e-5 && Math.abs(approach) < 0.006) {
        for (const c of contacts) {
          ball.pos.x += c.nx * c.depth;
          ball.pos.z += c.nz * c.depth;
        }
        return;
      }
      this.beginRailContact(ball, primary, approach);
      // Rewind to the true first-touch point, keeping ~10 µm of engagement so
      // the first sub-step still sees the contact it is about to compress; a
      // penetration older than this step claims the whole step instead.
      const timeToTouch = approach > 1e-9 ? (primary.depth - 1e-5) / approach : 0;
      const rewound = clamp(Math.min(dt, timeToTouch), 0, dt);
      ball.pos.x -= ball.vel.x * rewound;
      ball.pos.z -= ball.vel.z * rewound;
      // Whatever penetration the rewind could not unwind was never absorbed
      // by this spring: a mid-step impulse can redirect a ball deep into the
      // rubber, and collider gaps at pocket mouths can let one tunnel for a
      // step before a rail claims it.  Snap the entry to the engagement depth
      // so an episode only ever returns work it really accumulated —
      // monetising 4 mm of phantom compression once turned into +3.8 J.  An
      // ordinary impact rewinds to exactly 10 µm and is left untouched.
      const residual = primary.depth - approach * rewound;
      if (residual > 4e-5) {
        const pushOut = residual - 1e-5;
        ball.pos.x += primary.nx * pushOut;
        ball.pos.z += primary.nz * pushOut;
      }
      this.integrateRailContact(ball, rewound, dt);
    }

    // Pure contact geometry.  Straight cushion planes, round jaw arcs and flat
    // pocket facings all reduce to a unit normal plus a penetration depth; the
    // jaw owns the mouth side of each straight-to-round tangent so a grazing
    // ball never collects two conflicting normals.
    scanCushionContacts(ball) {
      const R = ball.radius;
      const contacts = [];
      for (const segment of this.table.cushions) {
        const coordinate = segment.axis === 'x' ? ball.pos.x : ball.pos.z;
        if (coordinate < segment.min - 1e-6 || coordinate > segment.max + 1e-6) continue;
        const bx = segment.axis === 'x' ? ball.pos.x : segment.value;
        const bz = segment.axis === 'x' ? segment.value : ball.pos.z;
        const signedDistance = (ball.pos.x - bx) * segment.normal.x + (ball.pos.z - bz) * segment.normal.z;
        if (signedDistance < R) {
          contacts.push({ nx: segment.normal.x, nz: segment.normal.z, depth: R - signedDistance, id: segment.id });
        }
      }
      for (const jaw of this.table.jaws) {
        const dx = ball.pos.x - jaw.x, dz = ball.pos.z - jaw.z;
        const distanceSq = dx * dx + dz * dz;
        const contactRadius = R + (jaw.radius || 0);
        if (distanceSq >= contactRadius * contactRadius || distanceSq < 1e-12) continue;
        const distance = Math.sqrt(distanceSq);
        contacts.push({ nx: dx / distance, nz: dz / distance, depth: contactRadius - distance, id: jaw.id || 'jaw' });
      }
      for (const facing of this.table.facings || []) {
        const ex = facing.p1.x - facing.p0.x, ez = facing.p1.z - facing.p0.z;
        const lengthSq = ex * ex + ez * ez;
        const relX = ball.pos.x - facing.p0.x, relZ = ball.pos.z - facing.p0.z;
        const t = clamp((relX * ex + relZ * ez) / lengthSq, 0, 1);
        const dx = relX - ex * t, dz = relZ - ez * t;
        const distanceSq = dx * dx + dz * dz;
        if (distanceSq >= R * R || distanceSq < 1e-12) continue;
        const distance = Math.sqrt(distanceSq);
        const nx = dx / distance, nz = dz / distance;
        // Ignore approaches from the back of the wall (inside the pocket body).
        if (nx * facing.normal.x + nz * facing.normal.z < -0.2) continue;
        contacts.push({ nx, nz, depth: R - distance, id: facing.id });
      }
      return contacts;
    }

    // Damping χ scaled so a 2.5 m/s stun rebound matches the table's
    // restitutionCushion; faster impacts then lose proportionally more.
    cushionDamping() {
      return CUSHION_DAMPING_REF * (1 - this.params.restitutionCushion) / 0.18;
    }

    // The rail is not a rigid wall: the rubber nose compresses one to a few
    // millimetres over roughly a millisecond and returns most of the stored
    // energy.  A contact lives as an episode on the ball (ball.railContact):
    // each fixed step contributes exactly its own dt of Hunt-Crossley
    // integration on a sub-grid of min(CUSHION_SUBSTEP, dt), so slow-motion
    // steps refine the contact resolution and the compression visibly evolves
    // across frames instead of resolving atomically inside one step.  The
    // spring-damper produces speed-dependent restitution by itself, Coulomb
    // friction at the raised nose evolves (and may stick or reverse) through
    // the contact, and the closing report carries the physical compression
    // depth and contact time.  The nose sits above the centre, so part of the
    // normal force is driven into the slate; its partial return is the
    // visible hop off the rail on firm square hits, and a jumping ball
    // striking below its centre is deflected upward instead.
    beginRailContact(ball, primary, approach) {
      const R = ball.radius;
      const noseHeight = clamp(this.table.cushionContactHeight - R - Math.max(0, ball.posY), -R * 0.49, R * 0.49);
      const reach = Math.sqrt(Math.max(R * R - noseHeight * noseHeight, R * R * 0.72));
      const rotationalNormal = noseHeight * (ball.omega.x * primary.nz - ball.omega.z * primary.nx);
      const followRatio = clamp(-rotationalNormal / Math.max(approach, 0.16), -0.75, 0.75);
      ball.railContact = {
        id: primary.id, nx: primary.nx, nz: primary.nz,
        vinX: ball.vel.x, vinZ: ball.vel.z, approach,
        noseHeight, reach, horizontal: reach / R, vertical: -noseHeight / R,
        followRatio,
        sideSurfaceSpeed: ball.omega.y * reach,
        linearTangentSpeed: -ball.vel.x * primary.nz + ball.vel.z * primary.nx,
        // Mathavan's measurements: topspin rolling over the nose returns more
        // energy than draw, which scales the damping term.
        chi: this.cushionDamping() * clamp(1 - 0.50 * followRatio, 0.45, 1.55),
        maxDepth: 0, contactTime: 0, downImpulse: 0, slipSteps: 0, stickSteps: 0,
        stepStamp: -1,
      };
    }

    integrateRailContact(ball, budget, dt) {
      const contact = ball.railContact;
      const { noseHeight, reach, horizontal, vertical, chi } = contact;
      const mu = this.params.frictionCushion;
      const baseStep = Math.min(CUSHION_SUBSTEP, dt);
      let consumed = 0;
      let engaged = true;
      for (let i = 0; i < 220 && consumed < budget - 1e-12; i += 1) {
        const contacts = this.scanCushionContacts(ball);
        if (!contacts.length) { engaged = false; break; }
        const h = Math.min(baseStep, budget - consumed);
        let fx = 0, fy = 0, fz = 0, torqueX = 0, torqueY = 0, torqueZ = 0;
        for (const c of contacts) {
          contact.maxDepth = Math.max(contact.maxDepth, c.depth);
          const rate = -(ball.vel.x * c.nx + ball.vel.z * c.nz);
          const fn = CUSHION_STIFFNESS * c.depth * Math.sqrt(c.depth) * (1 + chi * rate);
          if (!(fn > 0)) continue;
          // The contact normal points from the nose through the ball centre:
          // mostly horizontal push-back plus a slate-ward vertical component.
          fx += fn * c.nx * horizontal;
          fz += fn * c.nz * horizontal;
          fy += fn * vertical;
          const armX = -c.nx * reach, armY = noseHeight, armZ = -c.nz * reach;
          const surfX = ball.vel.x + ball.omega.y * armZ - ball.omega.z * armY;
          const surfY = ball.omega.z * armX - ball.omega.x * armZ;
          const surfZ = ball.vel.z + ball.omega.x * armY - ball.omega.y * armX;
          const tX = -c.nz, tZ = c.nx;
          const slipT = surfX * tX + surfZ * tZ;
          const slipY = surfY;
          const slipMag = Math.hypot(slipT, slipY);
          if (slipMag < 1e-6) { contact.stickSteps += 1; continue; }
          const dirT = slipT / slipMag, dirY = slipY / slipMag;
          const sX = dirT * tX, sY = dirY, sZ = dirT * tZ;
          const crossX = armY * sZ - armZ * sY;
          const crossY = armZ * sX - armX * sZ;
          const crossZ = armX * sY - armY * sX;
          // Effective mobility along the slip direction: the slate carries the
          // vertical linear reaction, so only the in-plane share moves mass.
          const mobility = dirT * dirT / ball.mass
            + (crossX * crossX + crossY * crossY + crossZ * crossZ) / ball.inertia;
          const holdForce = slipMag / (h * Math.max(mobility, 1e-9));
          const friction = Math.min(mu * fn, holdForce);
          if (friction >= mu * fn - 1e-12) contact.slipSteps += 1; else contact.stickSteps += 1;
          const ffX = -friction * dirT * tX;
          const ffY = -friction * dirY;
          const ffZ = -friction * dirT * tZ;
          fx += ffX;
          fz += ffZ;
          torqueX += armY * ffZ - armZ * ffY;
          torqueY += armZ * ffX - armX * ffZ;
          torqueZ += armX * ffY - armY * ffX;
        }
        // Mathavan (2010): the slate is a second loaded friction contact
        // during a cushion impact — the nose drives the ball downward and
        // cloth friction at the bottom patch works against mg plus that
        // extra load for the whole episode (the per-step cloth solver stands
        // aside while the episode owns the ball).
        if (ball.posY <= 1e-9) {
          const slateLoad = Math.max(0, ball.mass * G - fy);
          const R = ball.radius;
          const slipX = ball.vel.x + ball.omega.z * R;
          const slipZ = ball.vel.z - ball.omega.x * R;
          const slip = Math.hypot(slipX, slipZ);
          if (slip > 1e-6 && slateLoad > 0) {
            // In-plane mobility of the bottom patch is 1/m + R²/I = 7/(2m).
            const holdForce = slip / (h * (7 / (2 * ball.mass)));
            const friction = Math.min(this.params.muSlide * slateLoad, holdForce);
            const fxSlate = -friction * slipX / slip;
            const fzSlate = -friction * slipZ / slip;
            fx += fxSlate;
            fz += fzSlate;
            torqueX += -R * fzSlate;
            torqueZ += R * fxSlate;
          }
        }
        ball.vel.x += fx / ball.mass * h;
        ball.vel.z += fz / ball.mass * h;
        if (fy < 0 && ball.posY <= 1e-9) contact.downImpulse -= fy * h;
        else ball.velY += fy / ball.mass * h;
        ball.omega.x += torqueX / ball.inertia * h;
        ball.omega.y += torqueY / ball.inertia * h;
        ball.omega.z += torqueZ / ball.inertia * h;
        ball.pos.x += ball.vel.x * h;
        ball.pos.z += ball.vel.z * h;
        consumed += h;
      }
      contact.contactTime += consumed;
      contact.stepStamp = this.time;
      ball.state = 'sliding';
      if (!engaged) {
        // The rubber let go inside this step: spend the remaining rewound
        // time ballistically, then report the whole episode.
        const leftover = budget - consumed;
        if (leftover > 0) {
          ball.pos.x += ball.vel.x * leftover;
          ball.pos.z += ball.vel.z * leftover;
        }
        this.finishRailContact(ball);
      }
    }

    finishRailContact(ball) {
      const contact = ball.railContact;
      ball.railContact = null;
      // Slate return of the nose-driven vertical impulse: a small hop that
      // only firm, fairly square impacts can excite through the cloth.
      if (contact.downImpulse > 0 && ball.posY <= 1e-9) {
        const hop = 0.13 * contact.downImpulse / ball.mass;
        if (hop > 0.24) ball.velY = Math.max(ball.velY, Math.min(hop, 0.9));
      }

      let english = 'neutral';
      if (Math.abs(contact.sideSurfaceSpeed) > 0.035) {
        if (Math.abs(contact.linearTangentSpeed) < 0.045) english = 'side';
        else english = contact.linearTangentSpeed * contact.sideSurfaceSpeed < 0 ? 'running' : 'reverse';
      }
      const tX = -contact.nz, tZ = contact.nx;
      const reboundNormal = ball.vel.x * contact.nx + ball.vel.z * contact.nz;
      const reboundTangent = ball.vel.x * tX + ball.vel.z * tZ;
      const incidentAngle = Math.atan2(Math.abs(contact.linearTangentSpeed), Math.max(1e-7, contact.approach)) * 180 / Math.PI;
      const reboundAngle = Math.atan2(Math.abs(reboundTangent), Math.max(1e-7, reboundNormal)) * 180 / Math.PI;
      const event = {
        type: 'cushion', ballId: ball.id, cushionId: contact.id, speed: Math.abs(contact.approach),
        impulse: ball.mass * (Math.max(0, contact.approach) + Math.max(0, reboundNormal)),
        position: { ...ball.pos }, normal: { x: contact.nx, z: contact.nz },
        english,
        frictionMode: contact.slipSteps > contact.stickSteps ? 'slide' : 'stick',
        followRatio: contact.followRatio,
        restitution: contact.approach > 0.02 ? clamp(reboundNormal / contact.approach, 0, 1) : 0,
        compression: contact.maxDepth, contactTime: contact.contactTime,
        incidentAngle, reboundAngle, angleChange: reboundAngle - incidentAngle,
        incoming: { x: contact.vinX, z: contact.vinZ },
        outgoing: { x: ball.vel.x, z: ball.vel.z },
      };
      this.lastCushionEvent = event;

      const key = `rail:${ball.id}:${contact.id}`;
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
      ball.posY = 0;
      ball.velY = 0;
      ball.railContact = null; // a mid-compression rattle can drop straight in
      ball.sinkTarget = { x: pocket.x, z: pocket.z };
      ball.vel.x *= 0.42; ball.vel.z *= 0.42;
      ball.omega.x *= 0.46; ball.omega.y *= 0.46; ball.omega.z *= 0.46;
      ball.state = 'pocketed';
      this.emit({ type: 'pocket', ballId: ball.id, pocketId: pocket.id, speed: ball.lastSpeed, position: { x: pocket.x, z: pocket.z } });
    }

    checkPocket(ball) {
      if (ball.pocketed) return;
      if (ball.posY > 0.05) return; // flying over the mouth is not a pot
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
      const dt = 1 / 1000;
      const sampleEvery = 16;
      // Aiming previews must never stall the pointer: cap the wall-clock cost
      // and truncate the far tail of worst-case (full-rack) predictions.
      const clock = typeof performance !== 'undefined' ? performance : Date;
      const deadline = clock.now() + 40;
      let step = 0;
      let stillFrames = 0;
      while (clone.shotTime < maxTime && step < maxTime / dt) {
        clone.step(dt);
        if ((step & 63) === 63 && clock.now() > deadline) break;
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
        if (stillFrames > 10) break;
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
      // Full mechanical energy.  The gravitational term makes the readout an
      // invariant through jump flight instead of dipping at the apex, and
      // lets conservation assertions hold while a ball is airborne.
      return this.balls.reduce((sum, ball) => {
        if (ball.pocketed) return sum;
        const linear = 0.5 * ball.mass * (ball.vel.x * ball.vel.x + ball.velY * ball.velY + ball.vel.z * ball.vel.z);
        const angular = 0.5 * ball.inertia * (ball.omega.x * ball.omega.x + ball.omega.y * ball.omega.y + ball.omega.z * ball.omega.z);
        const potential = ball.mass * G * ball.posY;
        return sum + linear + angular + potential;
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
      ball.posY = 0; ball.velY = 0; ball.railContact = null;
      ball.rotation = Quat.identity(); ball.pocketed = false; ball.pocketId = null; ball.sinkTime = 0; ball.sinkDepth = 0; ball.sinkTarget = null; ball.state = 'stationary';
      return true;
    }
  }

  global.BilliardsPhysics = {
    PhysicsWorld, POOL_PARAMS, CHINESE_PARAMS, SNOOKER_PARAMS, CUE_SPECS, TIP_PRESETS,
    TABLES, POOL_COLORS, PALLADIUM_COLORS, SNOOKER_COLORS,
  };
})(window);
