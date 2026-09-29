(function (global) {
  'use strict';

  const { Mat4, clamp, hexToRgb } = global.BilliardsMath;

  const VERTEX_SHADER = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    in vec3 aNormal;
    in vec2 aUV;
    uniform mat4 uModel;
    uniform mat3 uNormalMatrix;
    uniform mat4 uViewProjection;
    out vec3 vWorldPosition;
    out vec3 vNormal;
    out vec2 vUV;
    void main() {
      vec4 world = uModel * vec4(aPosition, 1.0);
      vWorldPosition = world.xyz;
      vNormal = normalize(uNormalMatrix * aNormal);
      vUV = aUV;
      gl_Position = uViewProjection * world;
    }
  `;

  // Everything is lit by the one fixture a professional table has: a canopy
  // of diffuser panels hung about a metre above the bed.  Irradiance comes
  // from the canopy outline as an area light; balls and the cue shadow it
  // with soft umbrae; glossy resin, lacquer and brass mirror the panels,
  // the cloth and the neighbouring balls.  Shading happens in linear light
  // and is tone mapped once at the end.  The source is compiled once per
  // material (MATERIAL is defined by the renderer), so each surface pays
  // only for its own lighting instead of every branch.
  const FRAGMENT_SHADER = `#version 300 es
    precision highp float;
    precision highp int;
    in vec3 vWorldPosition;
    in vec3 vNormal;
    in vec2 vUV;
    uniform vec3 uColor;
    uniform vec3 uCameraPosition;
    uniform sampler2D uTexture;
    uniform int uTextureMode;
    uniform vec2 uTextureScale;
    uniform vec2 uTableHalfSize;
    uniform float uRailWidth;
    uniform float uOpacity;
    uniform bool uCutPockets;
    uniform vec4 uPockets[6];
    uniform vec2 uPocketAxes[6];
    // Canopy: panels on the plane y = uLampHeight, emitting downward.
    uniform float uLampHeight;
    uniform vec4 uLampOutline;
    uniform vec4 uLampCells[12];
    uniform int uLampCellCount;
    uniform vec3 uLampColumns[6];
    uniform int uLampColumnCount;
    uniform float uLampNorm;
    uniform vec2 uLampSpread;
    uniform float uLampLuminance;
    // Occluders and mirror targets: the balls in play and, when aiming, the cue.
    uniform vec4 uBalls[24];
    uniform vec3 uBallTints[24];
    uniform int uBallCount;
    uniform int uSelfBall;
    uniform vec4 uCueTip;
    uniform vec4 uCueButt;
    uniform vec3 uClothAlbedo;
    uniform float uExposure;
    // Per-frame occluder grid over the table: bit i of a cell is set when
    // uBalls[i] (bit 31: the cue) can shade some point in that cell.
    uniform highp usampler2D uOccluderGrid;
    uniform vec4 uGridRect;
    // The neighbouring tables' canopies, seen only in the balls' mirrors.
    uniform vec4 uHallLamps[4];
    uniform vec3 uHallColor;
    out vec4 outColor;

    const uint CUE_BIT = 0x80000000u;

    // Each material compiles only the helpers it calls: flat markings none,
    // the floor and nets just the canopy irradiance, glossy finishes the
    // mirror, and only balls the ball-to-ball mirror and occlusion.
#if MATERIAL != 3 && MATERIAL != 8
#define USE_LIGHT 1
#endif
#if MATERIAL == 0 || MATERIAL == 1 || MATERIAL == 2 || MATERIAL == 4
#define USE_SHADOWS 1
#endif
#if MATERIAL == 0 || MATERIAL == 2 || MATERIAL == 4 || MATERIAL == 5 || MATERIAL == 6
#define USE_REFLECTIONS 1
#endif
#if MATERIAL == 2 || MATERIAL == 4 || MATERIAL == 5
#define USE_UNDER_TABLE 1
#endif

    const float PI = 3.14159265;

#ifdef USE_LIGHT
    vec3 toLinear(vec3 c) { return pow(max(c, vec3(0.0)), vec3(2.2)); }

    // The shoulder of Khronos PBR Neutral (without its toe, which would
    // crush the cloth's dark red channel): colours below 0.8 pass through
    // unchanged, panel reflections roll off to white instead of clipping.
    vec3 toneMap(vec3 color) {
      float peak = max(color.r, max(color.g, color.b));
      const float start = 0.8;
      if (peak < start) return color;
      const float d = 1.0 - start;
      float newPeak = 1.0 - d * d / (peak + d - start);
      color *= newPeak / peak;
      float g = 1.0 - 1.0 / (0.15 * (peak - newPeak) + 1.0);
      return mix(color, vec3(newPeak), g);
    }

    // theta * normalize(cross(a, b)) / 2pi for the arc between unit vectors
    // a, b (the fitted form of Heitz et al. 2016, stable near 0 and pi).
    vec3 edgeIntegral(vec3 a, vec3 b) {
      float x = dot(a, b), y = abs(x);
      float v = (0.8543985 + (0.4965155 + 0.0145206 * y) * y) / (3.4175940 + (4.1616724 + y) * y);
      float thetaOverSin = x > 0.0 ? v : 0.5 * inversesqrt(max(1.0 - x * x, 1e-7)) - v;
      return cross(a, b) * thetaOverSin;
    }

    // Irradiance from the canopy, 1.0 at the bed centre.  Lambert's polygon
    // formula gives the vector form factor of the outline; the horizon clip
    // is the sphere fit of Hill and Heitz (2016).  uLampSpread stands in for
    // the fixture optics that throw extra light out to the rails and corners.
    float lampIrradiance(vec3 p, vec3 n) {
      float h = uLampHeight - p.y;
      if (h <= 0.001) return 0.0;
      vec4 r = uLampOutline;
      vec3 a = normalize(vec3(r.x - p.x, h, r.y - p.z));
      vec3 b = normalize(vec3(r.z - p.x, h, r.y - p.z));
      vec3 c = normalize(vec3(r.z - p.x, h, r.w - p.z));
      vec3 d = normalize(vec3(r.x - p.x, h, r.w - p.z));
      vec3 f = -(edgeIntegral(a, b) + edgeIntegral(b, c) + edgeIntegral(c, d) + edgeIntegral(d, a));
      float len = length(f);
      float formFactor = max((len * len + dot(f, n)) / (len + 1.0), 0.0);
      vec2 q = clamp(p.xz / uTableHalfSize, -1.2, 1.2);
      float optics = (1.0 + uLampSpread.x * q.x * q.x) * (1.0 + uLampSpread.y * q.y * q.y);
      return formFactor * uLampNorm * optics;
    }
#endif

#ifdef USE_SHADOWS
    // Solid angle shared by two spherical caps with angular radii r1, r2 and
    // centre separation d: exact when one holds the other, a smoothstep
    // between (Oat and Sander 2007).
    float capOverlap(float r1, float r2, float d) {
      float lo = min(r1, r2), hi = max(r1, r2);
      if (d >= r1 + r2) return 0.0;
      float full = 2.0 * PI * (1.0 - cos(lo));
      if (d <= hi - lo) return full;
      return full * smoothstep(0.0, 1.0, 1.0 - (d - hi + lo) / (2.0 * lo));
    }

    // Area of a cap (angular radius beta, flattened to a disc) covered by a
    // band of half-width w whose centre line passes at distance s: the stick
    // is long enough to cross a whole panel, so it hides a strip, not a disc.
    float capStripOverlap(float beta, float s, float w) {
      float a = max(-beta, s - w), b = min(beta, s + w);
      if (a >= b) return 0.0;
      float b2 = beta * beta;
      float fa = a * sqrt(max(b2 - a * a, 0.0)) + b2 * asin(clamp(a / beta, -1.0, 1.0));
      float fb = b * sqrt(max(b2 - b * b, 0.0)) + b2 * asin(clamp(b / beta, -1.0, 1.0));
      return fb - fa;
    }
#endif

#ifdef USE_UNDER_TABLE
    // Beneath the playing surface the table itself hides the canopy; only
    // the pocket drops, which open onto it, still see the light.
    bool underTable(vec3 p) {
      // Up by the rails the table's shade ends at the rails' outer faces,
      // which themselves face the room; lower down the turned legs bulge a
      // little past that outline and still stand in its shade.
      vec2 outline = uTableHalfSize + vec2(p.y > -0.2 ? uRailWidth - 0.003 : 0.16);
      if (p.y > -0.02 || any(greaterThan(abs(p.xz), outline))) return false;
      // The pocket drops open onto the canopy: their boots stay lit, but not
      // the legs and posts that happen to stand beneath a side pocket.
      for (int i = 0; i < 6; i++) {
        vec2 delta = p.xz - uPockets[i].xy;
        vec2 axis = uPocketAxes[i];
        vec2 q = vec2(dot(delta, axis), dot(delta, vec2(-axis.y, axis.x))) / (uPockets[i].zw * 1.25);
        if (p.y > -0.24 && dot(q, q) < 1.0) return false;
      }
      return true;
    }
#endif

#ifdef USE_SHADOWS

    // Which occluders can shade p at all.  Most of the cloth has none, and a
    // single fetch then replaces every per-ball loop.
    uint occludersAt(vec3 p) {
      ivec2 size = textureSize(uOccluderGrid, 0);
      ivec2 cell = clamp(ivec2(floor((p.xz - uGridRect.xy) * uGridRect.z)), ivec2(0), size - 1);
      return texelFetch(uOccluderGrid, cell, 0).r;
    }

    bool hasBall(uint mask, int i) { return (mask & (1u << uint(i))) != 0u; }

    // A ball can only shade p if it sits within the canopy's lowest ray
    // slope (about 1 : 2.6) of p.
    bool ballShadesPoint(vec3 p, vec4 ball) {
      vec3 d = ball.xyz - p;
      float reach = (d.y + ball.w) * 2.6 + ball.w;
      return ball.w > 0.0 && d.y >= -ball.w && dot(d.xz, d.xz) <= reach * reach;
    }

    bool cueShadesPoint(vec3 p) {
      if (uCueButt.w <= 0.0) return false;
      vec2 a = uCueTip.xz - p.xz, ab = uCueButt.xz - uCueTip.xz;
      float t = clamp(-dot(a, ab) / max(dot(ab, ab), 1e-9), 0.0, 1.0);
      float top = max(uCueTip.y, uCueButt.y) - p.y + uCueButt.w;
      return top > 0.0 && length(a + ab * t) <= top * 2.6 + uCueButt.w;
    }

    // Share of the canopy's light that reaches p past the balls and the cue.
    // Each column of panels is one cap of sky; an occluder removes the part
    // of that cap its own silhouette covers, so a ball on the cloth gets a
    // true umbra at its contact point and a penumbra stretched along the
    // table, the way a long canopy draws it.
    float lampVisibilityOf(vec3 p, vec3 n, int skip, uint mask) {
      vec3 dirs[6];
      float radii[6], solids[6], weights[6], blocked[6];
      float total = 0.0;
      for (int g = 0; g < 6; g++) {
        dirs[g] = vec3(0.0, 1.0, 0.0); radii[g] = 0.0; solids[g] = 1.0; weights[g] = 0.0; blocked[g] = 0.0;
        if (g >= uLampColumnCount) continue;
        vec3 column = uLampColumns[g];
        vec3 toLamp = vec3(column.x - p.x, uLampHeight - p.y, column.y - p.z);
        float dist = length(toLamp);
        vec3 dir = toLamp / dist;
        float solid = clamp(column.z * dir.y / (dist * dist), 1e-6, 2.0 * PI);
        dirs[g] = dir;
        solids[g] = solid;
        radii[g] = acos(1.0 - solid / (2.0 * PI));
        weights[g] = solid * max(dot(n, dir), 0.0);
        total += weights[g];
      }
      if (total <= 0.0) return 1.0;
      for (int i = 0; i < 24; i++) {
        if (i >= uBallCount) break;
        vec4 ball = uBalls[i];
        if (i == skip || !hasBall(mask, i) || !ballShadesPoint(p, ball)) continue;
        vec3 d = ball.xyz - p;
        float dist = length(d);
        vec3 dir = d / dist;
        float radius = asin(min(ball.w / dist, 1.0));
        for (int g = 0; g < 6; g++) {
          if (g >= uLampColumnCount) break;
          blocked[g] += capOverlap(radius, radii[g], acos(clamp(dot(dir, dirs[g]), -1.0, 1.0)));
        }
      }
      if ((mask & CUE_BIT) != 0u && cueShadesPoint(p)) {
        // Where the stick crosses a column's ray it hides a band of that
        // column's cap; past its tip it tapers to the round end.
        vec3 ab = uCueButt.xyz - uCueTip.xyz;
        vec3 ao = uCueTip.xyz - p;
        for (int g = 0; g < 6; g++) {
          if (g >= uLampColumnCount) break;
          float abd = dot(ab, dirs[g]);
          float denom = dot(ab, ab) - abd * abd;
          float t = denom > 1e-9 ? (abd * dot(ao, dirs[g]) - dot(ao, ab)) / denom : 0.0;
          float s = clamp(t, 0.0, 1.0);
          vec3 d = ao + ab * s;
          float along = dot(d, dirs[g]);
          if (along <= 0.0) continue;
          float dist = length(d);
          float width = asin(min(mix(uCueTip.w, uCueButt.w, s) / dist, 1.0));
          float offset = acos(clamp(along / dist, -1.0, 1.0));
          blocked[g] += t > 0.0 && t < 1.0
            ? capStripOverlap(radii[g], offset, width)
            : capOverlap(width, radii[g], offset);
        }
      }
      float lit = 0.0;
      for (int g = 0; g < 6; g++) {
        if (g >= uLampColumnCount) break;
        lit += weights[g] * (1.0 - min(blocked[g] / solids[g], 1.0));
      }
      return lit / total;
    }

    float lampVisibility(vec3 p, vec3 n, int skip) {
      uint mask = occludersAt(p);
      if (skip >= 0) mask &= ~(1u << uint(skip));
      return mask == 0u ? 1.0 : lampVisibilityOf(p, n, skip, mask);
    }
#endif

#if MATERIAL == 0

    // The shadowed cloth as a ball's mirror sees it, with the canopy taken as
    // a single cap: in a reflection the column-by-column penumbra detail is
    // invisible, but the dark ground around a ball and its neighbours is not.
    float bedVisibility(vec3 q) {
      uint mask = occludersAt(q) & ~CUE_BIT;
      if (mask == 0u) return 1.0;
      vec4 r = uLampOutline;
      vec3 toLamp = vec3(0.5 * (r.x + r.z) - q.x, uLampHeight - q.y, 0.5 * (r.y + r.w) - q.z);
      float dist = length(toLamp);
      vec3 dir = toLamp / dist;
      float solid = clamp((r.z - r.x) * (r.w - r.y) * dir.y / (dist * dist), 1e-6, 2.0 * PI);
      float lampRadius = acos(1.0 - solid / (2.0 * PI));
      float blocked = 0.0;
      for (int i = 0; i < 24; i++) {
        if (i >= uBallCount) break;
        vec4 ball = uBalls[i];
        if (!hasBall(mask, i) || !ballShadesPoint(q, ball)) continue;
        vec3 d = ball.xyz - q;
        float reach = length(d);
        blocked += capOverlap(asin(min(ball.w / reach, 1.0)), lampRadius, acos(clamp(dot(d / reach, dir), -1.0, 1.0)));
      }
      return 1.0 - min(blocked / solid, 1.0);
    }

    // Cosine-weighted share of the surrounding hall each nearby ball hides
    // (analytic sphere occlusion): dark creases between touching balls.
    float ballOcclusion(vec3 p, vec3 n, int skip) {
      uint mask = occludersAt(p);
      float occlusion = 0.0;
      for (int i = 0; i < 24; i++) {
        if (mask == 0u || i >= uBallCount) break;
        vec4 ball = uBalls[i];
        if (i == skip || !hasBall(mask, i) || ball.w <= 0.0) continue;
        vec3 d = ball.xyz - p;
        float l2 = dot(d, d);
        if (l2 > 36.0 * ball.w * ball.w) continue;
        occlusion += max(dot(n, d), 0.0) * inversesqrt(l2) * ball.w * ball.w / l2;
      }
      return clamp(1.0 - occlusion, 0.0, 1.0);
    }
#endif

#ifdef USE_REFLECTIONS
    // What a mirror ray from p along r meets: another ball, the canopy
    // panels (box-filtered over footprint, the ray's half-width on the panel
    // plane), the lit cloth, or the dark hall.  self is the ball being shaded;
    // for any other surface (self < 0) neighbouring balls are too small in
    // its blurred reflection to be worth the ray tests.
    vec3 reflectedRadiance(vec3 p, vec3 r, vec2 footprint, float luminance, int self, bool below) {
#if MATERIAL == 0
      float nearest = 1e6;
      int hit = -1;
      for (int i = 0; i < 24; i++) {
        if (self < 0 || i >= uBallCount) break;
        vec4 ball = uBalls[i];
        if (i == self || ball.w <= 0.0) continue;
        vec3 oc = p - ball.xyz;
        float b = dot(oc, r);
        float h = b * b - dot(oc, oc) + ball.w * ball.w;
        if (h < 0.0) continue;
        float t = -b - sqrt(h);
        if (t > 0.0 && t < nearest) { nearest = t; hit = i; }
      }
      if (hit >= 0) {
        vec3 normal = normalize(p + r * nearest - uBalls[hit].xyz);
        return uBallTints[hit] * (0.06 + 0.94 * smoothstep(-0.25, 1.0, normal.y));
      }
#endif
      if (below) {
        // Under the table a satin finish sees only the dim hall all round.
        return vec3(0.03, 0.028, 0.026);
      }
      if (r.y > 0.0) {
        vec2 q = p.xz + r.xz * ((uLampHeight - p.y) / r.y);
        float panel = 0.0;
        for (int i = 0; i < 12; i++) {
          if (i >= uLampCellCount) break;
          vec4 cell = uLampCells[i];
          vec2 overlap = clamp((min(q + footprint, cell.zw) - max(q - footprint, cell.xy)) / (2.0 * footprint), 0.0, 1.0);
          panel += overlap.x * overlap.y;
        }
        vec3 hall = mix(vec3(0.030, 0.027, 0.024), vec3(0.008, 0.009, 0.010), clamp(r.y * 1.6, 0.0, 1.0));
#if MATERIAL == 0
        // Other tables' lamps down the hall: small, dimmer windows near a
        // ball's rim, the way a club's ceiling sparkles in real balls.
        float far = 0.0;
        for (int i = 0; i < 4; i++) {
          vec4 lamp = uHallLamps[i];
          vec2 overlap = clamp((min(q + footprint, lamp.zw) - max(q - footprint, lamp.xy)) / (2.0 * footprint), 0.0, 1.0);
          far += overlap.x * overlap.y;
        }
        hall = mix(hall, vec3(luminance * 0.35), clamp(far, 0.0, 1.0));
#endif
        return mix(hall, vec3(luminance), clamp(panel, 0.0, 1.0));
      }
      if (p.y > 0.0) {
        vec2 q = p.xz - r.xz * (p.y / r.y);
        if (all(lessThan(abs(q), uTableHalfSize))) {
          // Only a ball's sharp mirror resolves the lit cloth and its own
          // shadow on it; blurred finishes just take the cloth's colour.
#if MATERIAL == 0
          vec3 bed = vec3(q.x, 0.0, q.y), up = vec3(0.0, 1.0, 0.0);
          return uClothAlbedo * (lampIrradiance(bed, up) * bedVisibility(bed) + 0.03);
#else
          return uClothAlbedo * 0.9;
#endif
        }
      }
      return vec3(0.016, 0.012, 0.010);
    }
#endif

    void main() {
      // Only upward faces (bed, slate, rail caps) open over a pocket; the
      // apron, posts and trims beneath a side pocket keep their sides.
      if (uCutPockets && vWorldPosition.y > -0.225 && normalize(vNormal).y > 0.35
          && (abs(vWorldPosition.x) > uTableHalfSize.x - 0.15 || abs(vWorldPosition.z) > uTableHalfSize.y - 0.15)) {
        for (int i = 0; i < 6; i++) {
          vec2 delta = vWorldPosition.xz - uPockets[i].xy;
          vec2 axis = uPocketAxes[i];
          vec2 q = vec2(dot(delta, axis), dot(delta, vec2(-axis.y, axis.x))) / uPockets[i].zw;
          if (dot(q, q) < 1.0) discard;
        }
      }
      vec3 texel = uTextureMode > 0 ? texture(uTexture, vUV * uTextureScale).rgb : vec3(1.0);
      vec3 base = uTextureMode == 1 ? texel : uColor;
      if (uTextureMode == 2) {
        // Material maps are neutral albedo modulation maps. Keeping the table
        // tint in uColor makes the same offline texture useful across modes.
        base *= mix(vec3(1.0), texel * 1.34, 0.58);
      }
#if MATERIAL == 3
      outColor = vec4(base, uOpacity);
#elif MATERIAL == 8
      vec2 q = (vUV - 0.5) * 2.0;
      float softness = pow(max(0.0, 1.0 - dot(q, q)), 1.6);
      outColor = vec4(base, uOpacity * softness);
#else
      vec3 p = vWorldPosition;
      vec3 n = normalize(vNormal);
      vec3 v = normalize(uCameraPosition - p);
      vec3 albedo = toLinear(base);
      float cosV = clamp(dot(n, v), 0.0, 1.0);
      float grazing = pow(1.0 - cosV, 5.0);
      vec3 r = reflect(-v, n);
      // Pixel footprint of the mirror ray on the panel plane.  Taken here,
      // in uniform control flow, for every glossy material below.
      vec2 panelHit = p.xz + r.xz * ((uLampHeight - p.y) / max(r.y, 0.04));
      vec2 pixel = 0.5 * fwidth(panelHit);
      // Light the cloth throws back up onto whatever faces it.
      float facingBed = clamp(0.5 - 0.5 * n.y, 0.0, 1.0);
      vec3 color;
#if MATERIAL == 2 || MATERIAL == 4 || MATERIAL == 5
      // Under the table: no canopy, only the hall's own lights, which come in
      // low from the room and pick out a turned leg's facets.
      float canopy = underTable(p) ? 0.0 : 1.0;
      float shadowAmbient = (0.035 + 0.05 * (0.5 + 0.5 * dot(n, normalize(vec3(0.35, 0.3, 0.88)))) + 0.025 * facingBed) * (1.0 - canopy);
#endif
#if MATERIAL == 0
      // Phenolic resin under a clear polish: coloured diffuse, a mirror
      // coat with F0 = 0.05 on top.
      int self = uSelfBall;
      float radius = self >= 0 ? uBalls[self].w : 0.0286;
      float lamp = lampIrradiance(p, n) * lampVisibility(p, n, self);
      float ao = ballOcclusion(p, n, self);
      // The lowest band looks into its own umbra; the flanks see lit cloth.
      float bounce = facingBed * mix(0.22, 1.0, smoothstep(0.0, 1.7 * radius, p.y));
      vec3 hall = vec3(0.045) * clamp(0.5 + 0.5 * n.y, 0.0, 1.0);
      vec3 diffuse = albedo * (lamp + (uClothAlbedo * bounce + hall) * ao);
      float fresnel = 0.05 + 0.95 * grazing;
      vec3 mirror = reflectedRadiance(p, r, pixel + vec2(0.010), uLampLuminance, self, false);
      color = mix(diffuse, mirror, fresnel);
      // A falling ball loses the canopy as the pocket boot closes over it.
      color *= exp(min(p.y, 0.0) * 22.0);
#elif MATERIAL == 1
      albedo *= 1.0 + sin(p.x * 145.0 + p.z * 13.0) * 0.0045;
      // The cloth is most of the frame: one pass over the balls marked in
      // this cell gathers the hall light each hides and whether any can shade
      // p at all; the cap test against the canopy then runs only where one can.
      uint mask = occludersAt(p);
      bool shaded = (mask & CUE_BIT) != 0u && cueShadesPoint(p);
      float occlusion = 0.0;
      for (int i = 0; i < 24; i++) {
        if (mask == 0u || i >= uBallCount) break;
        vec4 ball = uBalls[i];
        if (!hasBall(mask, i) || !ballShadesPoint(p, ball)) continue;
        shaded = true;
        vec3 d = ball.xyz - p;
        float l2 = dot(d, d);
        if (l2 < 36.0 * ball.w * ball.w) occlusion += max(dot(n, d), 0.0) * inversesqrt(l2) * ball.w * ball.w / l2;
      }
      float lamp = lampIrradiance(p, n) * (shaded ? lampVisibilityOf(p, n, -1, mask) : 1.0);
      float ao = clamp(1.0 - occlusion, 0.0, 1.0);
      // A narrow crease where the bed runs in under the cushion nose; the
      // canopy itself hangs over the bed, so the rails shade nothing else.
      float edgeDistance = min(uTableHalfSize.x - abs(p.x), uTableHalfSize.y - abs(p.z));
      float bed = 1.0 - smoothstep(0.002, 0.016, p.y);
      float crease = mix(1.0, mix(0.45, 1.0, smoothstep(-0.006, 0.012, edgeDistance)), bed);
      vec3 ambient = (vec3(0.035) + uClothAlbedo * facingBed * 0.8) * ao;
      color = albedo * (lamp + ambient) * crease;
#elif MATERIAL == 2
      // Satin-varnished wood: a broad, soft sheen of the panels.
      albedo *= 1.0 + sin(p.x * 69.0 + sin(p.z * 37.0) * 1.7) * 0.018;
      float lamp = canopy > 0.0 ? lampIrradiance(p, n) * lampVisibility(p, n, -1) : 0.0;
      vec3 sheen = reflectedRadiance(p, r, pixel + vec2(0.16), uLampLuminance * 0.10, -1, canopy == 0.0);
      color = mix(albedo * (lamp + 0.035 + shadowAmbient), sheen, 0.035 + 0.965 * grazing);
#elif MATERIAL == 4
      // Leather, rubber and pocket boots: matte, darkening into the pocket.
      float lamp = canopy > 0.0 ? lampIrradiance(p, n) * lampVisibility(p, n, -1) : 0.0;
      vec3 sheen = reflectedRadiance(p, r, pixel + vec2(0.30), uLampLuminance * 0.06, -1, canopy == 0.0);
      color = mix(albedo * (lamp + 0.03 + shadowAmbient), sheen, 0.03 + 0.5 * grazing);
      if (p.y > -0.25) color *= exp(min(p.y, 0.0) * 16.0);
#elif MATERIAL == 5
      // Brushed brass: coloured Fresnel, most of the look is reflection.
      float lamp = canopy > 0.0 ? lampIrradiance(p, n) : 0.0;
      vec3 fresnel = albedo + (1.0 - albedo) * grazing;
      vec3 mirror = reflectedRadiance(p, r, pixel + vec2(0.07), uLampLuminance * 0.35, -1, canopy == 0.0);
      color = albedo * (lamp * 0.16 + 0.02 + shadowAmbient * 1.6) + fresnel * mirror;
#elif MATERIAL == 6
      // Cue lacquer.
      albedo *= 1.0 + sin(p.x * 210.0 + p.z * 170.0) * 0.012;
      float lamp = lampIrradiance(p, n);
      vec3 ambient = vec3(0.05) + uClothAlbedo * facingBed * 0.7;
      vec3 mirror = reflectedRadiance(p, r, pixel + vec2(0.05), uLampLuminance * 0.45, -1, false);
      color = mix(albedo * (lamp + ambient), mirror, 0.04 + 0.96 * grazing);
#elif MATERIAL == 9
      // Open net bag: light falls through the mesh, so the cord stays pale
      // well down the drop while the holes show the dark below.
      float lamp = lampIrradiance(vec3(p.x, 0.0, p.z), vec3(0.0, 1.0, 0.0));
      color = albedo * (lamp * 0.6 + 0.04) * exp(min(p.y, 0.0) * 7.0);
#else
      // Hall floor: canopy spill around the table, the table's own
      // shadow beneath it.
      vec2 outside = max(abs(p.xz) - uTableHalfSize - vec2(0.12), vec2(0.0));
      float open = smoothstep(0.0, 0.7, length(outside));
      float lamp = lampIrradiance(p, vec3(0.0, 1.0, 0.0)) * mix(0.05, 1.0, open);
      color = albedo * (lamp + 0.25);
      // The hall recedes into darkness rather than ending at a floor edge.
      color = mix(color, uHallColor, smoothstep(2.5, 8.0, length(p.xz)));
#endif
      outColor = vec4(pow(toneMap(color * uExposure), vec3(1.0 / 2.2)), uOpacity);
#endif
    }
  `;

  function compileShader(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const message = gl.getShaderInfoLog(shader);
      gl.deleteShader(shader);
      throw new Error(`WebGL shader error: ${message}`);
    }
    return shader;
  }

  function createProgram(gl, vertexSource, fragmentSource) {
    const program = gl.createProgram();
    gl.attachShader(program, compileShader(gl, gl.VERTEX_SHADER, vertexSource));
    gl.attachShader(program, compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource));
    // Attribute slots must be pinned before the (single) link to take effect.
    gl.bindAttribLocation(program, 0, 'aPosition');
    gl.bindAttribLocation(program, 1, 'aNormal');
    gl.bindAttribLocation(program, 2, 'aUV');
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL link error: ${gl.getProgramInfoLog(program)}`);
    return program;
  }

  // Inverse-transpose of the model matrix's 3x3, via the cofactor matrix (the
  // det division is dropped because the shader renormalizes).  This keeps
  // lighting correct for the tapered cone meshes, whose slanted normals a
  // plain mat3(uModel) would drag toward the axis under anisotropic scale.
  function normalMatrix(out, m) {
    const a = m[0], b = m[1], c = m[2], d = m[4], e = m[5], f = m[6], g = m[8], h = m[9], i = m[10];
    out[0] = e * i - f * h; out[1] = f * g - d * i; out[2] = d * h - e * g;
    out[3] = c * h - b * i; out[4] = a * i - c * g; out[5] = b * g - a * h;
    out[6] = b * f - c * e; out[7] = c * d - a * f; out[8] = a * e - b * d;
    return out;
  }

  function cubeGeometry() {
    const positions = [], normals = [], uvs = [], indices = [];
    const faces = [
      { n: [1, 0, 0], v: [[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]] },
      { n: [-1, 0, 0], v: [[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]] },
      { n: [0, 1, 0], v: [[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]] },
      { n: [0, -1, 0], v: [[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]] },
      { n: [0, 0, 1], v: [[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,1]] },
      { n: [0, 0, -1], v: [[-1,-1,-1],[-1,1,-1],[1,1,-1],[1,-1,-1]] },
    ];
    faces.forEach((face, f) => {
      const base = f * 4;
      face.v.forEach((v, i) => { positions.push(...v); normals.push(...face.n); uvs.push(i === 0 || i === 3 ? 0 : 1, i < 2 ? 0 : 1); });
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    });
    return { positions, normals, uvs, indices };
  }

  function sphereGeometry(latitudes = 30, longitudes = 44) {
    const positions = [], normals = [], uvs = [], indices = [];
    for (let lat = 0; lat <= latitudes; lat += 1) {
      const v = lat / latitudes;
      const phi = v * Math.PI;
      const y = Math.cos(phi), ring = Math.sin(phi);
      for (let lon = 0; lon <= longitudes; lon += 1) {
        const u = lon / longitudes;
        const theta = u * Math.PI * 2;
        const x = Math.cos(theta) * ring, z = Math.sin(theta) * ring;
        positions.push(x, y, z); normals.push(x, y, z); uvs.push(u, v);
      }
    }
    for (let lat = 0; lat < latitudes; lat += 1) {
      for (let lon = 0; lon < longitudes; lon += 1) {
        const a = lat * (longitudes + 1) + lon, b = a + longitudes + 1;
        // Counter-clockwise from OUTSIDE the sphere.  The old (a, b, a+1)
        // order was inverted: back-face culling then showed the far
        // hemisphere's inner wall, mirroring textures and making every
        // rolling ball appear to spin backwards.
        indices.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    return { positions, normals, uvs, indices };
  }

  function circleGeometry(segments = 48) {
    const positions = [0, 0, 0], normals = [0, 1, 0], uvs = [0.5, 0.5], indices = [];
    for (let i = 0; i <= segments; i += 1) {
      const angle = i / segments * Math.PI * 2;
      const x = Math.cos(angle), z = Math.sin(angle);
      positions.push(x, 0, z); normals.push(0, 1, 0); uvs.push(x * 0.5 + 0.5, z * 0.5 + 0.5);
    }
    // Counter-clockwise when viewed from above (+Y), matching the renderer's back-face culling.
    for (let i = 1; i <= segments; i += 1) indices.push(0, i + 1, i);
    return { positions, normals, uvs, indices };
  }

  // Straight cylinders and truncated cones share one generator: the top ring
  // (+Y) uses topRadius so a cone mesh can be scaled by its tip radius alone.
  function cylinderGeometry(segments = 40, topRadius = 1, bottomRadius = 1) {
    const positions = [], normals = [], uvs = [], indices = [];
    const topCenter = positions.length / 3;
    positions.push(0, 1, 0); normals.push(0, 1, 0); uvs.push(0.5, 0.5);
    for (let i = 0; i <= segments; i += 1) {
      const angle = i / segments * Math.PI * 2, x = Math.cos(angle), z = Math.sin(angle);
      positions.push(x * topRadius, 1, z * topRadius); normals.push(0, 1, 0); uvs.push(x * 0.5 + 0.5, z * 0.5 + 0.5);
    }
    for (let i = 0; i < segments; i += 1) indices.push(topCenter, topCenter + i + 2, topCenter + i + 1);

    const bottomCenter = positions.length / 3;
    positions.push(0, -1, 0); normals.push(0, -1, 0); uvs.push(0.5, 0.5);
    for (let i = 0; i <= segments; i += 1) {
      const angle = i / segments * Math.PI * 2, x = Math.cos(angle), z = Math.sin(angle);
      positions.push(x * bottomRadius, -1, z * bottomRadius); normals.push(0, -1, 0); uvs.push(x * 0.5 + 0.5, z * 0.5 + 0.5);
    }
    for (let i = 0; i < segments; i += 1) indices.push(bottomCenter, bottomCenter + i + 1, bottomCenter + i + 2);

    const slopeY = (bottomRadius - topRadius) / 2;
    for (let i = 0; i < segments; i += 1) {
      const a = i / segments * Math.PI * 2, b = (i + 1) / segments * Math.PI * 2;
      const x0 = Math.cos(a), z0 = Math.sin(a), x1 = Math.cos(b), z1 = Math.sin(b);
      const base = positions.length / 3;
      positions.push(
        x0 * bottomRadius, -1, z0 * bottomRadius, x0 * topRadius, 1, z0 * topRadius,
        x1 * topRadius, 1, z1 * topRadius, x1 * bottomRadius, -1, z1 * bottomRadius,
      );
      const push = (x, z) => {
        const len = Math.hypot(x, slopeY, z) || 1;
        normals.push(x / len, slopeY / len, z / len);
      };
      push(x0, z0); push(x0, z0); push(x1, z1); push(x1, z1);
      uvs.push(0, 0, 0, 1, 1, 1, 1, 0);
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    return { positions, normals, uvs, indices };
  }

  // Flat XZ pie/annulus sector, +Y normal, bisector along +X: pocket plates,
  // pocket holes and the snooker D arc all come from this one generator.
  function sectorGeometry(segments, sweep, innerRatio = 0) {
    const positions = [], normals = [], uvs = [], indices = [];
    const start = -sweep / 2;
    if (innerRatio <= 0) {
      positions.push(0, 0, 0); normals.push(0, 1, 0); uvs.push(0.5, 0.5);
      for (let i = 0; i <= segments; i += 1) {
        const angle = start + i / segments * sweep;
        const x = Math.cos(angle), z = Math.sin(angle);
        positions.push(x, 0, z); normals.push(0, 1, 0); uvs.push(x * 0.5 + 0.5, z * 0.5 + 0.5);
      }
      for (let i = 1; i <= segments; i += 1) indices.push(0, i + 1, i);
      return { positions, normals, uvs, indices };
    }
    for (let i = 0; i <= segments; i += 1) {
      const angle = start + i / segments * sweep;
      const x = Math.cos(angle), z = Math.sin(angle);
      positions.push(x * innerRatio, 0, z * innerRatio, x, 0, z);
      normals.push(0, 1, 0, 0, 1, 0);
      uvs.push(x * innerRatio * 0.5 + 0.5, z * innerRatio * 0.5 + 0.5, x * 0.5 + 0.5, z * 0.5 + 0.5);
    }
    for (let i = 0; i < segments; i += 1) {
      const a = i * 2;
      indices.push(a, a + 3, a + 1, a, a + 2, a + 3);
    }
    return { positions, normals, uvs, indices };
  }

  // A convex cross-section swept along X. Real sloped cushion noses and
  // chamfered rail caps catch a fine highlight without stacks of box faces.
  function prismGeometry(profile) {
    const positions = [], normals = [], uvs = [], indices = [];
    const face = (vertices, normal) => {
      const offset = positions.length / 3;
      vertices.forEach((v, i) => { positions.push(...v); normals.push(...normal); uvs.push(i > 1 ? 1 : 0, i % 3 ? 1 : 0); });
      for (let i = 1; i < vertices.length - 1; i += 1) indices.push(offset, offset + i, offset + i + 1);
    };
    // Profile is counterclockwise in the (depth, height) plane.
    for (let i = 0; i < profile.length; i += 1) {
      const [z0, y0] = profile[i], [z1, y1] = profile[(i + 1) % profile.length];
      const length = Math.hypot(y1 - y0, z1 - z0);
      face([[-1, y0, z0], [1, y0, z0], [1, y1, z1], [-1, y1, z1]], [0, -(z1 - z0) / length, (y1 - y0) / length]);
    }
    face(profile.map(([z, y]) => [-1, y, z]), [-1, 0, 0]);
    face([...profile].reverse().map(([z, y]) => [1, y, z]), [1, 0, 0]);
    return { positions, normals, uvs, indices };
  }

  // Inward-facing, open tube: unlike a capped cylinder it actually lets a
  // full-size ball disappear below the slate. +X is the pocket's back.
  function pocketLinerGeometry(segments = 64, sweep = Math.PI * 2, bottomRadius = 0.88) {
    const positions = [], normals = [], uvs = [], indices = [];
    for (let i = 0; i <= segments; i += 1) {
      const angle = -sweep / 2 + i / segments * sweep;
      const x = Math.cos(angle), z = Math.sin(angle);
      positions.push(x, 0, z, x * bottomRadius, -1, z * bottomRadius);
      const length = Math.hypot(1, 1 - bottomRadius);
      normals.push(-x / length, (1 - bottomRadius) / length, -z / length, -x / length, (1 - bottomRadius) / length, -z / length);
      uvs.push(i / segments * 4, 0, i / segments * 4, 1);
      if (i < segments) {
        const a = i * 2;
        indices.push(a, a + 1, a + 3, a, a + 3, a + 2);
      }
    }
    return { positions, normals, uvs, indices };
  }

  function jawGeometry(radius, top, contactHeight, segments = 48) {
    const positions = [], normals = [], uvs = [], indices = [];
    const profile = [[radius - 0.008, 0], [radius - 0.006, 0.015], [radius, contactHeight], [radius - 0.002, top - 0.002], [radius - 0.006, top], [0, top]];
    for (let band = 0; band < profile.length - 1; band += 1) {
      const [r0, y0] = profile[band], [r1, y1] = profile[band + 1];
      const length = Math.hypot(r1 - r0, y1 - y0);
      const offset = positions.length / 3;
      for (let i = 0; i <= segments; i += 1) {
        const a = i / segments * Math.PI * 2, x = Math.cos(a), z = Math.sin(a);
        positions.push(x * r0, y0, z * r0, x * r1, y1, z * r1);
        for (let j = 0; j < 2; j += 1) normals.push(x * (y1 - y0) / length, (r0 - r1) / length, z * (y1 - y0) / length);
        uvs.push(i / segments, band / profile.length, i / segments, (band + 1) / profile.length);
        if (i < segments) {
          const base = offset + i * 2;
          indices.push(base, base + 1, base + 3, base, base + 3, base + 2);
        }
      }
    }
    return { positions, normals, uvs, indices };
  }

  // A turned profile of [radius, y] pairs swept about +Y and cut into flat
  // facets, capped at both ends: the faceted vase of a Joy golden leg.
  function latheGeometry(profile, facets = 12) {
    const positions = [], normals = [], uvs = [], indices = [];
    const top = profile.at(-1)[1];
    const point = (r, y, a) => [Math.cos(a) * r, y, Math.sin(a) * r];
    for (let band = 0; band < profile.length - 1; band += 1) {
      const [r0, y0] = profile[band], [r1, y1] = profile[band + 1];
      for (let i = 0; i < facets; i += 1) {
        const a0 = i / facets * Math.PI * 2, a1 = (i + 1) / facets * Math.PI * 2;
        const quad = [point(r0, y0, a0), point(r1, y1, a0), point(r1, y1, a1), point(r0, y0, a1)];
        const mid = (a0 + a1) / 2, slope = (r0 - r1) / Math.hypot(r1 - r0, y1 - y0);
        const along = Math.sqrt(Math.max(0, 1 - slope * slope));
        const normal = [Math.cos(mid) * along, slope, Math.sin(mid) * along];
        const base = positions.length / 3;
        quad.forEach((v, k) => {
          positions.push(...v); normals.push(...normal);
          uvs.push((i + (k > 1 ? 1 : 0)) / facets, (k === 1 || k === 2 ? y1 : y0) / top);
        });
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
      }
    }
    [[profile[0], -1], [profile.at(-1), 1]].forEach(([[r, y], up]) => {
      const centre = positions.length / 3;
      positions.push(0, y, 0); normals.push(0, up, 0); uvs.push(0.5, 0.5);
      for (let i = 0; i <= facets; i += 1) {
        const a = i / facets * Math.PI * 2;
        positions.push(...point(r, y, a)); normals.push(0, up, 0); uvs.push(0.5 + Math.cos(a) / 2, 0.5 + Math.sin(a) / 2);
      }
      for (let i = 0; i < facets; i += 1) {
        if (up > 0) indices.push(centre, centre + i + 2, centre + i + 1);
        else indices.push(centre, centre + i + 1, centre + i + 2);
      }
    });
    return { positions, normals, uvs, indices };
  }

  function emptyGeometry() {
    return { positions: [], normals: [], uvs: [], indices: [] };
  }

  // A smooth indexed surface between matching curves. A separate call per
  // cross-section band retains the fine crease at a cushion's rubber nose.
  function appendSurface(mesh, rows, normalAt) {
    const start = mesh.positions.length / 3, count = rows[0].length;
    rows.forEach((row) => row.forEach((p) => {
      mesh.positions.push(...p); mesh.normals.push(0, 0, 0); mesh.uvs.push(p[0], p[2]);
    }));
    const triangle = (a, b, c, hint) => {
      const p = mesh.positions;
      const u = [0, 1, 2].map((d) => p[b * 3 + d] - p[a * 3 + d]);
      const v = [0, 1, 2].map((d) => p[c * 3 + d] - p[a * 3 + d]);
      let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
      if (Math.hypot(...n) < 1e-14) return;
      if (n.reduce((sum, value, d) => sum + value * hint[d], 0) < 0) {
        [b, c] = [c, b]; n = n.map((value) => -value);
      }
      mesh.indices.push(a, b, c);
      [a, b, c].forEach((index) => n.forEach((value, d) => { mesh.normals[index * 3 + d] += value; }));
    };
    for (let i = 0; i < rows.length - 1; i += 1) {
      for (let j = 0; j < count - 1; j += 1) {
        const a = start + i * count + j, b = a + count, hint = normalAt(j, i);
        triangle(a, b, b + 1, hint); triangle(a, b + 1, a + 1, hint);
      }
    }
    for (let i = start; i < mesh.positions.length / 3; i += 1) {
      const length = Math.hypot(...mesh.normals.slice(i * 3, i * 3 + 3));
      for (let d = 0; d < 3; d += 1) mesh.normals[i * 3 + d] /= length || 1;
    }
  }

  function chineseCushionGeometry(table, segment) {
    const mesh = emptyGeometry(), back = table.cushionBackDepth;
    const top = table.cushionTopHeight, nose = table.cushionContactHeight;
    const ridgeInset = 0.0035, rise = 0.014;
    const height = (depth) => top + rise * (depth - ridgeInset) / (back - ridgeInset);
    const levels = [[0.009, -0.002], [0.006, 0.018], [0, nose], [ridgeInset, null]];
    const contours = levels.map(([inset]) => global.BilliardsPhysics.roundedCushionContour(table, segment, inset));
    const rows = contours.map((path, i) => path.map((p) => [p.x, levels[i][1] ?? height(p.depth), p.z]));
    for (let i = 0; i < rows.length - 1; i += 1) {
      appendSurface(mesh, [rows[i], rows[i + 1]], (j) => [contours[i][j].nx, 0, contours[i][j].nz]);
    }
    const cap = (row, y, upward) => {
      const mid = (segment.min + segment.max) / 2, depth = back * 0.65;
      const centre = [
        (segment.axis === 'x' ? mid : segment.value) - segment.normal.x * depth,
        y ?? height(depth),
        (segment.axis === 'x' ? segment.value : mid) - segment.normal.z * depth,
      ];
      const boundary = [...row, row[0]];
      appendSurface(mesh, [boundary, boundary.map(() => centre)], () => [0, upward ? 1 : -1, 0]);
    };
    cap(rows[0], -0.002, false);
    cap(rows.at(-1), null, true);
    appendSurface(mesh, rows.map((row) => [row[0], row.at(-1)]), () => [-segment.normal.x, 0, -segment.normal.z]);
    return mesh;
  }

  // Reference-shaped Chinese pocket irons. Straight wood caps terminate at
  // these brackets; the cloth returns sit inside a broad, open U, rather than
  // meeting a little circular ring cut into an uninterrupted wooden corner.
  function chinesePocketGeometry(table, pocket, steps = 64) {
    const plate = emptyGeometry(), facing = emptyGeometry(), clothReturns = emptyGeometry();
    const railTop = table.cushionTopHeight + 0.017, rail = table.railWidth;
    const inner = 0.056, corner = pocket.type === 'corner';
    const joint = -table.cornerGap + global.BilliardsPhysics.cushionEndExtension(table, false, inner, 0.0035);
    const sideJoint = table.sideMouth * 0.68;
    const axis = pocket.outward, perpendicular = { x: -axis.z, z: axis.x };
    const centre = { x: pocket.x, z: pocket.z };
    const cornerCentre = { x: Math.sign(axis.x) * table.width / 2, z: Math.sign(axis.z) * table.height / 2 };
    const pc = corner ? (pocket.x - cornerCentre.x) * Math.sign(axis.x) : pocket.z * Math.sign(axis.z) - table.height / 2;
    const endpointAlong = corner ? (joint + inner - 2 * pc) * Math.SQRT1_2 : inner - pc;
    const endpointAcross = corner ? (inner - joint) * Math.SQRT1_2
      : table.sideGap - global.BilliardsPhysics.cushionEndExtension(table, true, inner, 0.0035);
    const a = pocket.radiusAlong + (corner ? 0.007 : 0.001);
    const angle = Math.acos(clamp(endpointAlong / a, -0.99, 0.99));
    const b = endpointAcross / Math.sin(angle);
    const innerPoints = [], outerPoints = [], bottomPoints = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps, theta = -angle + 2 * angle * t;
      const c = Math.cos(theta), s = Math.sin(theta);
      innerPoints.push([centre.x + axis.x * a * c + perpendicular.x * b * s, railTop, centre.z + axis.z * a * c + perpendicular.z * b * s]);
      bottomPoints.push([centre.x + axis.x * pocket.radiusAlong * c + perpendicular.x * pocket.radiusAcross * s, -0.004, centre.z + axis.z * pocket.radiusAlong * c + perpendicular.z * pocket.radiusAcross * s]);
      let x, z;
      if (corner) {
        // Quarter-round outside corner with straight ends that exactly butt
        // against the two wooden cap sections.
        const radius = 0.082, arcCentre = rail - radius;
        const straight = arcCentre - joint, arc = radius * Math.PI / 2, length = 2 * straight + arc;
        const distance = t * length;
        if (distance < straight) { x = rail; z = joint + distance; }
        else if (distance <= straight + arc) {
          const turn = (distance - straight) / radius;
          x = arcCentre + radius * Math.cos(turn); z = arcCentre + radius * Math.sin(turn);
        } else { x = arcCentre - (distance - straight - arc); z = rail; }
        // The local curve runs right-hand joint → rear → left-hand joint.
        // Reflection is determined by the pocket basis, not triangle winding.
        const along = (x + z - 2 * pc) * Math.SQRT1_2, across = (z - x) * Math.SQRT1_2;
        outerPoints.push([centre.x + axis.x * along + perpendicular.x * across, railTop, centre.z + axis.z * along + perpendicular.z * across]);
      } else {
        const radius = 0.014, straight = rail - inner - radius;
        const cross = 2 * (sideJoint - radius), arc = radius * Math.PI / 2;
        let distance = t * (2 * straight + 2 * arc + cross);
        if (distance < straight) { x = -sideJoint; z = inner + distance; }
        else if ((distance -= straight) < arc) {
          const turn = distance / radius;
          x = -sideJoint + radius - radius * Math.cos(turn); z = rail - radius + radius * Math.sin(turn);
        } else if ((distance -= arc) < cross) { x = -sideJoint + radius + distance; z = rail; }
        else if ((distance -= cross) < arc) {
          const turn = distance / radius;
          x = sideJoint - radius + radius * Math.sin(turn); z = rail - radius + radius * Math.cos(turn);
        } else { distance -= arc; x = sideJoint; z = rail - radius - distance; }
        outerPoints.push([centre.x + perpendicular.x * x + axis.x * (z - pc), railTop, centre.z + perpendicular.z * x + axis.z * (z - pc)]);
      }
    }
    // Rolled outside edge, substantial skirt, and a dark leather funnel below
    // the bracket. The slate aperture remains the solver's exact ellipse.
    const bevel = outerPoints.map((p, i) => {
      const dx = innerPoints[i][0] - p[0], dz = innerPoints[i][2] - p[2], length = Math.hypot(dx, dz);
      return [p[0] + dx / length * 0.003, railTop, p[2] + dz / length * 0.003];
    });
    const shoulder = outerPoints.map((p) => [p[0], railTop - 0.004, p[2]]);
    const bottom = outerPoints.map((p) => [p[0], -0.033, p[2]]);
    appendSurface(plate, [innerPoints, bevel], () => [0, 1, 0]);
    const outNormal = (j) => [outerPoints[j][0] - innerPoints[j][0], 0, outerPoints[j][2] - innerPoints[j][2]];
    appendSurface(plate, [bevel, shoulder, bottom], outNormal);
    appendSurface(facing, [innerPoints, bottomPoints], (j) => [centre.x - innerPoints[j][0], 0, centre.z - innerPoints[j][2]]);
    // Close the two small cheeks where cloth folds from the cushion backing
    // to the slate lip. Without them, an oblique view exposes the cabinet
    // through a triangular seam between the cushion and the leather boot.
    [0, steps].forEach((index) => {
      const target = innerPoints[index], lip = bottomPoints[index];
      let closest = null;
      table.cushions.forEach((segment) => {
        const path = global.BilliardsPhysics.roundedCushionContour(table, segment, 0.0035);
        [0, path.length - 1].forEach((end) => {
          const p = path[end], distance = Math.hypot(p.x - target[0], p.z - target[2]);
          if (!closest || distance < closest.distance) closest = { segment, end, distance };
        });
      });
      const rows = [[0.009, -0.002], [0.006, 0.018], [0, table.cushionContactHeight], [0.0035, table.cushionTopHeight + 0.014]].map(([inset, y]) => {
        const p = global.BilliardsPhysics.roundedCushionContour(table, closest.segment, inset)[closest.end];
        const t = (y - lip[1]) / (target[1] - lip[1]);
        return [[p.x, y, p.z], [lip[0] + (target[0] - lip[0]) * t, y, lip[2] + (target[2] - lip[2]) * t]];
      });
      appendSurface(clothReturns, rows, () => [centre.x - target[0], 0, centre.z - target[2]]);
    });
    return { plate, facing, clothReturns };
  }

  function pixelNoise(x, y, seed) {
    let value = Math.imul(x + seed * 17, 374761393) + Math.imul(y + seed * 31, 668265263);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
  }

  function materialCanvas(kind, size = 256) {
    const canvas = document.createElement('canvas');
    canvas.width = size; canvas.height = size;
    const ctx = canvas.getContext('2d');
    const image = ctx.createImageData(size, size);
    const seed = { cloth: 11, wood: 23, rubber: 37, metal: 53, net: 61 }[kind] || 7;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const noise = pixelNoise(x, y, seed) - 0.5;
        let value = 190;
        if (kind === 'cloth') {
          const warp = Math.sin(x * Math.PI * 0.92) * 7;
          const weft = Math.sin(y * Math.PI * 0.78 + x * 0.08) * 5;
          const nap = Math.sin((x + y * 0.17) * 0.19) * 3;
          value = 186 + warp + weft + nap + noise * 12;
        } else if (kind === 'wood') {
          const bend = Math.sin(x * 0.024) * 2.8 + Math.sin(x * 0.006) * 6.0;
          const ring = Math.sin(y * 0.115 + bend) * 11 + Math.sin(y * 0.31 + bend * 0.4) * 3;
          const pore = pixelNoise(x * 3, y * 5, seed + 4) > 0.970 ? -22 : 0;
          value = 190 + ring + pore + noise * 6;
        } else if (kind === 'rubber') {
          const stipple = pixelNoise(x * 5, y * 7, seed + 8) > 0.92 ? -18 : 0;
          const mould = Math.sin(x * 0.43 + y * 0.07) * 2.5;
          value = 181 + stipple + mould + noise * 10;
        } else if (kind === 'metal') {
          const brush = Math.sin(y * 1.21) * 8 + Math.sin(y * 0.27) * 4;
          const longScratch = pixelNoise(0, y, seed + 2) > 0.93 ? 18 : 0;
          value = 194 + brush + longScratch + noise * 7;
        } else if (kind === 'net') {
          // Knotted diamond mesh of white cord over the dark drop.
          const u = (x + y) % 32, w = (x - y + 256) % 32;
          const cord = Math.min(u, 32 - u) < 3.2 || Math.min(w, 32 - w) < 3.2;
          value = cord ? 228 + noise * 18 : 26 + noise * 10;
        }
        value = kind === 'net' ? Math.round(value) : Math.max(78, Math.min(244, Math.round(value)));
        const index = (y * size + x) * 4;
        image.data[index] = value;
        image.data[index + 1] = value;
        image.data[index + 2] = value;
        image.data[index + 3] = 255;
      }
    }
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  function createMesh(gl, geometry) {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const bindAttribute = (data, location, size) => {
      const buffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, 0, 0);
    };
    bindAttribute(geometry.positions, 0, 3);
    bindAttribute(geometry.normals, 1, 3);
    bindAttribute(geometry.uvs, 2, 2);
    const indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array(geometry.indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: geometry.indices.length };
  }

  function yawQuat(direction) {
    // Rotation about +Y taking the mesh's +X bisector to `direction` (XZ unit).
    const angle = Math.atan2(-direction.z, direction.x);
    return [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];
  }

  // A professional table's only real light: a canopy hung about a metre
  // above the bed (WPA: no lower than 40 in for a fixture the referee can
  // swing aside), close to the table's length.  As in current Chinese clubs
  // its underside is a row of large diffuser panels split by dark cross
  // bars; each panel is also one shadow-casting cap.  `spread` stands in for
  // the fixture optics that keep rails and corners close to the centre (WPA
  // asks that the centre not be noticeably brighter than rails and corners).
  function lampRig(table) {
    const snooker = table.style === 'snooker';
    const panels = snooker ? 4 : 3, bar = 0.07;
    const panelX = snooker ? 0.84 : 0.78, panelZ = snooker ? 1.10 : 0.90;
    const spanX = panels * panelX + (panels - 1) * bar;
    const cells = [], groups = [];
    for (let i = 0; i < panels; i += 1) {
      const x0 = -spanX / 2 + i * (panelX + bar);
      cells.push(x0, -panelZ / 2, x0 + panelX, panelZ / 2);
      groups.push(x0 + panelX / 2, 0, panelX * panelZ);
    }
    const height = 1.0, outline = [-spanX / 2, -panelZ / 2, spanX / 2, panelZ / 2];
    return {
      height, outline, cells, groups, columns: panels, cellCount: panels,
      norm: 1 / rectangleFormFactor(outline, height),
      spread: snooker ? [0.55, 0.7] : [0.5, 0.4],
    };
  }

  // Form factor from a point on the bed centre, normal up, to a horizontal
  // rectangle `height` above it (Lambert's polygon formula).
  function rectangleFormFactor([x0, z0, x1, z1], height) {
    const corners = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]].map(([x, z]) => {
      const length = Math.hypot(x, height, z);
      return [x / length, height / length, z / length];
    });
    let sum = 0;
    corners.forEach((a, i) => {
      const b = corners[(i + 1) % 4];
      const cross = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const angle = Math.acos(clamp(a[0] * b[0] + a[1] * b[1] + a[2] * b[2], -1, 1));
      sum += angle * cross[1] / (Math.hypot(...cross) || 1);
    });
    return Math.abs(sum) / (2 * Math.PI);
  }

  function linearRgb(color) {
    return hexToRgb(color).map((c) => Math.pow(c, 2.2));
  }

  // Joy's champagne-gold trim, posts and legs.
  const CHAMPAGNE = '#cdb07e';

  // Joy aprons are a deep red-brown: the theme's rail wood, darkened and
  // pulled toward mahogany so every colour scheme keeps one family of wood.
  function mahoganyApron(wood) {
    const [r, g, b] = hexToRgb(wood), mahogany = [0.24, 0.085, 0.065];
    const mix = [r, g, b].map((c, i) => c * 0.55 * 0.6 + mahogany[i] * 0.4);
    return `#${mix.map((c) => Math.round(clamp(c, 0, 1) * 255).toString(16).padStart(2, '0')).join('')}`;
  }

  // The dark hall around the table, shared by the clear colour and the
  // floor's fade so the two meet without a seam.
  const HALL_SRGB = [0.043, 0.052, 0.055];
  const HALL_LINEAR = HALL_SRGB.map((c) => Math.pow(c, 2.2) / 1.12);

  class BilliardsRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' });
      if (!this.gl) throw new Error('WebGL 2 unavailable');
      const gl = this.gl;
      // Materials: 0 ball resin, 1 cloth, 2 wood, 3 flat marking, 4 rubber
      // and leather, 5 brass, 6 cue lacquer, 7 hall floor, 8 soft blob,
      // 9 pocket net.
      const uniformNames = ['uModel', 'uNormalMatrix', 'uViewProjection', 'uColor', 'uCameraPosition', 'uTexture', 'uTextureMode', 'uTextureScale', 'uTableHalfSize', 'uRailWidth', 'uOpacity', 'uCutPockets', 'uPockets[0]', 'uPocketAxes[0]',
        'uLampHeight', 'uLampOutline', 'uLampCells[0]', 'uLampCellCount', 'uLampColumns[0]', 'uLampColumnCount', 'uLampNorm', 'uLampSpread', 'uLampLuminance',
        'uBalls[0]', 'uBallTints[0]', 'uBallCount', 'uSelfBall', 'uCueTip', 'uCueButt', 'uClothAlbedo', 'uExposure',
        'uOccluderGrid', 'uGridRect', 'uHallLamps[0]', 'uHallColor'];
      this.programs = Array.from({ length: 10 }, (_, material) => {
        const program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER.replace('#version 300 es', `#version 300 es\n    #define MATERIAL ${material}`));
        const uniforms = {};
        uniformNames.forEach((name) => { uniforms[name] = gl.getUniformLocation(program, name); });
        return { program, uniforms, frame: -1 };
      });
      this.frame = 0;
      this.frameUniforms = [];
      this.activeProgram = null;
      this.cutPockets = true;
      this.selfBall = -1;
      this.normalMatrixScratch = new Float32Array(9);
      this.meshes = {
        cube: createMesh(gl, cubeGeometry()),
        sphere: createMesh(gl, sphereGeometry(30, 44)),
        circle: createMesh(gl, circleGeometry()),
        cylinder: createMesh(gl, cylinderGeometry()),
        cueShaft: createMesh(gl, cylinderGeometry(24, 1, 1.95)),
        leg: createMesh(gl, cylinderGeometry(22, 1, 0.80)),
        // Joy golden leg, floor to cabinet (metres): round foot, ring, a
        // faceted vase swelling low, a collar under the corner block.
        goldenLeg: createMesh(gl, latheGeometry([
          [0.058, 0], [0.063, 0.012], [0.063, 0.030], [0.052, 0.042], [0.061, 0.056], [0.056, 0.072],
          [0.074, 0.110], [0.088, 0.180], [0.087, 0.250], [0.078, 0.330], [0.064, 0.410],
          [0.071, 0.428], [0.071, 0.446], [0.060, 0.462], [0.062, 0.530],
        ], 12)),
        pocketLiner: createMesh(gl, pocketLinerGeometry()),
        pocketBack: createMesh(gl, pocketLinerGeometry(40, Math.PI, 1)),
        pocketCollar: createMesh(gl, sectorGeometry(40, Math.PI, 1 / 1.16)),
        pocketTrim: createMesh(gl, sectorGeometry(40, Math.PI, 0.975)),
        slateLip: createMesh(gl, pocketLinerGeometry(64, Math.PI * 2, 1.06)),
        arcLine: createMesh(gl, sectorGeometry(48, Math.PI, 0.9925)),
      };
      this.textures = new Map();
      this.tableMeshes = new Map();
      this.anisotropy = gl.getExtension('EXT_texture_filter_anisotropic')
        || gl.getExtension('MOZ_EXT_texture_filter_anisotropic')
        || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic');
      const rendererInfo = gl.getExtension('WEBGL_debug_renderer_info');
      this.rendererName = rendererInfo
        ? gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
      this.softwareRenderer = /swiftshader|llvmpipe|software/i.test(this.rendererName || '');
      // Software WebGL is a compatibility path. Rendering it below native CSS
      // resolution preserves the full physics/material model while avoiding a
      // needlessly sluggish fallback; hardware WebGL remains full resolution.
      this.resolutionScale = this.softwareRenderer ? 0.8 : 1;
      this.cameraMode = 'perspective';
      this.zoom = 1;
      this.orbit = null; // { yaw, pitch } once the user grabs the view; null = auto framing
      this.viewProjection = Mat4.identity();
      this.cameraPosition = { x: 0, y: 2.2, z: 2.1 };
      this.table = null;
      this.cssWidth = 1;
      this.cssHeight = 1;
      this.devicePixelRatio = 1;
      this.ballStyle = 'tv';
      this.tableTheme = 'club';
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(HALL_SRGB[0], HALL_SRGB[1], HALL_SRGB[2], 1);
    }

    setTable(table) {
      this.table = table;
      this.prepareTableMeshes(table);
      this.zoom = 1;
      this.updateCamera();
    }

    prepareTableMeshes(table) {
      const key = table.style;
      if (!this.tableMeshes.has(key)) {
        const top = table.cushionTopHeight, nose = table.cushionContactHeight;
        const railTop = top + 0.017, inner = 0.056, outer = table.railWidth;
        this.tableMeshes.set(key, {
          cushionProfile: createMesh(this.gl, prismGeometry([[0.009, 0], [0.060, 0], [0.060, top], [0.006, top], [0, nose]])),
          railProfile: createMesh(this.gl, prismGeometry([[inner + 0.003, -0.036], [outer - 0.003, -0.036], [outer, -0.033], [outer, railTop - 0.004], [outer - 0.004, railTop], [inner + 0.004, railTop], [inner, railTop - 0.004], [inner, -0.033]])),
          jawProfile: createMesh(this.gl, jawGeometry(table.jawRadius, top, nose)),
        });
        if (table.style === 'chinese') {
          const meshes = this.tableMeshes.get(key);
          table.cushions.forEach((segment) => {
            meshes[`cloth-${segment.id}`] = createMesh(this.gl, chineseCushionGeometry(table, segment));
          });
          table.pockets.forEach((pocket) => {
            const geometry = chinesePocketGeometry(table, pocket);
            meshes[`iron-${pocket.id}`] = createMesh(this.gl, geometry.plate);
            meshes[`facing-${pocket.id}`] = createMesh(this.gl, geometry.facing);
            meshes[`cheeks-${pocket.id}`] = createMesh(this.gl, geometry.clothReturns);
          });
        }
      }
      Object.assign(this.meshes, this.tableMeshes.get(key));
      this.lamp = lampRig(table);
      this.prepareOccluderGrid(table);
    }

    // A coarse grid over the table (5 cm cells, 35 cm beyond the cushions)
    // that tells the shaders which balls — and whether the stick — can shade
    // each cell this frame, so shading loops only visit real neighbours.
    prepareOccluderGrid(table) {
      const gl = this.gl, cell = 0.05, margin = 0.35;
      const cols = Math.ceil((table.width + 2 * margin) / cell), rows = Math.ceil((table.height + 2 * margin) / cell);
      if (this.occluderGrid) gl.deleteTexture(this.occluderGrid.texture);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const data = new Uint32Array(cols * rows);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32UI, cols, rows, 0, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
      this.occluderGrid = { texture, data, cols, rows, cell, x0: -table.width / 2 - margin, z0: -table.height / 2 - margin };
    }

    // Mark every cell within the canopy's shading reach (slope 1 : 2.6 from
    // the bed, the same bound the shaders test exactly) of each occluder.
    fillOccluderGrid(balls, count, stick) {
      const grid = this.occluderGrid, { data, cols, rows, cell, x0, z0 } = grid;
      data.fill(0);
      const mark = (bit, xMin, xMax, zMin, zMax, test) => {
        const c0 = Math.max(0, Math.floor((xMin - x0) / cell)), c1 = Math.min(cols - 1, Math.floor((xMax - x0) / cell));
        const r0 = Math.max(0, Math.floor((zMin - z0) / cell)), r1 = Math.min(rows - 1, Math.floor((zMax - z0) / cell));
        for (let r = r0; r <= r1; r += 1) {
          for (let c = c0; c <= c1; c += 1) {
            if (!test || test(x0 + (c + 0.5) * cell, z0 + (r + 0.5) * cell)) data[r * cols + c] |= bit;
          }
        }
      };
      for (let i = 0; i < count; i += 1) {
        const x = balls[i * 4], y = balls[i * 4 + 1], z = balls[i * 4 + 2], radius = balls[i * 4 + 3];
        const reach = (y + radius) * 2.6 + radius;
        if (reach > 0) mark(1 << i, x - reach, x + reach, z - reach, z + reach);
      }
      if (stick) {
        // A band around the stick's plan, as wide as the reach of its highest end.
        const reach = (Math.max(stick.tip.y, stick.butt.y) + stick.buttRadius) * 2.6 + stick.buttRadius;
        const ax = stick.tip.x, az = stick.tip.z, bx = stick.butt.x, bz = stick.butt.z;
        const abx = bx - ax, abz = bz - az, length2 = abx * abx + abz * abz || 1e-12;
        const slack = reach + cell * Math.SQRT1_2;
        mark(0x80000000, Math.min(ax, bx) - reach, Math.max(ax, bx) + reach, Math.min(az, bz) - reach, Math.max(az, bz) + reach, (cx, cz) => {
          const t = clamp(((cx - ax) * abx + (cz - az) * abz) / length2, 0, 1);
          return Math.hypot(cx - ax - abx * t, cz - az - abz * t) <= slack;
        });
      }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, grid.texture);
      // Canvas textures upload flipped; this raw grid must not be.
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RED_INTEGER, gl.UNSIGNED_INT, data);
      gl.activeTexture(gl.TEXTURE0);
    }

    toggleCamera() {
      this.cameraMode = this.cameraMode === 'perspective' ? 'top' : 'perspective';
      this.updateCamera();
      return this.cameraMode;
    }

    setZoom(delta) {
      this.zoom = clamp(this.zoom * delta, 0.62, 1.75);
      this.updateCamera();
    }

    // CAD-style turntable orbit: on the first grab, adopt the current pose so
    // there is no jump; deltas then steer yaw/pitch around the fixed target.
    orbitBy(dxPixels, dyPixels) {
      if (this.cameraMode !== 'perspective' || !this.table) return false;
      if (!this.orbit) {
        const tableScale = this.table.width;
        const target = { x: 0, y: -0.04, z: tableScale * 0.035 };
        const off = {
          x: this.cameraPosition.x - target.x,
          y: this.cameraPosition.y - target.y,
          z: this.cameraPosition.z - target.z,
        };
        const distance = Math.hypot(off.x, off.y, off.z) || 1;
        this.orbit = {
          yaw: Math.atan2(off.x, off.z),
          pitch: Math.asin(clamp(off.y / distance, -1, 1)),
        };
      }
      this.orbit.yaw -= dxPixels * 0.0052;
      this.orbit.pitch = clamp(this.orbit.pitch + dyPixels * 0.0052, 0.10, 1.50);
      this.updateCamera();
      return true;
    }

    resetOrbit() {
      const had = Boolean(this.orbit);
      this.orbit = null;
      this.zoom = 1;
      this.updateCamera();
      return had;
    }

    resize() {
      const dpr = Math.max(0.65, Math.min(global.devicePixelRatio || 1, 2) * this.resolutionScale);
      const width = Math.max(1, Math.round(this.canvas.clientWidth * dpr));
      const height = Math.max(1, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width; this.canvas.height = height;
      }
      this.cssWidth = this.canvas.clientWidth || width / dpr;
      this.cssHeight = this.canvas.clientHeight || height / dpr;
      this.devicePixelRatio = dpr;
      this.gl.viewport(0, 0, width, height);
      this.updateCamera();
    }

    updateCamera() {
      if (!this.table || !this.cssWidth || !this.cssHeight) return;
      const aspect = this.cssWidth / this.cssHeight;
      let projection, view;
      if (this.cameraMode === 'top') {
        const baseHalfX = this.table.width * 0.63;
        const halfX = baseHalfX * this.zoom;
        const halfZ = Math.max(this.table.height * 0.74, baseHalfX / aspect) * this.zoom;
        const widthFromHeight = halfZ * aspect;
        const finalHalfX = Math.max(halfX, widthFromHeight);
        projection = Mat4.ortho(-finalHalfX, finalHalfX, -halfZ, halfZ, 0.1, 12);
        this.cameraPosition = { x: 0, y: 5.5, z: 0.001 };
        view = Mat4.lookAt(this.cameraPosition, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
      } else {
        const tableScale = this.table.width;
        // Wider stages sit closer to the broadcast angle; narrow ones back off
        // so the full table always fits.
        const fit = clamp(2.15 / Math.max(aspect, 0.5), 1, 4.4);
        const target = { x: 0, y: -0.04, z: tableScale * 0.035 };
        const base = {
          x: -tableScale * 0.02 - target.x,
          y: tableScale * 0.82 * fit * this.zoom - target.y,
          z: tableScale * 0.72 * fit * this.zoom - target.z,
        };
        const distance = Math.hypot(base.x, base.y, base.z);
        let direction;
        if (this.orbit) {
          const cp = Math.cos(this.orbit.pitch);
          direction = { x: Math.sin(this.orbit.yaw) * cp, y: Math.sin(this.orbit.pitch), z: Math.cos(this.orbit.yaw) * cp };
        } else {
          direction = { x: base.x / distance, y: base.y / distance, z: base.z / distance };
        }
        this.cameraPosition = {
          x: target.x + direction.x * distance,
          y: target.y + direction.y * distance,
          z: target.z + direction.z * distance,
        };
        projection = Mat4.perspective(36 * Math.PI / 180, aspect, 0.05, 15);
        view = Mat4.lookAt(this.cameraPosition, target, { x: 0, y: 1, z: 0 });
      }
      this.viewProjection = Mat4.multiply(projection, view);
    }

    render(world, options = {}) {
      this.resize();
      if (this.table !== world.table) { this.table = world.table; this.prepareTableMeshes(world.table); this.updateCamera(); }
      // Retain the last WebGL frame while aiming/settings are unchanged.
      // This matters on software renderers and keeps an idle table quiet on
      // laptop batteries; every moving-ball pose still gets a fresh frame.
      const signature = [this.canvas.width, this.canvas.height, world.mode, this.tableTheme, this.ballStyle,
        this.cameraMode, this.zoom, this.orbit?.yaw, this.orbit?.pitch,
        options.showCue, options.aimDirection?.x, options.aimDirection?.z, options.elevation, options.pullback, options.tipX, options.tipY,
        world.cueType, world.tipType,
        ...world.balls.flatMap((b) => [b.id, b.color, b.pos.x, b.posY, b.pos.z, b.pocketed, b.sinkDepth, ...b.rotation]),
      ].join('|');
      if (signature === this.lastRenderSignature) return;
      this.lastRenderSignature = signature;
      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      const stick = options.showCue
        ? this.cueFrame(world, options.aimDirection, options.elevation || 0, options.pullback || 0, options.tipX || 0, options.tipY || 0)
        : null;
      this.beginFrame(world, stick);

      this.cutPockets = true;
      this.drawEnvironment(world);
      this.drawTable(world);
      this.cutPockets = false;
      this.drawBalls(world);
      if (stick) this.drawCue(stick);
      this.drawCanopy();
    }

    // The fixture itself is only in shot from below it (a low orbit); from
    // the broadcast angle the camera sits above the canopy, as a TV camera
    // looks down through its frame, so drawing it there would hide the table.
    drawCanopy() {
      const lamp = this.lamp;
      if (this.cameraMode === 'top' || this.cameraPosition.y > lamp.height - 0.03) return;
      const [x0, z0, x1, z1] = lamp.outline, rim = 0.07;
      const centre = { x: (x0 + x1) / 2, y: lamp.height + 0.045, z: (z0 + z1) / 2 };
      this.cutPockets = false;
      this.draw('cube', Mat4.translationScale(centre, { x: (x1 - x0) / 2 + rim, y: 0.045, z: (z1 - z0) / 2 + rim }), '#2b2d2e', 5, 1, this.getMaterialTexture('metal'), 2, { x: 4, y: 1 });
      for (let i = 0; i < lamp.cells.length; i += 4) {
        const [a, b, c, d] = lamp.cells.slice(i, i + 4);
        this.draw('cube', Mat4.translationScale({ x: (a + c) / 2, y: lamp.height - 0.001, z: (b + d) / 2 }, { x: (c - a) / 2, y: 0.001, z: (d - b) / 2 }), '#f6f3ea', 3, 1);
      }
    }

    // Per-frame uniforms, uploaded lazily to each material program the
    // first time it draws in the frame: camera, pocket cut-outs, the canopy,
    // the balls it lights and shadows (with a rough average colour for their
    // reflections in one another) and the stick's shadow.
    beginFrame(world, stick) {
      const t = world.table, lamp = this.lamp;
      const balls = new Float32Array(96), tints = new Float32Array(72);
      this.ballSlots = new Map();
      for (const ball of world.balls) {
        if (this.ballSlots.size >= 24) break;
        if (ball.pocketed && (!ball.sinkTarget || ball.sinkDepth >= 0.22)) continue;
        const slot = this.ballSlots.size;
        balls.set([ball.pos.x, ball.radius + (ball.posY || 0), ball.pos.z, ball.radius], slot * 4);
        const tint = linearRgb(ball.kind === 'cue' ? '#f0f3eb' : ball.color);
        const ivory = ball.kind === 'stripe' ? 0.45 : 0;
        tints.set(tint.map((c) => c * (1 - ivory) + 0.84 * ivory), slot * 3);
        this.ballSlots.set(ball, slot);
      }
      this.fillOccluderGrid(balls, this.ballSlots.size, stick);
      const grid = this.occluderGrid;
      const c = this.cameraPosition;
      // Neighbouring tables: one to each side and one beyond each end.
      const [x0, z0, x1, z1] = lamp.outline, pitchZ = t.height + 1.9, pitchX = t.width + 2.1;
      const hallLamps = [[0, pitchZ], [0, -pitchZ], [pitchX, 0], [-pitchX, 0]].flatMap(([dx, dz]) => [x0 + dx, z0 + dz, x1 + dx, z1 + dz]);
      this.frameUniforms = [
        ['uHallLamps[0]', '4fv', hallLamps],
        ['uHallColor', '3fv', HALL_LINEAR],
        ['uOccluderGrid', '1i', 1],
        ['uGridRect', '4fv', [grid.x0, grid.z0, 1 / grid.cell, 0]],
        ['uViewProjection', 'mat4', this.viewProjection],
        ['uCameraPosition', '3fv', [c.x, c.y, c.z]],
        ['uTexture', '1i', 0],
        ['uTableHalfSize', '2fv', [t.width / 2, t.height / 2]],
        ['uRailWidth', '1f', t.railWidth],
        ['uPockets[0]', '4fv', t.pockets.flatMap((p) => [p.x, p.z, p.radiusAlong, p.radiusAcross])],
        ['uPocketAxes[0]', '2fv', t.pockets.flatMap((p) => [p.outward.x, p.outward.z])],
        ['uLampHeight', '1f', lamp.height],
        ['uLampOutline', '4fv', lamp.outline],
        ['uLampCells[0]', '4fv', lamp.cells],
        ['uLampCellCount', '1i', lamp.cellCount],
        ['uLampColumns[0]', '3fv', lamp.groups],
        ['uLampColumnCount', '1i', lamp.columns],
        ['uLampNorm', '1f', lamp.norm],
        ['uLampSpread', '2fv', lamp.spread],
        ['uLampLuminance', '1f', 6],
        ['uExposure', '1f', 1.12],
        ['uClothAlbedo', '3fv', linearRgb(this.tablePalette().cloth)],
        ['uBalls[0]', '4fv', balls],
        ['uBallTints[0]', '3fv', tints],
        ['uBallCount', '1i', this.ballSlots.size],
        ['uCueTip', '4fv', stick ? [stick.tip.x, stick.tip.y, stick.tip.z, stick.tipRadius] : [0, 0, 0, 0]],
        ['uCueButt', '4fv', stick ? [stick.butt.x, stick.butt.y, stick.butt.z, stick.buttRadius] : [0, 0, 0, -1]],
      ];
      this.frame += 1;
    }

    useMaterial(material) {
      const gl = this.gl, entry = this.programs[material] || this.programs[0];
      if (this.activeProgram !== entry) { gl.useProgram(entry.program); this.activeProgram = entry; }
      if (entry.frame !== this.frame) {
        entry.frame = this.frame;
        this.frameUniforms.forEach(([name, kind, value]) => {
          const location = entry.uniforms[name];
          if (!location) return;
          if (kind === 'mat4') gl.uniformMatrix4fv(location, false, value);
          else if (kind === '1i') gl.uniform1i(location, value);
          else if (kind === '1f') gl.uniform1f(location, value);
          else gl[`uniform${kind}`](location, value);
        });
      }
      return entry.uniforms;
    }

    drawEnvironment(world) {
      const t = world.table;
      const W = t.width, H = t.height, rail = t.railWidth;
      const chinese = t.style === 'chinese';
      const woodTexture = this.getMaterialTexture('wood');
      const metalTexture = this.getMaterialTexture('metal');
      const carpetTexture = this.getMaterialTexture('rubber');
      const floorY = -0.84;
      const apron = world.mode === 'snooker' ? '#1d120b' : '#20130c';

      this.draw('cube', Mat4.translationScale({ x: 0, y: floorY - 0.02, z: 0 }, { x: 12, y: 0.02, z: 12 }), '#20282b', 7, 1, carpetTexture, 2, { x: 96, y: 96 });
      this.gl.depthMask(false);
      this.draw('circle', Mat4.translationScale({ x: 0, y: floorY + 0.004, z: 0 }, { x: W * 0.82, y: 1, z: H * 1.4 }), '#000000', 8, 0.60);
      this.gl.depthMask(true);

      const apronX = W / 2 + rail * 0.82, apronZ = H / 2 + rail * 0.82;
      if (chinese) {
        // Joy Q8 body: one deep mahogany apron framed top and bottom in
        // champagne gold, with a gold post above every leg.
        const apronBottom = -0.215, apronTop = -0.036, apronMid = (apronBottom + apronTop) / 2, apronHalf = (apronTop - apronBottom) / 2;
        this.draw('cube', Mat4.translationScale({ x: 0, y: apronMid, z: 0 }, { x: apronX, y: apronHalf, z: apronZ }), mahoganyApron(this.tablePalette().wood), 2, 1, woodTexture, 2, { x: 7, y: 1.4 });
        [[-0.041, 0.0048], [apronBottom + 0.006, 0.006]].forEach(([y, half]) => {
          [-1, 1].forEach((side) => {
            this.draw('cube', Mat4.translationScale({ x: 0, y, z: side * (apronZ + 0.002) }, { x: apronX + 0.002, y: half, z: 0.0042 }), CHAMPAGNE, 5, 1, metalTexture, 2, { x: 9, y: 1 });
            this.draw('cube', Mat4.translationScale({ x: side * (apronX + 0.002), y, z: 0 }, { x: 0.0042, y: half, z: apronZ + 0.002 }), CHAMPAGNE, 5, 1, metalTexture, 2, { x: 2, y: 7 });
          });
        });
        this.chineseLegs = { apronBottom, apronMid, apronHalf, apronZ };
      } else {
        // Cabinet body below the rails, then a stepped-in lower chassis.
        this.draw('cube', Mat4.translationScale({ x: 0, y: -0.114, z: 0 }, { x: apronX, y: 0.078, z: apronZ }), apron, 2, 1, woodTexture, 2, { x: 7, y: 1.4 });
        this.draw('cube', Mat4.translationScale({ x: 0, y: -0.30, z: 0 }, { x: W / 2 + rail * 0.28, y: 0.115, z: H / 2 + rail * 0.28 }), '#170e08', 2, 1, woodTexture, 2, { x: 6, y: 1.6 });
      }

      // The Joy signature is six faceted golden legs, a pair mid-table
      // carrying the slate, each under a gold post set into the long apron;
      // a 12 ft snooker bed sits on eight.
      const legX = W / 2 - 0.24, legZ = H / 2 - 0.15;
      const columns = chinese ? [-1, 0, 1] : world.mode === 'snooker' ? [-1, -1 / 3, 1 / 3, 1] : [-1, 1];
      columns.forEach((sx) => [-1, 1].forEach((sz) => {
        const x = sx * legX, z = sz * legZ;
        if (chinese) {
          const { apronBottom, apronMid, apronHalf, apronZ } = this.chineseLegs;
          // The leg's widest bulge stays inside the rail's outer edge; its
          // post stands 8 mm proud of the apron face.
          const postZ = sz * (apronZ - 0.075);
          // Posts and legs are champagne lacquer on wood, not bare metal.
          this.draw('cube', Mat4.translationScale({ x, y: apronMid, z: postZ }, { x: 0.072, y: apronHalf + 0.004, z: 0.083 }), CHAMPAGNE, 2);
          // The turned leg is drawn floor-up to the post's underside.
          const height = apronBottom - (floorY - 0.005);
          this.draw('goldenLeg', Mat4.translationScale({ x, y: floorY - 0.005, z: postZ }, { x: 1, y: height / 0.53, z: 1 }), CHAMPAGNE, 2);
          return;
        }
        this.draw('leg', Mat4.translationScale({ x, y: -0.585, z }, { x: 0.078, y: 0.275, z: 0.078 }), '#3a2517', 2, 1, woodTexture, 2, { x: 2, y: 3 });
        this.draw('cylinder', Mat4.translationScale({ x, y: -0.845, z }, { x: 0.070, y: 0.014, z: 0.070 }), '#14100c', 4);
      }));
    }

    tablePalette() {
      return {
        club: { wood: '#513b2b', cloth: '#238960', cushion: '#1d7753' },
        blue: { wood: '#3b3630', cloth: '#328ca0', cushion: '#287788' },
        classic: { wood: '#654631', cloth: '#348448', cushion: '#2a733d' },
      }[this.tableTheme] || { wood: '#513b2b', cloth: '#238960', cushion: '#1d7753' };
    }

    drawTable(world) {
      const t = world.table;
      const W = t.width, H = t.height, rail = t.railWidth;
      const chinese = t.style === 'chinese';
      const snooker = world.mode === 'snooker';
      const { wood, cloth, cushion } = this.tablePalette();
      const cushionTop = t.cushionTopHeight || 0.042;
      const railTop = cushionTop + 0.017;
      const woodInner = 0.056;
      const clothTexture = this.getMaterialTexture('cloth');
      const woodTexture = this.getMaterialTexture('wood');
      const rubberTexture = this.getMaterialTexture('rubber');
      const metalTexture = this.getMaterialTexture('metal');

      // Slate/cloth continues under the mouth returns and pocket irons. A
      // bed ending at the cushion backing leaves see-through shelf wedges
      // in oblique views of the larger, flared opening above the slate cut.
      const clothOverlap = chinese ? rail * 0.75 : 0.045;
      this.draw('cube', Mat4.translationScale({ x: 0, y: -0.023, z: 0 }, { x: W / 2 + clothOverlap, y: 0.023, z: H / 2 + clothOverlap }), cloth, 1, 1, clothTexture, 2, { x: 9, y: 4.5 });

      // Cloth markings: head string + foot spot, or snooker baulk line, D and spots.
      if (snooker) {
        const spots = global.BilliardsPhysics.snookerSpots(t);
        this.draw('cube', Mat4.translationScale({ x: spots.baulk, y: 0.0004, z: 0 }, { x: 0.0009, y: 0.0002, z: H / 2 * 0.995 }), '#e6f2ea', 3, 0.15);
        this.draw('arcLine', Mat4.fromTRS({ x: spots.baulk, y: 0.0006, z: 0 }, yawQuat({ x: -1, z: 0 }), { x: spots.dRadius, y: 1, z: spots.dRadius }), '#e6f2ea', 3, 0.15);
        ['green', 'yellow', 'brown', 'blue', 'pink', 'black'].forEach((id) => {
          const { x, z } = spots[id];
          this.draw('circle', Mat4.translationScale({ x, y: 0.0006, z }, { x: 0.004, y: 1, z: 0.004 }), '#eef6f0', 3, 0.22);
        });
      } else {
        this.draw('cube', Mat4.translationScale({ x: t.cueStart, y: 0.0004, z: 0 }, { x: 0.0009, y: 0.0002, z: H / 2 * 0.995 }), '#dcebe2', 3, 0.12);
        this.draw('circle', Mat4.translationScale({ x: t.rackApex, y: 0.0006, z: 0 }, { x: 0.005, y: 1, z: 0.005 }), '#dfeee5', 3, 0.2);
      }

      // Cushion profile: a recessed base with an overhanging nose whose face
      // sits exactly on the physics contact line, so rebounds match the visual.
      this.cutPockets = false;
      t.cushions.forEach((segment) => {
        if (chinese) {
          this.draw(`cloth-${segment.id}`, Mat4.identity(), cushion, 1, 1, clothTexture, 2, { x: 6, y: 6 });
          return;
        }
        const length = (segment.max - segment.min) / 2;
        const mid = (segment.min + segment.max) / 2;
        const position = segment.axis === 'x' ? { x: mid, y: 0, z: segment.value } : { x: segment.value, y: 0, z: mid };
        const direction = { x: -segment.normal.z, z: segment.normal.x };
        this.draw('cushionProfile', Mat4.fromTRS(position, yawQuat(direction), { x: length, y: 1, z: 1 }), cushion, 1, 1, clothTexture, 2, { x: 6, y: 1 });
      });

      if (!chinese) t.jaws.forEach((jaw) => {
        this.draw('jawProfile', Mat4.translationScale(
          { x: jaw.x, y: 0, z: jaw.z },
          { x: 1, y: 1, z: 1 },
        ), cushion, 1, 1, clothTexture, 2, { x: 2, y: 2 });
      });

      // American-style angled pocket facings: cloth-covered walls whose play
      // face lies exactly on the physics capsule segment.
      (t.facings || []).forEach((facing) => {
        const dx = facing.p1.x - facing.p0.x, dz = facing.p1.z - facing.p0.z;
        const length = Math.hypot(dx, dz);
        const direction = { x: dx / length, z: dz / length };
        const half = 0.0075;
        const mid = {
          x: (facing.p0.x + facing.p1.x) / 2 - facing.normal.x * half,
          y: cushionTop / 2,
          z: (facing.p0.z + facing.p1.z) / 2 - facing.normal.z * half,
        };
        this.draw('cube', Mat4.fromTRS(mid, yawQuat(direction), { x: length / 2, y: cushionTop / 2, z: half }), cushion, 1, 1, clothTexture, 2, { x: 1.5, y: 1 });
      });

      // Chinese rails are six separate wooden caps with real open ends at
      // the pocket irons. Other table styles retain their original caps.
      const woodMid = (woodInner + rail) / 2;
      this.cutPockets = !chinese;
      if (chinese) t.cushions.forEach((segment) => {
        const extension = (end) => segment.axis === 'x' && Math.abs(Math.abs(end) - t.sideGap) < 1e-9
          ? t.sideGap - t.sideMouth * 0.68 : global.BilliardsPhysics.cushionEndExtension(t, false, woodInner, 0.0035);
        const min = segment.min - extension(segment.min), max = segment.max + extension(segment.max);
        const mid = (min + max) / 2;
        const position = segment.axis === 'x' ? { x: mid, y: 0, z: segment.value } : { x: segment.value, y: 0, z: mid };
        const along = yawQuat({ x: -segment.normal.z, z: segment.normal.x });
        this.draw('railProfile', Mat4.fromTRS(position, along, { x: (max - min) / 2, y: 1, z: 1 }), wood, 2, 1, woodTexture, 2, { x: 6, y: 1 });
        // Joy's champagne-gold band down the rail's outer face.
        const band = { x: position.x - segment.normal.x * (rail + 0.0015), y: (railTop - 0.036) / 2 - 0.004, z: position.z - segment.normal.z * (rail + 0.0015) };
        this.draw('cube', Mat4.fromTRS(band, along, { x: (max - min) / 2, y: (railTop + 0.036) / 2 - 0.006, z: 0.0015 }), CHAMPAGNE, 5, 1, metalTexture, 2, { x: 6, y: 1 });
      });
      else [-1, 1].forEach((side) => {
        this.draw('railProfile', Mat4.fromTRS(
          { x: 0, y: 0, z: side * H / 2 }, yawQuat({ x: side, z: 0 }),
          { x: W / 2 + rail, y: 1, z: 1 },
        ), wood, 2, 1, woodTexture, 2, { x: 9, y: 1 });
        this.draw('railProfile', Mat4.fromTRS(
          { x: side * W / 2, y: 0, z: 0 }, yawQuat({ x: 0, z: -side }),
          { x: H / 2 + woodInner, y: 1, z: 1 },
        ), wood, 2, 1, woodTexture, 2, { x: 1, y: 6 });
      });

      // Open slate cuts, a thin cloth-covered bevel and recessed leather
      // boots. Only the rear half has a collar at rail height; the mouth is
      // unobstructed and the exact same ellipse controls physical support.
      this.cutPockets = false;
      t.pockets.forEach((pocket) => {
        const a = pocket.radiusAlong, b = pocket.radiusAcross;
        const spin = yawQuat(pocket.outward);
        const model = (y, height, scale = 1) => Mat4.fromTRS({ x: pocket.x, y, z: pocket.z }, spin, { x: a * scale, y: height, z: b * scale });
        if (chinese) this.draw('pocketLiner', model(-0.004, pocket.depth), '#e9e5da', 9, 1, this.getMaterialTexture('net'), 1, { x: 0.375, y: 1.06 });
        else this.draw('pocketLiner', model(-0.004, pocket.depth), '#141719', 4, 1, rubberTexture, 2);
        this.draw('slateLip', model(0.0001, 0.005), cushion, 1, 1, clothTexture, 2);
        if (chinese) this.draw('circle', model(-pocket.depth + 0.002, 1, 0.89), '#e9e5da', 9, 1, this.getMaterialTexture('net'), 1, { x: 0.45, y: 0.45 });
        else this.draw('circle', model(-pocket.depth + 0.002, 1, 0.89), '#070a0a', 3);
        if (chinese) {
          this.draw(`facing-${pocket.id}`, Mat4.identity(), '#29251e', 4, 1, rubberTexture, 2, { x: 5, y: 5 });
          this.draw(`cheeks-${pocket.id}`, Mat4.identity(), cushion, 1, 1, clothTexture, 2, { x: 6, y: 6 });
          this.draw(`iron-${pocket.id}`, Mat4.identity(), '#a38b60', 5, 1, metalTexture, 2, { x: 4, y: 4 });
        } else {
          this.draw('pocketBack', model(railTop, railTop), '#24211d', 4, 1, rubberTexture, 2);
          this.draw('pocketCollar', model(railTop + 0.0005, 1, 1.16), '#302920', 4, 1, rubberTexture, 2);
          this.draw('pocketTrim', model(railTop + 0.0008, 1, 1.16), '#73604a', 5, 1, metalTexture, 2);
        }
      });

      // Mother-of-pearl sights at every eighth (long) and quarter (short)
      // point.  Only pool tables carry them: Chinese 8-ball (Joy, Xingpai)
      // and snooker rails are plain.
      const sightColor = '#b8c9bf';
      const sightRail = woodMid;
      if (t.style === 'pool') [-3, -2, -1, 1, 2, 3].forEach((k) => {
        const x = W * k / 8;
        [-1, 1].forEach((side) => {
          this.draw('circle', Mat4.translationScale({ x, y: railTop + 0.0008, z: side * (H / 2 + sightRail) }, { x: 0.0062, y: 1, z: 0.0062 }), sightColor, 3, 0.82);
        });
      });
      if (t.style === 'pool') [-1, 0, 1].forEach((k) => {
        const z = H * k / 4;
        [-1, 1].forEach((side) => {
          this.draw('circle', Mat4.translationScale({ x: side * (W / 2 + sightRail), y: railTop + 0.0008, z }, { x: 0.0062, y: 1, z: 0.0062 }), sightColor, 3, 0.82);
        });
      });
      this.cutPockets = true;
    }

    drawBalls(world) {
      for (const ball of world.balls) {
        if (ball.pocketed && (!ball.sinkTarget || ball.sinkDepth >= 0.22)) continue;
        const position = { x: ball.pos.x, y: ball.radius + (ball.posY || 0), z: ball.pos.z };
        const model = Mat4.fromTRS(position, ball.rotation, ball.radius);
        const texture = this.getBallTexture(ball);
        this.selfBall = this.ballSlots.get(ball) ?? -1;
        this.draw('sphere', model, ball.color, 0, 1, texture);
      }
      this.selfBall = -1;
    }

    // Stick pose shared by the mesh and its shadow: the tip face sits just
    // behind the tip-offset contact point, the butt 1.35 m further back.
    cueFrame(world, direction, elevationDegrees, pullback, tipX = 0, tipY = 0) {
      const cue = world.getCueBall();
      if (!cue || cue.pocketed || !direction) return null;
      const spec = world.getCueSpec ? world.getCueSpec() : { shaftRadius: 0.0061, tipDiameter: 0.0115 };
      const elevation = elevationDegrees * Math.PI / 180;
      const c = Math.cos(elevation), s = Math.sin(elevation);
      const f = { x: direction.x * c, y: -s, z: direction.z * c };
      const up = { x: direction.x * s, y: c, z: direction.z * s };
      const side = { x: -direction.z, y: 0, z: direction.x };
      const R = cue.radius;
      // Aim the stick at the actual tip-offset contact point so the selected
      // English/draw is visible on the table, not just in the panel.
      const reach = 0.82 * R;
      const offsetLen = Math.hypot(tipX, tipY) * 0.82;
      const depth = R * Math.sqrt(Math.max(0.2, 1 - offsetLen * offsetLen));
      const contact = {
        x: cue.pos.x + side.x * tipX * reach + up.x * tipY * reach - f.x * depth,
        y: R + up.y * tipY * reach - f.y * depth,
        z: cue.pos.z + side.z * tipX * reach + up.z * tipY * reach - f.z * depth,
      };
      const start = 0.005 + (pullback || 0), length = 1.3485;
      const at = (distance) => ({ x: contact.x - f.x * distance, y: contact.y - f.y * distance, z: contact.z - f.z * distance });
      const tipR = spec.tipDiameter / 2;
      return {
        f, up, side, contact, start, tipR,
        tipSpec: world.getTipSpec ? world.getTipSpec() : { id: 'medium' },
        tip: at(start), butt: at(start + length), tipRadius: tipR, buttRadius: tipR * 2.9,
      };
    }

    drawCue(stick) {
      const { f, up, side, contact, tipR, tipSpec } = stick;
      const woodTexture = this.getMaterialTexture('wood');
      const rubberTexture = this.getMaterialTexture('rubber');
      const metalTexture = this.getMaterialTexture('metal');
      let cursor = stick.start;
      const segment = (length, radius, mesh, color, material, texture, scale) => {
        const centre = cursor + length / 2;
        const m = new Float32Array([
          side.x * radius, side.y * radius, side.z * radius, 0,
          f.x * length / 2, f.y * length / 2, f.z * length / 2, 0,
          up.x * radius, up.y * radius, up.z * radius, 0,
          contact.x - f.x * centre, contact.y - f.y * centre, contact.z - f.z * centre, 1,
        ]);
        this.draw(mesh, m, color, material, 1, texture || null, texture ? 2 : 0, scale || { x: 1, y: 1 });
        cursor += length;
      };
      const tipColor = tipSpec.id === 'soft' ? '#7d5c42' : tipSpec.id === 'hard' ? '#4d3626' : '#6b4c36';
      segment(0.0075, tipR, 'cylinder', tipColor, 4, rubberTexture, { x: 1, y: 1 });
      segment(0.020, tipR * 1.02, 'cylinder', '#f3eee1', 6);
      segment(0.70, tipR * 1.05, 'cueShaft', '#d8ab6d', 6, woodTexture, { x: 4, y: 1 });
      const jointR = tipR * 1.05 * 1.95;
      segment(0.011, jointR * 1.02, 'cylinder', '#c8a45c', 5, metalTexture, { x: 2, y: 1 });
      // A playing cue's butt: ebony forearm, champagne rings, black Irish
      // linen wrap and a rosewood sleeve, one continuous 1.42:1 taper.
      const buttLength = 0.60, taper = 0.42;
      let along = 0;
      [
        [0.25, '#1b120e', 6, woodTexture], [0.006, CHAMPAGNE, 5, metalTexture],
        [0.26, '#151515', 4, rubberTexture], [0.006, CHAMPAGNE, 5, metalTexture],
        [0.078, '#2d1a12', 6, woodTexture],
      ].forEach(([length, color, material, texture]) => {
        const r0 = jointR * (1 + taper * along / buttLength), r1 = jointR * (1 + taper * (along + length) / buttLength);
        segment(length, r0, this.coneMesh(r1 / r0), color, material, texture, { x: 4, y: 1 });
        along += length;
      });
      segment(0.010, jointR * 1.30, 'cylinder', '#191411', 4, rubberTexture, { x: 1, y: 1 });
    }

    // Truncated cones by bottom:top radius ratio, built once each.
    coneMesh(ratio) {
      const key = `cone:${ratio.toFixed(4)}`;
      if (!this.meshes[key]) this.meshes[key] = createMesh(this.gl, cylinderGeometry(20, 1, ratio));
      return key;
    }

    draw(meshName, model, color, material = 0, opacity = 1, texture = null, textureMode = texture ? 1 : 0, textureScale = { x: 1, y: 1 }) {
      const gl = this.gl;
      const mesh = this.meshes[meshName];
      const u = this.useMaterial(material);
      gl.uniformMatrix4fv(u.uModel, false, model);
      gl.uniformMatrix3fv(u.uNormalMatrix, false, normalMatrix(this.normalMatrixScratch, model));
      const rgb = Array.isArray(color) ? color : hexToRgb(color);
      gl.uniform3f(u.uColor, rgb[0], rgb[1], rgb[2]);
      gl.uniform1f(u.uOpacity, opacity);
      gl.uniform1i(u.uTextureMode, textureMode);
      gl.uniform2f(u.uTextureScale, textureScale.x || 1, textureScale.y || 1);
      gl.uniform1i(u.uCutPockets, this.cutPockets ? 1 : 0);
      gl.uniform1i(u.uSelfBall, this.selfBall);
      if (texture) {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, texture);
      }
      gl.bindVertexArray(mesh.vao);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      gl.bindVertexArray(null);
    }

    uploadCanvasTexture(canvas, repeatY = true) {
      const gl = this.gl;
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, repeatY ? gl.REPEAT : gl.CLAMP_TO_EDGE);
      if (this.anisotropy) {
        const maximum = gl.getParameter(this.anisotropy.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, maximum));
      }
      return texture;
    }

    getMaterialTexture(kind) {
      const key = `material:${kind}`;
      if (this.textures.has(key)) return this.textures.get(key);
      const texture = this.uploadCanvasTexture(materialCanvas(kind), true);
      this.textures.set(key, texture);
      return texture;
    }

    setBallStyle(style) {
      this.ballStyle = style === 'palladium' ? 'palladium' : 'tv';
    }

    // The Palladium "rotor": three circular lobes (radius ρ, centres peak−ρ
    // from the figure centre at bearings 0°/120°/240°) joined by long concave
    // side arcs that meet the lobes tangentially and bottom out at the valley
    // radius.  The side-arc radius follows from the tangency condition; the
    // profile is the min of the ray's lobe exit and side-arc entry.  Laid
    // onto the equirect texture with the spherical destination-point formula
    // so it renders round on the ball instead of inheriting the map's polar
    // stretch.  bearingDeg turns the figure about its centre: 0 puts the apex
    // lobe toward north, 90 toward increasing longitude.
    traceSphericalRotor(ctx, lonDeg, latDeg, peakDeg, valleyDeg, lobeDeg, bearingDeg = 0) {
      const W = 512, H = 256;
      const lat0 = latDeg * Math.PI / 180;
      const rho = lobeDeg, d = peakDeg - lobeDeg, V = valleyDeg;
      const rhoS = (d * d + V * V - d * V - rho * rho) / (2 * rho + d - 2 * V);
      const D = V + rhoS;
      // Tangency point between lobe circle and side arc fixes the switchover
      // bearing: P = C_lobe + rho·(C_side − C_lobe)/|C_side − C_lobe|.
      const csx = D * Math.sin(Math.PI / 3), csy = D * Math.cos(Math.PI / 3);
      const gap = Math.hypot(csx, csy - d);
      const px = rho * csx / gap, py = d + rho * (csy - d) / gap;
      const deltaT = Math.atan2(px, py);
      ctx.beginPath();
      for (let i = 0; i <= 144; i += 1) {
        const alpha = i / 144 * Math.PI * 2;
        let delta = alpha % (Math.PI * 2 / 3);
        if (delta > Math.PI / 3) delta = Math.PI * 2 / 3 - delta;
        const sinD = Math.sin(delta), cosD = Math.cos(delta);
        let betaDeg;
        if (delta <= deltaT) {
          betaDeg = d * cosD + Math.sqrt(Math.max(0, rho * rho - d * d * sinD * sinD));
        } else {
          const gamma = Math.PI / 3 - delta;
          const discS = D * D * Math.cos(gamma) * Math.cos(gamma) - D * D + rhoS * rhoS;
          betaDeg = D * Math.cos(gamma) - Math.sqrt(Math.max(0, discS));
        }
        const beta = betaDeg * Math.PI / 180;
        const direction = alpha + bearingDeg * Math.PI / 180;
        const sinLat = Math.sin(lat0) * Math.cos(beta) + Math.cos(lat0) * Math.sin(beta) * Math.cos(direction);
        const dlon = Math.atan2(
          Math.sin(direction) * Math.sin(beta) * Math.cos(lat0),
          Math.cos(beta) - Math.sin(lat0) * sinLat,
        );
        const x = (lonDeg + dlon * 180 / Math.PI) / 360 * W;
        const y = (90 - Math.asin(Math.max(-1, Math.min(1, sinLat))) * 180 / Math.PI) / 180 * H;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
    }

    // Dynaspheres Palladium-inspired look, checked against the manufacturer's
    // set photography and its rotor logo.  The badge is the logo itself: three
    // equal round lobes (radius ≈ 0.3 of the peak) joined by deep concave
    // sides whose valleys sit at ≈ 0.45 of the peak, a 41° peak angular
    // radius, and a fine ink contour around small bold numbers.  On
    // the stripes the ivory band runs along the number's vertical axis: the
    // colour caps (from ±43° latitude) sit to the left and right of the
    // badge, not above and below it.  The 8 carries the same badge as an
    // ivory outline; the cue ball has six ink rotor marks.
    paintPalladiumBall(ctx, ball) {
      const W = 512, H = 256;
      const ivory = '#f2e9d2', badgeFill = '#efe7cd', ink = '#1a181b';
      const eight = ball.number === 8;
      if (ball.kind === 'cue') {
        ctx.fillStyle = ivory;
        ctx.fillRect(0, 0, W, H);
        // Six marks on octahedral points (two staggered triangles at ±35°
        // latitude), so a spin reads from any side: the same rotor logo as the
        // badges, about 0.35R across, as on the set's cue balls.
        ctx.fillStyle = ink;
        [[0, 35], [120, 35], [240, 35], [60, -35], [180, -35], [300, -35]].forEach(([lon, lat]) => {
          for (const wrap of lon === 0 ? [0, 360] : [0]) { // seam copy at longitude 0
            this.traceSphericalRotor(ctx, lon + wrap, lat, 10.5, 4.7, 3.2);
            ctx.fill();
          }
        });
        return;
      }
      const stripe = ball.kind === 'stripe';
      ctx.fillStyle = stripe ? ivory : ball.color;
      ctx.fillRect(0, 0, W, H);
      if (stripe) {
        // Colour caps start at ±43° latitude (their face-on boundary sits at
        // ~0.68R) and meet the ivory band directly — no painted ring.
        ctx.fillStyle = ball.color;
        ctx.fillRect(0, 0, W, 67);
        ctx.fillRect(0, 189, W, H - 189);
      }
      // A stripe's number stands along its band (apex toward increasing
      // longitude); a solid has no band, so its badge keeps the default.
      const bearing = stripe ? 90 : 0;
      [90, 270].forEach((lonDeg) => {
        const cx = lonDeg / 360 * W, cy = H / 2;
        this.traceSphericalRotor(ctx, lonDeg, 0, 41, 18.5, 12.3, bearing);
        if (!eight) { ctx.fillStyle = badgeFill; ctx.fill(); }
        ctx.strokeStyle = eight ? ivory : ink;
        ctx.lineWidth = 5;
        ctx.lineJoin = 'round';
        ctx.stroke();
        if (ball.number == null) return;
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(bearing * Math.PI / 180);
        ctx.translate(0, -7); // the numeral sits a little toward the apex
        ctx.fillStyle = eight ? ivory : ink;
        ctx.font = '700 31px "Myriad Pro", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(String(ball.number), 0, 0);
        // The 6 and 9 carry the set's short orientation dash.
        if (ball.number === 6 || ball.number === 9) {
          ctx.strokeStyle = ink;
          ctx.lineWidth = 3.5;
          ctx.lineCap = 'round';
          ctx.beginPath();
          ctx.moveTo(-7, 17);
          ctx.lineTo(7, 17);
          ctx.stroke();
        }
        ctx.restore();
      });
    }

    getBallTexture(ball) {
      // The painted texture depends only on style/kind/number/colour, so
      // numberless balls (snooker's fifteen reds) all share one cached texture.
      const key = `${this.ballStyle}:${ball.kind}:${ball.number ?? ''}:${ball.color}`;
      if (this.textures.has(key)) return this.textures.get(key);
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 256;
      const ctx = canvas.getContext('2d');
      if (this.ballStyle === 'palladium' && (ball.kind === 'cue' || ball.kind === 'solid' || ball.kind === 'stripe')) {
        this.paintPalladiumBall(ctx, ball);
        const texture = this.uploadCanvasTexture(canvas, false);
        this.textures.set(key, texture);
        return texture;
      }
      const white = '#f8f7ef';
      ctx.fillStyle = ball.kind === 'stripe' || ball.kind === 'cue' ? white : ball.color;
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      if (ball.kind === 'stripe') {
        ctx.fillStyle = ball.color;
        ctx.fillRect(0, 90, canvas.width, 76);
      }
      if (ball.kind === 'cue') {
        ctx.fillStyle = '#b63f38';
        [[0,128],[128,128],[256,128],[384,128],[512,128]].forEach(([x,y]) => {
          ctx.beginPath(); ctx.arc(x, y, 11, 0, Math.PI * 2); ctx.fill();
        });
        // The two polar measle dots are spherical caps, represented as narrow
        // full-width bands in an equirectangular texture.
        ctx.fillRect(0, 0, canvas.width, 8);
        ctx.fillRect(0, canvas.height - 8, canvas.width, 8);
      } else if (ball.number != null) {
        [128, 384].forEach((x) => {
          ctx.fillStyle = white;
          ctx.beginPath(); ctx.arc(x, 128, 36, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#111614';
          ctx.font = '700 36px Arial, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText(String(ball.number), x, 130);
        });
      }
      const texture = this.uploadCanvasTexture(canvas, false);
      this.textures.set(key, texture);
      return texture;
    }

    project(point) {
      const clip = Mat4.transformVec4(this.viewProjection, [point.x, point.y || 0, point.z, 1]);
      if (Math.abs(clip[3]) < 1e-8) return null;
      const nx = clip[0] / clip[3], ny = clip[1] / clip[3], nz = clip[2] / clip[3];
      return { x: (nx * 0.5 + 0.5) * this.cssWidth, y: (1 - (ny * 0.5 + 0.5)) * this.cssHeight, depth: nz, visible: nz >= -1 && nz <= 1 };
    }

    screenToTable(clientX, clientY, height = 0) {
      const rect = this.canvas.getBoundingClientRect();
      const nx = (clientX - rect.left) / rect.width * 2 - 1;
      const ny = 1 - (clientY - rect.top) / rect.height * 2;
      const inverse = Mat4.invert(this.viewProjection);
      if (!inverse) return null;
      const near4 = Mat4.transformVec4(inverse, [nx, ny, -1, 1]);
      const far4 = Mat4.transformVec4(inverse, [nx, ny, 1, 1]);
      const near = { x: near4[0] / near4[3], y: near4[1] / near4[3], z: near4[2] / near4[3] };
      const far = { x: far4[0] / far4[3], y: far4[1] / far4[3], z: far4[2] / far4[3] };
      const dy = far.y - near.y;
      if (Math.abs(dy) < 1e-8) return null;
      const t = (height - near.y) / dy;
      return { x: near.x + (far.x - near.x) * t, z: near.z + (far.z - near.z) * t };
    }

    ballScreenRadius(ball) {
      const centre = this.project({ x: ball.pos.x, y: ball.radius, z: ball.pos.z });
      const edge = this.project({ x: ball.pos.x + ball.radius, y: ball.radius, z: ball.pos.z });
      return centre && edge ? Math.hypot(edge.x - centre.x, edge.y - centre.y) : 8;
    }
  }

  global.BilliardsRenderer = {
    BilliardsRenderer,
    geometry: { cubeGeometry, sphereGeometry, circleGeometry, cylinderGeometry, sectorGeometry, prismGeometry, pocketLinerGeometry, jawGeometry, latheGeometry, chineseCushionGeometry, chinesePocketGeometry },
  };
})(window);
