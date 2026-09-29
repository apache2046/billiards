(function (global) {
  'use strict';

  const { V2, V3, Quat, clamp } = global.BilliardsMath;
  const G = 9.81;
  const POCKET_STEP = 1 / 10000;

  // Baseline values are aligned with Pooltool's generic pool-ball parameters.
  // See README for papers and exact sources. Units are SI throughout this file.
  // Cushion rubber: frictionCushion is the ball/cloth-covered-nose Coulomb
  // coefficient; cushionHysteresis (χ, s/m) is the Hunt-Crossley loss that
  // grows with impact speed, and cushionViscosity (N·s/m) the cloth/rubber
  // viscous loss that dominates soft and glancing contacts.  Pool is fitted to
  // Dr Dave & Bob Jewett's measured slow rolling-ball rebound angles (TP B.11)
  // and the rolling-in rail COR ≈ 0.7 of TP B.6 / HSV B.15; snooker to
  // Mathavan et al.'s high-speed-video rebound speeds for a rolling ball
  // driven straight in (AJP 2009: ≈0.9 at 0.5–1.5 m/s falling to ≈0.83 at
  // 3.5 m/s) with their fitted μw = 0.14 (IMechE 2010).  Chinese tables use snooker-type steel-block cushions, so
  // they take the snooker losses (scaled to the heavier ball) with pool-ball
  // cloth friction; no direct measurement of a Chinese cushion exists.
  const POOL_PARAMS = Object.freeze({
    radius: 0.028575,
    mass: 0.170097,
    muSlide: 0.20,
    muRoll: 0.010,
    muSpin: 0.0127,
    restitutionBall: 0.95,
    frictionCushion: 0.20,
    cushionHysteresis: 0.049,
    cushionViscosity: 40,
  });

  const CHINESE_PARAMS = Object.freeze({
    radius: 0.028575,
    mass: 0.1695,
    muSlide: 0.205,
    muRoll: 0.0095,
    muSpin: 0.0127,
    restitutionBall: 0.95,
    frictionCushion: 0.20,
    cushionHysteresis: 0.055,
    cushionViscosity: 8.5,
  });

  const SNOOKER_PARAMS = Object.freeze({
    radius: 0.02619375,
    mass: 0.140,
    muSlide: 0.20,
    muRoll: 0.008,
    muSpin: 0.0115,
    restitutionBall: 0.94,
    frictionCushion: 0.14,
    cushionHysteresis: 0.055,
    cushionViscosity: 7,
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
      id: 'large', label: '大头杆', detail: '美式大头枫木前节', tipDiameter: 0.0125, shaftRadius: 0.0073,
      cueMass: 0.535, effectiveEndMass: 0.0064, spinEfficiency: 0.96,
      maxOffset: 0.52, powerEfficiency: 1.0,
    }),
  });

  // Alciatore's measured ball-ball sliding friction falls off exponentially with
  // contact slip speed; this is what makes soft-speed shots throw the most.
  function ballBallFriction(slipSpeed) {
    return 0.009951 + 0.108 * Math.exp(-1.088 * slipSpeed);
  }

  // A raised nose has TWO tangents: along the rail and up its sloping face.
  // World-up is not tangent to the sphere/nose contact. Keep the basis shared
  // with the regression tests so normal work cannot leak into friction.
  function cushionFrame(nx, nz, vertical) {
    const horizontal = Math.sqrt(Math.max(0, 1 - vertical * vertical));
    return {
      normal: { x: nx * horizontal, y: vertical, z: nz * horizontal },
      tangent: { x: -nz, y: 0, z: nx },
      up: { x: -nx * vertical, y: horizontal, z: -nz * vertical },
    };
  }

  const NO_CONTACTS = Object.freeze([]);

  // At rest in every degree of freedom: evolveBall would leave it unchanged.
  function restingBall(ball) {
    return ball.state === 'stationary' && ball.lastSpeed === 0 && ball.posY === 0 && ball.velY === 0
      && ball.vel.x === 0 && ball.vel.z === 0 && ball.omega.x === 0 && ball.omega.y === 0 && ball.omega.z === 0;
  }

  function spatialBall(ball) {
    return Math.abs(ball.posY) > 1e-8 || Math.abs(ball.velY) > 1e-8;
  }

  // Rubber-nose compliance: F = k·δ^{3/2}·(1 + χ·δ̇) + c·δ̇ (Hunt-Crossley
  // plus a viscous term; χ and c are per-table parameters above).  The
  // stiffness sets the ~1–2 ms contact and millimetre-scale compression.
  // Hunt-Crossley alone returns nearly all energy at low speed (e → 1),
  // which made soft and glancing contacts — jaw rattles, slow kicks — far
  // bouncier than measured; the viscous term keeps them lossy.
  const CUSHION_STIFFNESS = 1.5e7;   // N·m^-1.5
  // Contact sub-grid ceiling; the effective grid is min(this, dt), so the
  // refined steps used in slow motion sharpen the contact integration too.
  const CUSHION_SUBSTEP = 1 / 14400;

  // Ball–slate restitution for hops, jump landings and elevated strokes
  // (Dr Dave TP B.10 uses 0.6; his measured range is 0.5–0.7).
  const SLATE_RESTITUTION = 0.6;

  // One Coulomb friction kick at the bottom patch from a slate normal
  // impulse, capped at 2/7·m·slip — the impulse that leaves the patch in
  // pure roll.  Shared by touchdowns and by the stroke itself.
  function slateFrictionKick(vel, omega, R, mass, inertia, mu, normalImpulse) {
    const slipX = vel.x + omega.z * R;
    const slipZ = vel.z - omega.x * R;
    const slip = Math.hypot(slipX, slipZ);
    if (slip < 1e-4 || !(normalImpulse > 0)) return;
    const friction = Math.min(mu * normalImpulse, slip * mass * (2 / 7));
    const fx = -friction * slipX / slip, fz = -friction * slipZ / slip;
    vel.x += fx / mass;
    vel.z += fz / mass;
    omega.x += (-R * fz) / inertia;
    omega.z += (R * fx) / inertia;
  }

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
      // Mouths are taken at the narrowest point between the two jaw arcs.
      // GB/T 22751-2008 (Table 1, Chinese table) specifies 84 ± 1 mm corners
      // and 86 ± 1 mm middles; the CBSA competition rules give no pocket
      // widths.  The middle is only marginally wider than the corner.
      cornerMouth: 0.085,
      sideMouth: 0.086,
      jawRadius: 0.028,
      // The middle shoulders sweep farther along the rail than into it.
      // This reference-based ellipse is separate from the corner template.
      sideJawRadius: 0.055,
      cornerShelf: 0.014,
      sideShelf: 0.003,
      cushionContactHeight: 0.037,
      cushionTopHeight: 0.042,
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
      // WPA shelf ranges: 25.4–57.15 mm corner, 0–9.525 mm side.
      cornerShelf: 0.032,
      sideShelf: 0.005,
      cushionContactHeight: 0.0363,
      cushionTopHeight: 0.048,
      clothNap: { x: 1, z: 0 },
      clothNapStrength: 0,
      // WPA: the head string bounds the quarter of the table nearest the
      // head rail and runs through the second diamonds; foot spot likewise.
      cueStart: -0.635,
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
      cornerShelf: 0.012,
      sideShelf: 0.002,
      // Mathavan et al. (AJP 2009) measured a 36 mm contact height on
      // their snooker table (≈ 1.4 R, the same proportion as pool).
      cushionContactHeight: 0.036,
      cushionTopHeight: 0.040,
      clothNap: { x: 1, z: 0 },
      clothNapStrength: 0.028,
      // WPBSA: baulk line 737 mm from the bottom cushion face, D of radius
      // 292 mm, black spot 324 mm from the top cushion face.
      baulkFromCushion: 0.737,
      dRadius: 0.292,
      blackFromCushion: 0.324,
      cueStart: -3.569 / 2 + 0.737,
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
        mouthDirection: p.mouthDirection ? { ...p.mouthDirection } : null,
      })),
      jawReturns: (table.jawReturns || []).map((wall) => ({ ...wall, p0: { ...wall.p0 }, p1: { ...wall.p1 }, normal: { ...wall.normal } })),
      facings: (table.facings || []).map((f) => ({
        ...f, p0: { ...f.p0 }, p1: { ...f.p1 }, normal: { ...f.normal },
      })),
    };
  }

  function configureTable(kind) {
    const base = TABLES[kind];
    const table = { ...base, clothNap: { ...base.clothNap } };
    // A reference-shaped Chinese corner has a short round lead-in followed
    // by an oblique cloth facing. Middle jaws use an elongated quarter ellipse.
    // These construction angles approximate the reference, not a brand jig.
    table.cornerReturnAngle = 55 * Math.PI / 180;
    table.sideReturnAngle = Math.PI / 2;
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
      table.sideGap = table.sideMouth / 2 + (table.sideJawRadius || table.jawRadius);
    }
    const hx = table.width / 2;
    const hz = table.height / 2;
    const q = table.jawRadius;
    const diagonal = Math.SQRT1_2;
    const cornerInset = (table.cornerGap - (flatFacings ? 0 : q)) / 2;
    const sideThroatOffset = flatFacings ? 0 : q;
    const cornerPocket = (sx, sz, id) => ({
      throat: { x: sx * (hx - cornerInset), z: sz * (hz - cornerInset) },
      outward: { x: sx * diagonal, z: sz * diagonal },
      type: 'corner', id,
    });
    const sidePocket = (sz, id) => ({
      throat: { x: 0, z: sz * (hz + sideThroatOffset) },
      outward: { x: 0, z: sz },
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
    // One aperture describes both the actual slate cut in WebGL and loss of
    // support in the solver. Rounded mouths are measured at their narrowest
    // jaw section; American mouths are measured at the facing tips.
    table.pockets.forEach((pocket) => {
      const corner = pocket.type === 'corner';
      pocket.shelfDepth = corner ? table.cornerShelf : table.sideShelf;
      pocket.radiusAcross = corner ? table.cornerMouth * 0.53 : table.sideMouth * 0.50;
      pocket.radiusAlong = corner ? 0.054 : 0.050;
      pocket.depth = 0.22;
      pocket.x = pocket.throat.x + pocket.outward.x * (pocket.shelfDepth + pocket.radiusAlong);
      pocket.z = pocket.throat.z + pocket.outward.z * (pocket.shelfDepth + pocket.radiusAlong);
    });
    // A ball whose centre is further than this (plus its radius and one
    // step of travel) inside every cushion line cannot be near any pocket:
    // max over pockets of the pocket radius plus how far its centre sits
    // inside the nearer boundary line (negative when it sits outside).
    table.pocketGuard = Math.max(...table.pockets.map((pocket) => Math.max(pocket.radiusAlong, pocket.radiusAcross)
      + Math.min(hx - Math.abs(pocket.x), hz - Math.abs(pocket.z))));
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
        radiusAlong: s.axis === 'x' && Math.abs(Math.abs(index ? s.max : s.min) - table.sideGap) < 1e-9
          ? (table.sideJawRadius || q) : q,
        // Chinese cloth-covered returns are bounded arcs followed by a
        // tangent wall into the pocket, not complete circular end caps.
        mouthDirection: table.style === 'chinese'
          ? (s.axis === 'x' ? { x: index ? 1 : -1, z: 0 } : { x: 0, z: index ? 1 : -1 })
          : null,
        sweep: s.axis === 'x' && Math.abs(Math.abs(index ? s.max : s.min) - table.sideGap) < 1e-9
          ? table.sideReturnAngle : table.cornerReturnAngle,
      }));
    });

    table.cushionBackDepth = 0.058;
    table.jawReturns = table.style === 'chinese' ? table.jaws.map((jaw) => {
      const s = Math.sin(jaw.sweep), c = Math.cos(jaw.sweep);
      const a = jaw.radiusAlong;
      const extension = a * s + (table.cushionBackDepth - q + q * c) * a * c / (q * s);
      const length = Math.hypot(q * s, a * c);
      return {
        p0: { x: jaw.x + jaw.mouthDirection.x * a * s + jaw.normal.x * q * c, z: jaw.z + jaw.mouthDirection.z * a * s + jaw.normal.z * q * c },
        p1: {
          x: jaw.tangent.x + jaw.mouthDirection.x * extension - jaw.normal.x * table.cushionBackDepth,
          z: jaw.tangent.z + jaw.mouthDirection.z * extension - jaw.normal.z * table.cushionBackDepth,
        },
        normal: { x: (jaw.mouthDirection.x * q * s + jaw.normal.x * a * c) / length, z: (jaw.mouthDirection.z * q * s + jaw.normal.z * a * c) / length },
        id: `return-${jaw.id}`,
      };
    }) : [];

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

  // Open play-facing boundary of a single cloth-covered cushion. The nose
  // joins both mouth arcs tangentially, then continues to the rail backing.
  // Insets describe the rubber/cloth cross-section, never separate jaw discs.
  // Rendering and contacts use the same corner radius, middle ellipse and tangents.
  function roundedCushionContour(table, segment, inset = 0, steps = 24) {
    const q = table.jawRadius, path = [];
    const point = (along, depth, alongNormal, faceNormal) => {
      const xAxis = segment.axis === 'x';
      path.push({
        x: (xAxis ? along : segment.value) - segment.normal.x * depth,
        z: (xAxis ? segment.value : along) - segment.normal.z * depth,
        nx: (xAxis ? alongNormal : 0) + segment.normal.x * faceNormal,
        nz: (xAxis ? 0 : alongNormal) + segment.normal.z * faceNormal,
        depth,
      });
    };
    const isSide = (end) => segment.axis === 'x' && Math.abs(Math.abs(end) - table.sideGap) < 1e-9;
    const leftAngle = isSide(segment.min) ? table.sideReturnAngle : table.cornerReturnAngle;
    const rightAngle = isSide(segment.max) ? table.sideReturnAngle : table.cornerReturnAngle;
    const arcPoint = (end, sign, angle) => {
      const a = isSide(end) ? (table.sideJawRadius || q) : q;
      const s = Math.sin(angle), c = Math.cos(angle), length = Math.hypot(q * s, a * c);
      const alongNormal = q * s / length, faceNormal = a * c / length;
      point(end + sign * (a * s - inset * alongNormal), q - q * c + inset * faceNormal, sign * alongNormal, faceNormal);
    };
    point(segment.min - cushionEndExtension(table, isSide(segment.min), table.cushionBackDepth, inset), table.cushionBackDepth, -Math.sin(leftAngle), Math.cos(leftAngle));
    for (let i = steps; i >= 0; i -= 1) {
      const angle = i / steps * leftAngle;
      arcPoint(segment.min, -1, angle);
    }
    for (let i = 0; i <= steps; i += 1) {
      const angle = i / steps * rightAngle;
      arcPoint(segment.max, 1, angle);
    }
    point(segment.max + cushionEndExtension(table, isSide(segment.max), table.cushionBackDepth, inset), table.cushionBackDepth, Math.sin(rightAngle), Math.cos(rightAngle));
    return path;
  }

  function cushionEndExtension(table, side, depth, inset = 0) {
    const angle = side ? table.sideReturnAngle : table.cornerReturnAngle;
    if (side && table.sideJawRadius) return table.sideJawRadius - inset;
    return (table.jawRadius - inset) / Math.sin(angle) + (depth - table.jawRadius) / Math.tan(angle);
  }

  // Signed aperture coordinates, with the closest lip point when requested.
  // The inexpensive ellipse test is shared with the rendering cutout.
  function pocketCoordinates(pocket, position, withEdge = false) {
    const dx = position.x - pocket.x, dz = position.z - pocket.z;
    const n = pocket.outward;
    const along = dx * n.x + dz * n.z;
    const across = -dx * n.z + dz * n.x;
    const a = pocket.radiusAlong, b = pocket.radiusAcross;
    const norm = Math.hypot(along / a, across / b);
    if (!withEdge) return { along, across, norm };
    let theta = Math.atan2(across / b, along / a);
    // Newton projection onto the ellipse. Only evaluated near a pocket, and
    // bounded to avoid the ambiguous closest point at an ellipse's centre.
    for (let i = 0; i < 5; i += 1) {
      const c = Math.cos(theta), s = Math.sin(theta);
      const ex = a * c - along, ez = b * s - across;
      const first = ex * (-a * s) + ez * b * c;
      const second = a * a * s * s + b * b * c * c - ex * a * c - ez * b * s;
      if (Math.abs(second) < 1e-9) break;
      theta -= clamp(first / second, -0.25, 0.25);
    }
    const u = a * Math.cos(theta), v = b * Math.sin(theta);
    return { along, across, norm,
      edge: { x: pocket.x + n.x * u - n.z * v, z: pocket.z + n.z * u + n.x * v },
    };
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
      pocketFall: null,
      railContact: null,
      railTravel: null,
      // Cushions the ball was frozen to when the stroke began, until it
      // leaves them (CBSA §13.2, WPA §2.7).
      frozenRails: null,
      lastSpeed: 0,
      offTable: false,
    };
  }

  // A real rack is frozen — CBSA §3 requires the balls to touch (彼此紧贴) —
  // but never a perfect lattice: diameters vary by ±0.05 mm and a racked set
  // settles a few hundredths of a millimetre out of true.  A mathematically
  // perfect lattice with equal gaps passes a head-on break straight through
  // to the two back corners like a Newton's cradle and leaves the rest of
  // the rack dead, so each rack gets a small seeded disorder, then is relaxed
  // until no pair overlaps.
  const RACK_GAP = 0.00002;
  const RACK_DISORDER = 0.00005;

  function rackRandom(seed) {
    let state = (seed >>> 0) || 1;
    return () => {
      state = (state + 0x6D2B79F5) >>> 0;
      let t = Math.imul(state ^ (state >>> 15), state | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function disorderRack(balls, seed) {
    const random = rackRandom(seed);
    for (const ball of balls) {
      ball.pos.x += (random() - 0.5) * 2 * RACK_DISORDER;
      ball.pos.z += (random() - 0.5) * 2 * RACK_DISORDER;
    }
    for (let pass = 0; pass < 200; pass += 1) {
      let moved = false;
      for (let i = 0; i < balls.length; i += 1) {
        for (let j = i + 1; j < balls.length; j += 1) {
          const a = balls[i], b = balls[j];
          const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z;
          const distance = Math.hypot(dx, dz), touching = a.radius + b.radius + 1e-6;
          if (distance >= touching) continue;
          const push = (touching - distance) / 2 + 1e-9;
          a.pos.x -= dx / distance * push; a.pos.z -= dz / distance * push;
          b.pos.x += dx / distance * push; b.pos.z += dz / distance * push;
          moved = true;
        }
      }
      if (!moved) break;
    }
    return balls;
  }

  function rackPool(mode, params, table, seed = 1) {
    const balls = [makeBall({ id: 'cue', label: '母球', kind: 'cue', color: '#f0f3eb', x: table.cueStart, z: 0 }, params)];
    const R = params.radius;
    const spacing = 2 * R + RACK_GAP;
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
      // WPA (2025) §5.2: the 9 sits in the middle of the diamond ON the foot
      // spot, the 1 at the apex toward the head string, two rows ahead.
      const order = [1, 2, 3, 4, 9, 5, 6, 7, 8];
      const counts = [1, 2, 3, 2, 1];
      const apex = table.rackApex - Math.sqrt(3) * spacing;
      let index = 0;
      counts.forEach((count, row) => {
        const x = apex + row * Math.sqrt(3) * (spacing / 2);
        for (let j = 0; j < count; j += 1) {
          const number = order[index++];
          const z = (j - (count - 1) / 2) * spacing;
          balls.push(makeBall({ id: String(number), number, kind: number > 8 ? 'stripe' : 'solid', color: POOL_COLORS[number], x, z }, params));
        }
      });
      disorderRack(balls.slice(1), seed);
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
    disorderRack(balls.slice(1), seed);
    return balls;
  }

  // WPBSA spots: yellow, green and brown on the baulk line at the D's
  // corners and centre (viewed from baulk, yellow on the right, +z), blue on
  // the centre spot, pink midway between blue and the top cushion face,
  // black 324 mm from it.
  function snookerSpots(table) {
    const baulk = -table.width / 2 + table.baulkFromCushion;
    return {
      baulk, dRadius: table.dRadius,
      yellow: { x: baulk, z: table.dRadius }, green: { x: baulk, z: -table.dRadius }, brown: { x: baulk, z: 0 },
      blue: { x: 0, z: 0 }, pink: { x: table.width / 4, z: 0 }, black: { x: table.width / 2 - table.blackFromCushion, z: 0 },
      // Break-off position inside the D, left of the brown.
      cue: { x: baulk - 0.07, z: -0.18 },
    };
  }

  function rackSnooker(params, table, seed = 1) {
    const balls = [];
    const R = params.radius;
    const spacing = 2 * R + RACK_GAP;
    const spots = snookerSpots(table);
    balls.push(makeBall({ id: 'cue', label: '母球', kind: 'cue', color: SNOOKER_COLORS.cue, x: spots.cue.x, z: spots.cue.z }, params));
    const colors = [
      ['yellow', '黄球', 2], ['green', '绿球', 3], ['brown', '棕球', 4],
      ['blue', '蓝球', 5], ['pink', '粉球', 6], ['black', '黑球', 7],
    ];
    colors.forEach(([id, label, value]) => balls.push(makeBall({ id, label, value, kind: 'snooker', color: SNOOKER_COLORS[id], x: spots[id].x, z: spots[id].z }, params)));
    // The apex red as close behind the pink as possible without touching it.
    const apex = spots.pink.x + 2 * R + 0.002;
    let red = 1;
    for (let row = 0; row < 5; row += 1) {
      const x = apex + row * Math.sqrt(3) * (spacing / 2);
      for (let j = 0; j <= row; j += 1) {
        balls.push(makeBall({ id: `red${red}`, label: `红球 ${red}`, value: 1, kind: 'snooker', color: SNOOKER_COLORS.red, x, z: (j - row / 2) * spacing }, params));
        red += 1;
      }
    }
    disorderRack(balls.filter((ball) => ball.value === 1), seed);
    return balls;
  }

  function cloneBall(ball) {
    return {
      ...ball,
      pos: { ...ball.pos }, vel: { ...ball.vel }, omega: { ...ball.omega }, rotation: [...ball.rotation],
      sinkTarget: ball.sinkTarget ? { ...ball.sinkTarget } : null,
      railContact: ball.railContact ? {
        ...ball.railContact,
        grip: Object.fromEntries(Object.entries(ball.railContact.grip).map(([id, grip]) => [id, { ...grip }])),
      } : null,
      railTravel: ball.railTravel ? { ...ball.railTravel } : null,
      frozenRails: ball.frozenRails ? [...ball.frozenRails] : null,
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
      // The rack's small disorder is seeded: the default seed keeps tests and
      // shared links reproducible, while the app draws a fresh seed per rack.
      this.rackSeed = Number.isFinite(options.rackSeed) ? options.rackSeed : 1;
      this.setMode(mode);
    }

    setMode(mode, rackSeed = this.rackSeed) {
      this.mode = mode;
      this.rackSeed = rackSeed;
      const snooker = mode === 'snooker';
      const chinese = mode === 'chineseEight';
      this.params = { ...(snooker ? SNOOKER_PARAMS : chinese ? CHINESE_PARAMS : POOL_PARAMS) };
      this.table = configureTable(snooker ? 'snooker' : chinese ? 'chinese' : 'pool');
      this.balls = snooker ? rackSnooker(this.params, this.table, rackSeed) : rackPool(mode, this.params, this.table, rackSeed);
      this.setClothPreset('standard');
      this.time = 0;
      this.shotTime = 0;
      this.inShot = false;
      this.lastCueMetrics = null;
      this.lastCushionEvent = null;
      this.collisionCooldown.clear();
    }

    reset(mode = this.mode, rackSeed = this.rackSeed) {
      this.setMode(mode, rackSeed);
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
      // A hard break sends the cue ball at roughly 8–11 m/s.
      const speedInput = clamp(options.speed || 1, 0.05, 10);
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
      // while keeping the reference b/R ≈ 0.5 boundary.  Speed, spin and
      // squirt below all use the contact offsets (contactX/contactY).
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
      // Where the curved tip actually meets the ball, as a fraction of R.
      const contactX = tipX * contactScale, contactY = tipY * contactScale;
      const contactOffset = offset * contactScale;
      const ballMass = cue?.mass || this.params.mass;
      const cueRestitution = 0.73;
      const transfer = (1 + cueRestitution) * spec.cueMass / (spec.cueMass + ballMass);
      const referenceTransfer = (1 + cueRestitution) * 0.525 / (0.525 + 0.1695);
      // Beyond the chalk-friction envelope the tip skids off: a deterministic
      // miscue keeps prediction honest — most momentum and nearly all
      // controlled spin are lost and the deflection roughly doubles.
      const requestedOffsetEarly = Math.hypot(requestedTipX, requestedTipY);
      const miscue = requestedOffsetEarly > safeOffset + 1e-9;
      // Rigid tip impulse (Alciatore TP A.30): an off-centre hit spends part
      // of the same stroke on spin, so for a given cue speed the ball leaves
      // slower by (1 + m_b/m_s) / (1 + m_b/m_s + 2.5 (b/R)²) — about 0.66 at
      // the miscue limit, where the old 1 - 0.082·offset² kept 0.96 and a
      // maximum-English ball carried more energy than a centre hit.
      const massShare = ballMass / spec.cueMass;
      const offCentre = (1 + massShare) / (1 + massShare + 2.5 * contactOffset * contactOffset);
      let efficiency = transfer / referenceTransfer * spec.powerEfficiency * tipSpec.energyEfficiency * offCentre;
      if (miscue) efficiency *= 0.30;
      const speed = speedInput * efficiency;
      // Rigid-impulse squirt (Cross 2008): the gripping tip must accelerate
      // sideways with the contact point, and the shaft's effective end mass
      // resists that, deflecting the ball opposite to the English:
      //   tan α = (5/2)(b/R)c / (1 + (5/2)c² + M/mₑ),  c = √(1 − (b/R)²).
      // Squirt is nearly speed-independent, matching Dr. Dave's measurements.
      const contactCos = Math.sqrt(Math.max(0.14, 1 - contactOffset * contactOffset));
      const massRatio = ballMass / spec.effectiveEndMass;
      let squirt = -Math.atan(
        (2.5 * contactX * contactCos) / (1 + 2.5 * contactCos * contactCos + massRatio),
      );
      if (miscue) squirt *= 1.8;
      const cs = Math.cos(squirt), ss = Math.sin(squirt);
      direction = { x: direction.x * cs - direction.z * ss, z: direction.x * ss + direction.z * cs };
      // Spin is ω = (5/2)·v·b/R² for the contact offset b, never more: a
      // ball cannot leave a level cue with ωR/v above 2.5·b/R.  Squirt turns
      // the ball away from the English, shortening the side lever arm to
      // R·sin(asin(b/R) − α) (TP B.7), so the practical maximum is ωR/v ≈
      // 1.2 — Dr Dave's measured range, where the old tuning reached 1.44.
      const sideLever = Math.sign(contactX) * Math.sin(Math.max(0, Math.asin(Math.min(1, Math.abs(contactX))) - Math.abs(squirt)));
      const angularScale = 2.5 * speed * (miscue ? 0.25 : 1) * spec.spinEfficiency * tipSpec.spinTransfer / R;
      const sideTorque = sideLever * angularScale;
      // Vertical tip offset always torques about the horizontal side axis, so
      // follow/draw take no cos(elevation) factor; the side-spin axis tilts
      // with the cue, which is what later bends elevated-English shots.
      const omega = {
        x: direction.z * contactY * angularScale + direction.x * sideTorque * Math.sin(elevation),
        y: sideTorque * Math.cos(elevation),
        z: -direction.x * contactY * angularScale + direction.z * sideTorque * Math.sin(elevation),
      };
      // The impulse points forward-and-down along the cue.  The slate stops
      // the downward part and returns some of it as a hop (the legal jump/
      // massé mechanism); tiny vertical speeds are swallowed by the cloth.
      const downSpeed = speed * Math.sin(elevation);
      const liftSpeed = downSpeed * SLATE_RESTITUTION;
      const launchSpeed = liftSpeed > 0.30 ? liftSpeed : 0;
      // That slate reaction is itself a sliding friction contact (TP B.10):
      // an elevated stroke loses some speed and draw at once, and a massé
      // starts to turn before it even leaves the slate.
      const kicked = { x: direction.x * speed * Math.cos(elevation), z: direction.z * speed * Math.cos(elevation) };
      slateFrictionKick(kicked, omega, R, ballMass, cue?.inertia || 0.4 * ballMass * R * R,
        this.params.muSlide, ballMass * (downSpeed + launchSpeed));
      const horizontalSpeed = Math.hypot(kicked.x, kicked.z);
      if (horizontalSpeed > 1e-9) direction = { x: kicked.x / horizontalSpeed, z: kicked.z / horizontalSpeed };
      const miscueMargin = safeOffset - requestedOffsetEarly;
      const aimAllowancePerMetre = Math.tan(Math.abs(squirt));
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
      return this.balls.some((b) => b.pocketed ? Boolean(b.sinkTarget && b.sinkDepth < 0.22) : (
        b.railContact != null || b.pocketFall != null
        || Math.hypot(b.vel.x, b.vel.z) > 0.005
        || Math.hypot(b.omega.x, b.omega.y, b.omega.z) > 0.85
        || b.posY > 1e-4 || Math.abs(b.velY) > 0.05
      ));
    }

    strike(options) {
      const cue = this.getCueBall();
      if (!cue || cue.pocketed || this.isMoving()) return false;
      for (const ball of this.balls) {
        ball.railTravel = null;
        // A ball resting against a cushion has not been "driven to" it until
        // it leaves and comes back; its contacts with it are marked frozen.
        const touching = ball.pocketed ? [] : this.railsTouching(ball, 0.0005);
        ball.frozenRails = touching.length ? touching : null;
      }
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
      // The shelf and boot meet over millimetres. Refine the whole world
      // together near a live mouth contact so collisions keep their order
      // and normal playback agrees with deeply slowed playback.
      if (dt > POCKET_STEP * (1 + 1e-8)) {
        const nearPocket = this.balls.some((ball) => {
          if (ball.pocketed) return ball.sinkTarget && ball.sinkDepth < 0.06;
          if (ball.pocketFall) return true;
          const speed = Math.hypot(ball.vel.x, ball.vel.z);
          if (speed < 0.005 && !ball.velY) return false;
          const guard = this.table.pocketGuard + ball.radius + speed * dt;
          if (Math.abs(ball.pos.x) < this.table.width / 2 - guard && Math.abs(ball.pos.z) < this.table.height / 2 - guard) return false;
          return this.table.pockets.some((pocket) => Math.hypot(ball.pos.x - pocket.x, ball.pos.z - pocket.z)
            < Math.max(pocket.radiusAlong, pocket.radiusAcross) + ball.radius + speed * dt);
        });
        if (nearPocket) {
          const count = Math.ceil(dt / POCKET_STEP);
          for (let i = 0; i < count; i += 1) this.step(dt / count);
          return;
        }
      }
      this.time += dt;
      if (this.inShot) this.shotTime += dt;

      for (const ball of this.balls) {
        if (ball.pocketed) {
          ball.sinkTime += dt;
          if (ball.sinkTarget && ball.sinkDepth < 0.22) {
            ball.posY += ball.velY * dt - 0.5 * G * dt * dt;
            ball.velY -= G * dt;
            ball.pos.x += ball.vel.x * dt;
            ball.pos.z += ball.vel.z * dt;
            const pocket = this.table.pockets.find((p) => p.id === ball.pocketId);
            if (pocket) this.resolvePocketLiner(ball, pocket);
            const damping = Math.exp(-1.8 * dt);
            ball.vel.x *= damping; ball.vel.z *= damping;
            Quat.integrate(ball.rotation, ball.omega, dt);
            ball.omega.x *= damping; ball.omega.y *= damping; ball.omega.z *= damping;
            ball.sinkDepth = Math.min(0.22, -ball.posY);
            if (ball.sinkDepth >= 0.22) {
              ball.posY = -0.22;
              ball.vel = { x: 0, z: 0 }; ball.velY = 0;
            }
          }
          continue;
        }
        // Airborne balls (jump/massé) keep their spin frozen and feel only
        // gravity; the cloth solver takes over again on landing, after a
        // single friction kick from the touchdown impulse.
        if (ball.pocketFall) {
          ball.posY += ball.velY * dt - 0.5 * G * dt * dt;
          ball.velY -= G * dt;
          ball.state = 'falling';
        } else if (ball.posY > 1e-6 || ball.velY > 1e-6) {
          ball.posY += ball.velY * dt - 0.5 * G * dt * dt;
          ball.velY -= G * dt;
          if (ball.posY <= 0) {
            ball.posY = 0;
            this.landBall(ball);
            ball.velY = -ball.velY * SLATE_RESTITUTION;
            if (ball.velY < 0.30) ball.velY = 0;
            ball.state = ball.velY > 0 ? 'airborne' : 'sliding';
          } else {
            ball.state = 'airborne';
          }
        } else if (!ball.railContact && !restingBall(ball)) {
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
        // A still ball keeps its orientation bit for bit: renormalising an
        // unchanged quaternion jitters its last digits, which made every idle
        // frame look new to the renderer's frame cache.
        if (ball.omega.x || ball.omega.y || ball.omega.z) Quat.integrate(ball.rotation, ball.omega, dt);
      }

      // Two sequential impulse passes make clustered racks stable at the fixed rate.
      for (let pass = 0; pass < 2; pass += 1) {
        this.resolveBallPairs(dt);
        for (const ball of this.balls) {
          if (!ball.pocketed) this.resolveCushions(ball, dt);
        }
      }

      for (const ball of this.balls) if (!ball.pocketed) {
        this.checkPocket(ball);
        if (ball.frozenRails) {
          // More than 3 mm off a cushion is leaving it.
          const still = this.railsTouching(ball, 0.003);
          ball.frozenRails = ball.frozenRails.filter((id) => still.includes(id));
          if (!ball.frozenRails.length) ball.frozenRails = null;
        }
        // Observe real separation between consecutive contacts. A spin ratio
        // alone is not evidence of rail absorption or a return to the rail.
        if (ball.railTravel && !ball.railContact && !ball.pocketed) {
          const travel = ball.railTravel;
          const distance = (ball.pos.x - travel.x) * travel.nx + (ball.pos.z - travel.z) * travel.nz;
          travel.maxDistance = Math.max(travel.maxDistance, distance);
          if (distance > 0.003 && ball.vel.x * travel.nx + ball.vel.z * travel.nz < -0.005) travel.reversed = true;
        }
      }
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
      // A rebound too small to leave the cloth (< 0.3 m/s) is absorbed, so the
      // normal impulse is then just the arrest m·|v_y|.
      const rebound = impactSpeed * SLATE_RESTITUTION;
      slateFrictionKick(ball.vel, ball.omega, ball.radius, ball.mass, ball.inertia, this.params.muSlide,
        ball.mass * (impactSpeed + (rebound < 0.30 ? 0 : rebound)));
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

      let rollTime = dt;
      if (slip > 1e-7) {
        // Contact-slip decays 3.5× as fast as the centre velocity because friction also spins the sphere.
        const acceleration = this.params.muSlide * G * clothResistance;
        const slideTime = Math.min(dt, slip / (3.5 * acceleration));
        const ax = -acceleration * slipX / slip;
        const az = -acceleration * slipZ / slip;
        ball.vel.x += ax * slideTime;
        ball.vel.z += az * slideTime;
        ball.omega.x += -(2.5 / R) * az * slideTime;
        ball.omega.z += (2.5 / R) * ax * slideTime;
        rollTime = dt - slideTime;
        ball.state = 'sliding';
      }
      const rollingSpeed = Math.hypot(ball.vel.x, ball.vel.z);
      if (rollTime > 0 && rollingSpeed > 0.004) {
        const deceleration = this.params.muRoll * G * clothResistance;
        const dv = Math.min(rollingSpeed, deceleration * rollTime);
        ball.vel.x -= ball.vel.x / rollingSpeed * dv;
        ball.vel.z -= ball.vel.z / rollingSpeed * dv;
        ball.omega.x = ball.vel.z / R;
        ball.omega.z = -ball.vel.x / R;
        ball.state = 'rolling';
      }

      const spin = Math.abs(ball.omega.y);
      if (spin > 0) {
        // Coulomb pivot friction over the contact patch: a constant torque,
        // so a constant deceleration (≈10.9 rad/s² here). Dr Dave's spin-down
        // videos measure ≈10 rad/s² (range 5–15, TP B.2) with no dependence
        // on spin rate; pooltool uses the same constant. A rate-dependent
        // boost once doubled it at full English and bled running/reverse
        // English away before the ball reached the rail.
        const spinDeceleration = 2.5 * this.params.muSpin * G / R;
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
      const dx = b.pos.x - a.pos.x;
      // posY is the underside height, not the centre height. Use the full
      // sphere distance (including unequal radii) in geometry AND in TOI.
      const dy = b.posY + b.radius - a.posY - a.radius;
      const dz = b.pos.z - a.pos.z;
      const minDistance = a.radius + b.radius;
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (distanceSq >= minDistance * minDistance) return null;
      const rvx = b.vel.x - a.vel.x, rvy = b.velY - a.velY, rvz = b.vel.z - a.vel.z;
      const closing = dx * rvx + dy * rvy + dz * rvz;
      const relSpeedSq = rvx * rvx + rvy * rvy + rvz * rvz;
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
          const dx = b.pos.x - a.pos.x, dy = b.posY + b.radius - a.posY - a.radius, dz = b.pos.z - a.pos.z;
          const distance = Math.hypot(dx, dy, dz);
          const nx = distance > 1e-8 ? dx / distance : 1;
          const ny = distance > 1e-8 ? dy / distance : 0;
          const nz = distance > 1e-8 ? dz / distance : 0;
          if (Math.abs(ny) > 1e-8) {
            // The slate only prevents downward correction; it cannot pin an
            // airborne ball to a two-dimensional circle or pull a ball down.
            const invA = a.railContact ? 0 : 1 / a.mass, invB = b.railContact ? 0 : 1 / b.mass;
            const yA = !a.pocketFall && a.posY <= 1e-8 && ny > 0 ? 0 : invA;
            const yB = !b.pocketFall && b.posY <= 1e-8 && ny < 0 ? 0 : invB;
            const mobility = (nx * nx + nz * nz) * (invA + invB) + ny * ny * (yA + yB);
            if (mobility > 1e-12) {
              const correction = Math.max(0, contact.minDistance - distance + 1e-5) * 0.76 / mobility;
              a.pos.x -= nx * correction * invA; a.pos.z -= nz * correction * invA;
              b.pos.x += nx * correction * invB; b.pos.z += nz * correction * invB;
              a.posY -= ny * correction * yA; b.posY += ny * correction * yB;
            }
            continue;
          }
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
      let done = null;
      for (let round = 0; round < balls.length * balls.length; round += 1) {
        const contacts = [];
        for (let i = 0; i < balls.length; i += 1) {
          const a = balls[i];
          if (a.pocketed) continue;
          for (let j = i + 1; j < balls.length; j += 1) {
            const b = balls[j];
            if (b.pocketed || (done && done.has(i * balls.length + j))) continue;
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
        done ||= new Set();
        for (const c of cluster) done.add(c.key);
      }
    }

    resolveContactCluster(cluster, bodies, toi) {
      if (bodies.some(spatialBall) || cluster.some(c => Math.abs(c.a.radius - c.b.radius) > 1e-8)) {
        this.resolveSpatialContactCluster(cluster, bodies, toi);
        return;
      }
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
          incomingA: { ...a.vel, y: a.velY }, incomingB: { ...b.vel, y: b.velY },
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
          a.railTravel = b.railTravel = null;
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
              incomingA: c.incomingA, incomingB: c.incomingB,
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

    // Airborne pairs need spatial normals, translational vertical impulses
    // and a unilateral slate reaction. Keep the established planar solver
    // for ordinary shots; only genuinely spatial clusters take this path.
    resolveSpatialContactCluster(cluster, bodies, toi) {
      for (const ball of bodies) {
        if (ball.railContact || !(toi > 0)) continue;
        ball.pos.x -= ball.vel.x * toi; ball.pos.z -= ball.vel.z * toi;
        ball.posY -= ball.velY * toi;
        if (!ball.pocketFall) ball.posY = Math.max(0, ball.posY);
      }
      const live = [];
      for (const { a, b } of cluster) {
        const dx = b.pos.x - a.pos.x, dy = b.posY + b.radius - a.posY - a.radius, dz = b.pos.z - a.pos.z;
        const distance = Math.hypot(dx, dy, dz);
        const nx = distance > 1e-10 ? dx / distance : 1;
        const ny = distance > 1e-10 ? dy / distance : 0;
        const nz = distance > 1e-10 ? dz / distance : 0;
        const preRelN = (b.vel.x - a.vel.x) * nx + (b.velY - a.velY) * ny + (b.vel.z - a.vel.z) * nz;
        if (preRelN >= -1e-5) continue;
        const flat = Math.hypot(nx, nz);
        const tx = flat > 1e-8 ? -nz / flat : 1, tz = flat > 1e-8 ? nx / flat : 0;
        const ux = -tz * ny, uy = tz * nx - tx * nz, uz = tx * ny;
        live.push({ a, b, nx, ny, nz, tx, tz, ux, uy, uz, preRelN,
          incomingA: { ...a.vel, y: a.velY }, incomingB: { ...b.vel, y: b.velY },
          invA: 1 / a.mass, invB: 1 / b.mass, lambda: 0, jt: 0, ju: 0, mu: 0 });
      }
      const floors = bodies.filter(b => !b.pocketFall && b.posY <= 1e-8)
        .map(ball => ({ ball, lambda: 0, jx: 0, jz: 0 }));
      const normal = c => {
        const rel = (c.b.vel.x - c.a.vel.x) * c.nx + (c.b.velY - c.a.velY) * c.ny + (c.b.vel.z - c.a.vel.z) * c.nz;
        const next = Math.max(0, c.lambda - (rel + this.params.restitutionBall * c.preRelN) / (c.invA + c.invB));
        const change = next - c.lambda; c.lambda = next;
        c.a.vel.x -= c.nx * change * c.invA; c.a.velY -= c.ny * change * c.invA; c.a.vel.z -= c.nz * change * c.invA;
        c.b.vel.x += c.nx * change * c.invB; c.b.velY += c.ny * change * c.invB; c.b.vel.z += c.nz * change * c.invB;
        return Math.abs(change);
      };
      const floorNormal = f => {
        const next = Math.max(0, f.lambda - f.ball.mass * f.ball.velY);
        const change = next - f.lambda; f.lambda = next;
        f.ball.velY += change / f.ball.mass;
        return Math.abs(change);
      };
      const slip = c => {
        const wx = c.a.radius * c.a.omega.x + c.b.radius * c.b.omega.x;
        const wy = c.a.radius * c.a.omega.y + c.b.radius * c.b.omega.y;
        const wz = c.a.radius * c.a.omega.z + c.b.radius * c.b.omega.z;
        const x = c.b.vel.x - c.a.vel.x - (wy * c.nz - wz * c.ny);
        const y = c.b.velY - c.a.velY - (wz * c.nx - wx * c.nz);
        const z = c.b.vel.z - c.a.vel.z - (wx * c.ny - wy * c.nx);
        return { t: x * c.tx + z * c.tz, u: x * c.ux + y * c.uy + z * c.uz };
      };
      const friction = c => {
        const v = slip(c), { a, b } = c;
        const mobility = c.invA + c.invB + a.radius ** 2 / a.inertia + b.radius ** 2 / b.inertia;
        let jt = c.jt - v.t / mobility, ju = c.ju - v.u / mobility;
        const magnitude = Math.hypot(jt, ju), limit = c.mu * c.lambda;
        if (magnitude > limit && magnitude > 0) { jt *= limit / magnitude; ju *= limit / magnitude; }
        const dt = jt - c.jt, du = ju - c.ju; c.jt = jt; c.ju = ju;
        const x = dt * c.tx + du * c.ux, y = du * c.uy, z = dt * c.tz + du * c.uz;
        a.vel.x -= x * c.invA; a.velY -= y * c.invA; a.vel.z -= z * c.invA;
        b.vel.x += x * c.invB; b.velY += y * c.invB; b.vel.z += z * c.invB;
        const crossX = c.ny * z - c.nz * y, crossY = c.nz * x - c.nx * z, crossZ = c.nx * y - c.ny * x;
        for (const ball of [a, b]) {
          ball.omega.x -= crossX * ball.radius / ball.inertia;
          ball.omega.y -= crossY * ball.radius / ball.inertia;
          ball.omega.z -= crossZ * ball.radius / ball.inertia;
        }
        return Math.hypot(dt, du);
      };
      const floorFriction = f => {
        const b = f.ball, R = b.radius, mobility = 1 / b.mass + R * R / b.inertia;
        let jx = f.jx - (b.vel.x + b.omega.z * R) / mobility;
        let jz = f.jz - (b.vel.z - b.omega.x * R) / mobility;
        const magnitude = Math.hypot(jx, jz), limit = this.params.muSlide * f.lambda;
        if (magnitude > limit && magnitude > 0) { jx *= limit / magnitude; jz *= limit / magnitude; }
        const dx = jx - f.jx, dz = jz - f.jz; f.jx = jx; f.jz = jz;
        b.vel.x += dx / b.mass; b.vel.z += dz / b.mass;
        b.omega.x -= R * dz / b.inertia; b.omega.z += R * dx / b.inertia;
        return Math.hypot(dx, dz);
      };
      // Establish the shared post-normal state before sampling μ(slip), then
      // couple normal/friction/slate impulses. The floor may push, never pull;
      // an upward impact is therefore free to launch a formerly resting ball.
      for (let iter = 0; iter < 60; iter += 1) {
        let change = 0;
        for (let i = 0; i < live.length; i += 1) change = Math.max(change, normal(live[iter % 2 ? live.length - 1 - i : i]));
        for (const floor of floors) change = Math.max(change, floorNormal(floor));
        if (change < 1e-12) break;
      }
      for (const c of live) { const v = slip(c); c.mu = ballBallFriction(Math.hypot(v.t, v.u)); }
      for (let iter = 0; iter < 80; iter += 1) {
        let change = 0;
        for (let i = 0; i < live.length; i += 1) {
          const c = live[iter % 2 ? live.length - 1 - i : i];
          change = Math.max(change, normal(c), friction(c));
        }
        for (const floor of floors) change = Math.max(change, floorNormal(floor), floorFriction(floor));
        if (change < 1e-11) break;
      }
      for (const c of live) {
        const { a, b } = c;
        a.railTravel = b.railTravel = null;
        const key = a.id < b.id ? `${a.id}|${b.id}` : `${b.id}|${a.id}`;
        const previous = this.collisionCooldown.get(key) || -1;
        if (this.time - previous > 0.028) {
          this.collisionCooldown.set(key, this.time);
          this.emit({ type: 'ball-ball', aId: a.id, bId: b.id, impulse: c.lambda,
            speed: Math.abs(c.preRelN),
            position: { x: a.pos.x + c.nx * a.radius, y: a.posY + a.radius + c.ny * a.radius, z: a.pos.z + c.nz * a.radius },
            normal: { x: c.nx, y: c.ny, z: c.nz },
            incomingA: c.incomingA, incomingB: c.incomingB });
        }
      }
      for (const ball of bodies) {
        if (!ball.railContact && toi > 0) {
          ball.pos.x += ball.vel.x * toi; ball.pos.z += ball.vel.z * toi;
          ball.posY += ball.velY * toi;
        }
        if (!ball.pocketFall && ball.posY < 0) {
          ball.posY = 0;
          this.landBall(ball);
          ball.velY = Math.max(0, -ball.velY * SLATE_RESTITUTION);
          if (ball.velY < 0.30) ball.velY = 0;
        }
        ball.state = spatialBall(ball) ? 'airborne' : 'sliding';
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
      const deepest = (list) => list.reduce((best, c) => (c.depth > best.depth ? c : best));
      let primary = deepest(contacts);
      let approach = -(ball.vel.x * primary.nx + ball.vel.z * primary.nz);
      // Resting contact: hold the ball on the surface without exciting the
      // spring, so frozen balls stay put and never ring against the rubber.
      if (primary.depth < 2e-5 && Math.abs(approach) < 0.006) {
        for (const c of contacts) {
          ball.pos.x += c.nx * c.depth;
          ball.pos.z += c.nz * c.depth;
        }
        return;
      }
      // Rewind to the true first-touch point, keeping ~10 µm of engagement so
      // the first sub-step still sees the contact it is about to compress.
      // The touch is bisected along this step's straight path rather than
      // estimated as depth / normal speed: on a round jaw a fast ball sliding
      // along the arc gains depth much faster than its normal speed alone
      // explains, the linear estimate rewound it clear of the rubber, and the
      // episode then ended before any force acted — hard balls tunnelled
      // through the jaws, making tight pockets more forgiving at speed.
      const endX = ball.pos.x, endZ = ball.pos.z;
      const engagement = (rewind) => {
        ball.pos.x = endX - ball.vel.x * rewind;
        ball.pos.z = endZ - ball.vel.z * rewind;
        const found = this.scanCushionContacts(ball);
        return found.length ? deepest(found).depth : 0;
      };
      let rewound = 0;
      if (engagement(dt) > 1e-5) {
        // The ball was already in the rubber when this step began (a
        // mid-step impulse redirected it, or it slipped through a collider
        // gap).  That penetration was never absorbed by this spring: claim
        // the whole step and snap the entry to the engagement depth, so an
        // episode only ever returns work it really accumulated — monetising
        // 4 mm of phantom compression once turned into +3.8 J.
        rewound = dt;
        const start = deepest(this.scanCushionContacts(ball));
        if (start.depth > 4e-5) {
          const pushOut = start.depth - 1e-5;
          ball.pos.x += start.nx * pushOut;
          ball.pos.z += start.nz * pushOut;
        }
      } else {
        let inside = 0, outside = dt;
        while (outside - inside > 1e-9) {
          const mid = 0.5 * (inside + outside);
          if (engagement(mid) > 1e-5) inside = mid; else outside = mid;
        }
        rewound = inside;
        engagement(rewound);
        // A contact that already runs deep where it begins is not this
        // rubber being compressed: the ball slid into the end of a cushion's
        // span (typically in flight, from behind the nose line) and the
        // depth jumped there.  Snap it to the engagement depth as above, or
        // the spring pays out energy it never stored (a 0.1 m jump once
        // launched a ball at 200 m/s).
        const found = this.scanCushionContacts(ball);
        const entry = found.length ? deepest(found) : null;
        if (entry && entry.depth > 4e-5) {
          const pushOut = entry.depth - 1e-5;
          ball.pos.x += entry.nx * pushOut;
          ball.pos.z += entry.nz * pushOut;
        }
      }
      const touch = this.scanCushionContacts(ball);
      if (touch.length) {
        primary = deepest(touch);
        approach = -(ball.vel.x * primary.nx + ball.vel.z * primary.nz);
      }
      this.beginRailContact(ball, primary, approach);
      this.integrateRailContact(ball, rewound, dt);
    }

    // Ids of the cushion pieces within `slack` of the ball's surface.
    railsTouching(ball, slack) {
      return this.scanCushionContacts({ pos: ball.pos, radius: ball.radius + slack }).map((contact) => contact.id);
    }

    // Pure contact geometry.  Straight cushion planes, round jaw arcs and flat
    // pocket facings all reduce to a unit normal plus a penetration depth; the
    // jaw owns the mouth side of each straight-to-round tangent so a grazing
    // ball never collects two conflicting normals.
    scanCushionContacts(ball) {
      const R = ball.radius;
      // Every cushion plane lies on the table outline and every jaw, return
      // and facing behind it, so a centre more than R inside the outline
      // touches nothing.  This is the common case by far.
      const clearance = R + 1e-4;
      if (Math.abs(ball.pos.x) < this.table.width / 2 - clearance && Math.abs(ball.pos.z) < this.table.height / 2 - clearance) return NO_CONTACTS;
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
        if (jaw.mouthDirection) {
          const along = dx * jaw.mouthDirection.x + dz * jaw.mouthDirection.z;
          const front = dx * jaw.normal.x + dz * jaw.normal.z;
          if (along < -1e-6 || front * Math.sin(jaw.sweep) - along * Math.cos(jaw.sweep) < -1e-6) continue;
          if (jaw.radiusAlong !== jaw.radius) {
            const a = jaw.radiusAlong, b = jaw.radius;
            if (along > a + R || front > b + R) continue;
            // Closest point on the exposed ellipse, not radial distance to
            // its centre. The ball offset is along the ellipse's normal.
            let angle = Math.atan2(along * b, front * a);
            for (let i = 0; i < 8; i += 1) {
              const s = Math.sin(angle), c = Math.cos(angle);
              const ex = a * s - along, ey = b * c - front;
              const first = ex * a * c - ey * b * s;
              const second = a * a * c * c + b * b * s * s - ex * a * s - ey * b * c;
              if (Math.abs(second) < 1e-12) break;
              const next = clamp(angle - clamp(first / second, -0.25, 0.25), 0, jaw.sweep);
              if (Math.abs(next - angle) < 1e-12) { angle = next; break; }
              angle = next;
            }
            const s = Math.sin(angle), c = Math.cos(angle), length = Math.hypot(b * s, a * c);
            const na = b * s / length, nf = a * c / length;
            const distance = (along - a * s) * na + (front - b * c) * nf;
            if (distance < R) contacts.push({ nx: jaw.mouthDirection.x * na + jaw.normal.x * nf, nz: jaw.mouthDirection.z * na + jaw.normal.z * nf, depth: R - distance, id: jaw.id });
            continue;
          }
        }
        const distanceSq = dx * dx + dz * dz;
        const contactRadius = R + (jaw.radius || 0);
        if (distanceSq >= contactRadius * contactRadius || distanceSq < 1e-12) continue;
        const distance = Math.sqrt(distanceSq);
        contacts.push({ nx: dx / distance, nz: dz / distance, depth: contactRadius - distance, id: jaw.id || 'jaw' });
      }
      for (const wall of this.table.jawReturns || []) {
        const dx = wall.p1.x - wall.p0.x, dz = wall.p1.z - wall.p0.z;
        const length = Math.hypot(dx, dz);
        const bx = ball.pos.x - wall.p0.x, bz = ball.pos.z - wall.p0.z;
        const along = (bx * dx + bz * dz) / length;
        if (along < -1e-6 || along > length + 1e-6) continue;
        const distance = bx * wall.normal.x + bz * wall.normal.z;
        if (distance > -R && distance < R) contacts.push({ nx: wall.normal.x, nz: wall.normal.z, depth: R - distance, id: wall.id });
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

    // The rail is not a rigid wall: the rubber nose compresses one to a few
    // millimetres over roughly a millisecond and returns most of the stored
    // energy.  A contact lives as an episode on the ball (ball.railContact):
    // each fixed step contributes exactly its own dt of Hunt-Crossley
    // integration on a sub-grid of min(CUSHION_SUBSTEP, dt), so slow-motion
    // steps refine the contact resolution and the compression visibly evolves
    // across frames instead of resolving atomically inside one step.  The
    // spring-damper produces speed-dependent restitution by itself, Coulomb
    // friction at the raised nose follows the slip found at first touch (see
    // integrateRailContact), and the closing report carries the physical
    // compression depth and contact time.  The nose sits above the centre, so part of the
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
        // Unlike followRatio (a nose-height term), 1 means natural roll.
        spinRatio: approach > 0.02 ? R * (ball.omega.z * primary.nx - ball.omega.x * primary.nz) / approach : 0,
        sideSurfaceSpeed: ball.omega.y * reach,
        linearTangentSpeed: -ball.vel.x * primary.nz + ball.vel.z * primary.nx,
        // Spin acts through the two friction contacts, not a second empirical
        // spin-dependent multiplier on the rubber's material damping.
        chi: this.params.cushionHysteresis,
        viscosity: this.params.cushionViscosity,
        // Per-collider friction state, fixed at that collider's first touch.
        grip: {},
        entryEnergy: 0.5 * ball.mass * (ball.vel.x ** 2 + ball.velY ** 2 + ball.vel.z ** 2)
          + 0.5 * ball.inertia * (ball.omega.x ** 2 + ball.omega.y ** 2 + ball.omega.z ** 2),
        maxDepth: 0, contactTime: 0, downImpulse: 0,
        startY: ball.posY,
        stepStamp: -1,
      };
    }

    integrateRailContact(ball, budget, dt) {
      const contact = ball.railContact;
      const { noseHeight, reach, horizontal, vertical, chi, viscosity } = contact;
      const mu = this.params.frictionCushion;
      // The rubber is compressed along the tilted contact normal.  A ball in
      // flight moves vertically during the contact: rising along an upward-
      // tilted normal eases the compression and sinking deepens it, so the
      // force stays conservative.  Measuring only the horizontal depth let the
      // vertical component push a rising ball for free — balls launched off
      // the nose to a metre or more, with energy rising by half.  On the slate
      // posY never changes in an episode and this is the plain depth.
      const tilt = vertical / horizontal;
      const lift = ball.posY - contact.startY;
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
          const depth = c.depth - tilt * lift;
          if (!(depth > 0)) continue;
          const rate = -(ball.vel.x * c.nx + ball.vel.z * c.nz) - tilt * ball.velY;
          const fn = CUSHION_STIFFNESS * depth * Math.sqrt(depth) * (1 + chi * rate) + viscosity * rate;
          if (!(fn > 0)) continue;
          // The contact normal points from the nose through the ball centre:
          // mostly horizontal push-back plus a slate-ward vertical component.
          fx += fn * c.nx * horizontal;
          fz += fn * c.nz * horizontal;
          fy += fn * vertical;
          const armX = -c.nx * reach, armY = noseHeight, armZ = -c.nz * reach;
          const surfX = ball.vel.x + ball.omega.y * armZ - ball.omega.z * armY;
          const surfY = ball.velY + ball.omega.z * armX - ball.omega.x * armZ;
          const surfZ = ball.vel.z + ball.omega.x * armY - ball.omega.y * armX;
          const tX = -c.nz, tZ = c.nx;
          const frame = cushionFrame(c.nx, c.nz, vertical);
          const slipT = surfX * tX + surfZ * tZ;
          const slipY = surfX * frame.up.x + surfY * frame.up.y + surfZ * frame.up.z;
          // Friction direction and budget come from the slip at this
          // collider's first touch (Han 2005, as used by pooltool): Coulomb
          // sliding along that direction until the impulse that would have
          // stopped the initial slip is spent.  The contact does not stick
          // and reverse as the tilted normal load lifts the ball's surface
          // past the nose, so the incoming top/back spin leaves its mark —
          // roll in comes out near stun, stun in with some roll (Dr Dave
          // HSV B.15) — and a rolling ball keeps most of its along-rail speed
          // (measured rebound angles, TP B.11).  A sticking re-grip made
          // every straight-in impact leave with the same slight draw.
          let grip = contact.grip[c.id];
          if (!grip) {
            const slipMag = Math.hypot(slipT, slipY);
            grip = contact.grip[c.id] = { dirT: 0, dirY: 0, budget: 0, spent: 0, mobility: 1 };
            if (slipMag >= 1e-6) {
              grip.dirT = slipT / slipMag; grip.dirY = slipY / slipMag;
              const sX = grip.dirT * tX + grip.dirY * frame.up.x, sY = grip.dirY * frame.up.y, sZ = grip.dirT * tZ + grip.dirY * frame.up.z;
              const crossX = armY * sZ - armZ * sY, crossY = armZ * sX - armX * sZ, crossZ = armX * sY - armY * sX;
              // Effective mobility along the slip direction: the slate carries the
              // vertical linear reaction, so only the in-plane share moves mass.
              const onSlate = !ball.pocketFall && ball.posY <= 1e-9 && ball.velY <= 1e-6;
              const mobility = (sX * sX + sZ * sZ + (onSlate ? 0 : sY * sY)) / ball.mass
                + (crossX * crossX + crossY * crossY + crossZ * crossZ) / ball.inertia;
              grip.mobility = Math.max(mobility, 1e-9);
              grip.budget = slipMag / grip.mobility;
            }
          }
          // Only while the contact still slides that way: friction never
          // pushes along the slip, so it cannot feed energy into the ball,
          // and within a sub-step it stops where that slip would reach zero.
          const along = grip.dirT * slipT + grip.dirY * slipY;
          if (grip.spent >= grip.budget || along <= 0) continue;
          const sX = grip.dirT * tX + grip.dirY * frame.up.x, sY = grip.dirY * frame.up.y, sZ = grip.dirT * tZ + grip.dirY * frame.up.z;
          const friction = Math.min(mu * fn, (grip.budget - grip.spent) / h, along / (h * grip.mobility));
          grip.spent += friction * h;
          const ffX = -friction * sX;
          const ffY = -friction * sY;
          const ffZ = -friction * sZ;
          fx += ffX;
          fy += ffY;
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
        if (!ball.pocketFall && ball.posY <= 1e-9 && ball.velY <= 1e-6) {
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
        if (fy < 0 && !ball.pocketFall && ball.posY <= 1e-9 && ball.velY <= 1e-6) contact.downImpulse -= fy * h;
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
      // Empirical compliance return, not a prediction of the rigid-slate
      // contact equations. Limit it to energy actually lost in the episode:
      // a visual hop must never create mechanical energy.
      if (contact.downImpulse > 0 && ball.posY <= 1e-9) {
        const remaining = 0.5 * ball.mass * (ball.vel.x ** 2 + ball.velY ** 2 + ball.vel.z ** 2)
          + 0.5 * ball.inertia * (ball.omega.x ** 2 + ball.omega.y ** 2 + ball.omega.z ** 2);
        const allowance = Math.sqrt(Math.max(0, 2 * (contact.entryEnergy - remaining) / ball.mass));
        const hop = Math.min(0.13 * contact.downImpulse / ball.mass, allowance);
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
      const previousTravel = ball.railTravel;
      const returned = Boolean(previousTravel && previousTravel.id === contact.id && previousTravel.spinRatio > 1.15
        && previousTravel.maxDistance > 0.005 && previousTravel.reversed);
      const event = {
        type: 'cushion', ballId: ball.id, cushionId: contact.id, speed: Math.abs(contact.approach),
        // Still pressed against a cushion it was frozen to at the stroke.
        frozen: Boolean(ball.frozenRails && ball.frozenRails.includes(contact.id)),
        impulse: ball.mass * (Math.max(0, contact.approach) + Math.max(0, reboundNormal)),
        position: { ...ball.pos }, normal: { x: contact.nx, z: contact.nz },
        english,
        // 'stick': the rail took out the whole first-touch slip (Han's
        // sticking case); 'slide': it was still slipping when the ball left.
        frictionMode: Object.values(contact.grip).some((grip) => grip.budget > 0 && grip.spent >= grip.budget * 0.999) ? 'stick' : 'slide',
        followRatio: contact.followRatio,
        spinRatio: contact.spinRatio,
        returned, returnDistance: returned ? previousTravel.maxDistance : 0,
        // Observed speed ratio, not the material restitution. Spin can return
        // rotational energy to translation, so do not hide a ratio above 1.
        restitution: contact.approach > 0.02 ? Math.max(0, reboundNormal / contact.approach) : 0,
        compression: contact.maxDepth, contactTime: contact.contactTime,
        incidentAngle, reboundAngle, angleChange: reboundAngle - incidentAngle,
        incoming: { x: contact.vinX, z: contact.vinZ },
        outgoing: { x: ball.vel.x, z: ball.vel.z },
      };
      this.lastCushionEvent = event;
      ball.railTravel = { id: contact.id, x: ball.pos.x, z: ball.pos.z, nx: contact.nx, nz: contact.nz,
        spinRatio: contact.spinRatio, maxDistance: 0, reversed: false };

      const key = `rail:${ball.id}:${contact.id}`;
      const previous = this.collisionCooldown.get(key) || -1;
      if (this.time - previous > 0.035) {
        this.collisionCooldown.set(key, this.time);
        this.emit(event);
      }
    }

    // Beyond a cushion line and away from every pocket mouth, a ball can only
    // have got there over the top of the cushion.  Once it has passed the
    // outer edge of the rail, or come down onto the rail cap, it has left the
    // table (CBSA §9.3, §21): out of play, never a pot in the nearest pocket.
    leftPlayingSurface(ball) {
      const t = this.table, R = ball.radius;
      const beyond = Math.max(Math.abs(ball.pos.x) - t.width / 2, Math.abs(ball.pos.z) - t.height / 2);
      if (beyond <= R) return false;
      const nearMouth = t.pockets.some((p) => Math.hypot(ball.pos.x - p.x, ball.pos.z - p.z)
        < Math.max(p.radiusAlong, p.radiusAcross) + 2 * R);
      if (nearMouth) return false;
      const railCap = (t.cushionTopHeight || 0.042) + 0.017;
      return beyond > t.railWidth || ball.posY < railCap;
    }

    removeOffTable(ball) {
      ball.pocketed = true;
      ball.offTable = true;
      ball.pocketId = 'off';
      ball.sinkTime = 1; ball.sinkDepth = 0.22; ball.sinkTarget = null;
      ball.pocketFall = null; ball.railContact = null; ball.railTravel = null;
      ball.vel = { x: 0, z: 0 }; ball.velY = 0; ball.omega = { x: 0, y: 0, z: 0 };
      ball.state = 'offTable';
      this.emit({ type: 'offTable', ballId: ball.id, position: { ...ball.pos } });
    }

    captureBall(ball, pocket) {
      ball.pocketed = true;
      ball.pocketId = pocket.id;
      ball.sinkTime = 0;
      ball.sinkDepth = Math.max(0, -ball.posY);
      ball.pocketFall = null;
      ball.railContact = null; ball.railTravel = null; // a mid-compression rattle can drop straight in
      ball.sinkTarget = { x: pocket.x, z: pocket.z };
      ball.state = 'pocketed';
      this.emit({ type: 'pocket', ballId: ball.id, pocketId: pocket.id, speed: ball.lastSpeed, position: { x: pocket.x, z: pocket.z } });
    }

    checkPocket(ball) {
      if (ball.pocketed) return;
      for (const pocket of this.table.pockets) {
        if (Math.abs(ball.pos.x - pocket.x) > 0.15 || Math.abs(ball.pos.z - pocket.z) > 0.15) continue;
        const sample = pocketCoordinates(pocket, ball.pos);
        if (sample.norm < 1) {
          ball.pocketFall = pocket.id;
          if (ball.posY <= -ball.radius) {
            this.captureBall(ball, pocket);
            return;
          }
          // The ball can still contact the slate lip or a jaw while its
          // centre is above the slate. Gravity, rather than proximity to a
          // target point, determines when it is irreversibly pocketed.
          this.resolvePocketLip(ball, pocket);
          this.resolvePocketLiner(ball, pocket);
          ball.state = ball.posY > 0.001 ? 'airborne' : 'falling';
          ball.lastSpeed = Math.hypot(ball.vel.x, ball.vel.z);
          return;
        }
      }

      if (ball.pocketFall) {
        if (ball.posY <= -ball.radius) {
          this.captureBall(ball, this.table.pockets.find((p) => p.id === ball.pocketFall));
          return;
        }
        // A shallow skim can return to the shelf before the centre drops
        // below it. Treat that as a normal cloth landing, not an awarded pot.
        if (ball.posY < 0 && ball.posY > -ball.radius) {
          this.landBall(ball);
          ball.posY = 0;
          ball.velY = Math.max(0, -ball.velY * 0.15);
          if (ball.velY < 0.05) ball.velY = 0;
        }
        ball.pocketFall = null;
      }

      if (this.leftPlayingSurface(ball)) {
        this.removeOffTable(ball);
        return;
      }
      if (ball.posY > 0.05) return;
      // Safety capture below the outer rail near a mouth; physically this
      // region is the pocket liner.
      const hx = this.table.width / 2 + this.table.railWidth * 0.7;
      const hz = this.table.height / 2 + this.table.railWidth * 0.7;
      if (Math.abs(ball.pos.x) > hx || Math.abs(ball.pos.z) > hz) {
        const pocket = this.table.pockets.reduce((best, p) => V2.distance(ball.pos, p) < V2.distance(ball.pos, best) ? p : best, this.table.pockets[0]);
        this.captureBall(ball, pocket);
      }
    }

    resolvePocketLip(ball, pocket) {
      if (ball.posY >= 0 || ball.posY <= -ball.radius) return;
      const { edge } = pocketCoordinates(pocket, ball.pos, true);
      const dx = ball.pos.x - edge.x, dz = ball.pos.z - edge.z;
      const cy = ball.radius + ball.posY;
      const distance = Math.hypot(dx, cy, dz);
      if (distance >= ball.radius || distance < 1e-8) return;
      const nx = dx / distance, ny = cy / distance, nz = dz / distance;
      const correction = ball.radius - distance;
      ball.pos.x += nx * correction; ball.pos.z += nz * correction;
      ball.posY += ny * correction;
      const vn = ball.vel.x * nx + ball.velY * ny + ball.vel.z * nz;
      if (vn < 0) {
        // Inelastic support impulse. At the rounded slate edge its tilted
        // normal lets gravity tip a slow hanger into the opening.
        ball.vel.x -= vn * nx; ball.velY -= vn * ny; ball.vel.z -= vn * nz;
      }
    }

    resolvePocketLiner(ball, pocket) {
      if (ball.posY > (this.table.cushionTopHeight || 0.042)) return;
      const sample = pocketCoordinates(pocket, ball.pos);
      // The upper liner is open toward the playing surface. Below the slate
      // it becomes a complete boot, which confines a falling ball naturally.
      if (!ball.pocketed && sample.along < 0) return;
      const { edge } = pocketCoordinates(pocket, ball.pos, true);
      const ex = edge.x - pocket.x, ez = edge.z - pocket.z;
      const n = pocket.outward;
      const u = (ex * n.x + ez * n.z) / (pocket.radiusAlong ** 2);
      const v = (-ex * n.z + ez * n.x) / (pocket.radiusAcross ** 2);
      const gx = n.x * u - n.z * v, gz = n.z * u + n.x * v;
      const length = Math.hypot(gx, gz);
      const nx = -gx / length, nz = -gz / length;
      const separation = (ball.pos.x - edge.x) * nx + (ball.pos.z - edge.z) * nz;
      if (separation >= ball.radius) return;
      const penetration = ball.radius - separation;
      ball.pos.x += nx * penetration; ball.pos.z += nz * penetration;
      // A modest back draft directs a firm entry down the leather/rubber
      // boot. This passive impulse removes energy and never attracts a ball.
      const slope = 12 * Math.PI / 180;
      const cx = nx * Math.cos(slope), cy = -Math.sin(slope), cz = nz * Math.cos(slope);
      const vn = ball.vel.x * cx + ball.velY * cy + ball.vel.z * cz;
      if (vn < 0) {
        const impulse = -(1 + 0.22) * vn;
        ball.vel.x += impulse * cx; ball.velY += impulse * cy; ball.vel.z += impulse * cz;
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

    // A preview is a resumable run on a clone: begin it, advance it in
    // wall-clock slices, read a result at any point.  The UI spreads a long
    // shot over several frames this way instead of stalling one of them.
    beginPrediction(options, maxTime = 12) {
      const clone = this.clone(true);
      const events = [];
      clone.onEvent((event) => events.push(event));
      if (!clone.strike(options)) return null;
      return {
        clone, events, maxTime, step: 0, stillFrames: 0, done: false,
        initial: new Map(clone.balls.map((b) => [b.id, { ...b.pos }])),
        paths: new Map(clone.balls.map((b) => [b.id, [{ ...b.pos, y: b.posY, t: 0 }]])),
      };
    }

    // Returns true once the balls have stopped or maxTime is covered.  The
    // deadline is only checked between whole steps, so a run split into any
    // number of slices samples exactly the same path as one uninterrupted run.
    advancePrediction(job, budgetMs = 40) {
      const dt = 1 / 1000;
      const sampleEvery = 16;
      const clock = typeof performance !== 'undefined' ? performance : Date;
      const deadline = clock.now() + budgetMs;
      const { clone, paths, initial } = job;
      while (!job.done) {
        if (!(clone.shotTime < job.maxTime && job.step < job.maxTime / dt)) { job.done = true; break; }
        clone.step(dt);
        if (job.step % sampleEvery === 0) {
          clone.balls.forEach((ball) => {
            const path = paths.get(ball.id);
            const start = initial.get(ball.id);
            const moved = Math.hypot(ball.pos.x - start.x, ball.pos.z - start.z) > 0.0015;
            if ((moved || path.length > 1 || ball.id === 'cue') && path.length < 780) {
              path.push({ x: ball.pos.x, y: ball.posY, z: ball.pos.z, t: clone.shotTime, pocketed: ball.pocketed, sink: ball.sinkDepth });
            }
          });
        }
        if (!clone.isMoving()) job.stillFrames += 1; else job.stillFrames = 0;
        if (job.stillFrames > 10) { job.done = true; break; }
        job.step += 1;
        if ((job.step & 63) === 0 && clock.now() > deadline) break;
      }
      return job.done;
    }

    // A run cut off while balls still move reports truncated:true so the UI
    // can say "≥" instead of passing the cut-off off as the rest position (a
    // 6 s scratch must not read as a safe stop).
    predictionResult(job) {
      const paths = new Map([...job.paths].filter(([id, path]) => path.length > 1 || id === 'cue'));
      const events = job.events.slice();
      const firstHit = events.find((e) => e.type === 'ball-ball' && (e.aId === 'cue' || e.bId === 'cue')) || null;
      const cuePath = paths.get('cue') || [];
      let cueDistance = 0;
      for (let i = 1; i < cuePath.length; i += 1) cueDistance += Math.hypot(cuePath[i].x - cuePath[i - 1].x, cuePath[i].z - cuePath[i - 1].z);
      return { paths, events, firstHit, cueDistance, duration: job.clone.shotTime, truncated: job.clone.isMoving() };
    }

    // Aiming previews must never stall the pointer: cap the wall-clock cost.
    predictShot(options, maxTime = 12, budgetMs = 40) {
      const job = this.beginPrediction(options, maxTime);
      if (!job) return { paths: new Map(), events: [], firstHit: null, cueDistance: 0, duration: 0, truncated: false };
      this.advancePrediction(job, budgetMs);
      return this.predictionResult(job);
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
        mode: this.mode, rackSeed: this.rackSeed, params: { ...this.params }, clothPreset: this.clothPreset,
        cueType: this.cueType, tipType: this.tipType,
        balls: this.balls.map(cloneBall), time: this.time, shotTime: this.shotTime, inShot: this.inShot,
      };
    }

    restore(snapshot) {
      if (snapshot.mode !== this.mode) this.setMode(snapshot.mode, snapshot.rackSeed ?? this.rackSeed);
      if (Number.isFinite(snapshot.rackSeed)) this.rackSeed = snapshot.rackSeed;
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
      copy.rackSeed = this.rackSeed;
      copy.balls = this.balls.map(cloneBall);
      copy.collisionCooldown = new Map();
      copy.lastCueMetrics = this.lastCueMetrics ? { ...this.lastCueMetrics } : null;
      copy.lastCushionEvent = null;
      return copy;
    }

    respotCue() {
      const cue = this.getCueBall();
      if (!cue) return;
      const preferred = this.mode === 'snooker' ? snookerSpots(this.table).cue : { x: this.table.cueStart, z: 0 };
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
      ball.posY = 0; ball.velY = 0; ball.railContact = null; ball.railTravel = null; ball.pocketFall = null;
      ball.pocketed = false; ball.offTable = false; ball.pocketId = null; ball.sinkTime = 0; ball.sinkDepth = 0; ball.sinkTarget = null; ball.state = 'stationary';
      return true;
    }
  }

  global.BilliardsPhysics = {
    PhysicsWorld, POOL_PARAMS, CHINESE_PARAMS, SNOOKER_PARAMS, CUE_SPECS, TIP_PRESETS,
    TABLES, POOL_COLORS, PALLADIUM_COLORS, SNOOKER_COLORS, pocketCoordinates, roundedCushionContour, cushionEndExtension, cushionFrame, snookerSpots,
  };
})(window);
