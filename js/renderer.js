(function (global) {
  'use strict';

  const { Mat4, clamp, hexToRgb } = global.BilliardsMath;

  const VERTEX_SHADER = `#version 300 es
    precision highp float;
    in vec3 aPosition;
    in vec3 aNormal;
    in vec2 aUV;
    uniform mat4 uModel;
    uniform mat4 uViewProjection;
    out vec3 vWorldPosition;
    out vec3 vNormal;
    out vec2 vUV;
    void main() {
      vec4 world = uModel * vec4(aPosition, 1.0);
      vWorldPosition = world.xyz;
      // Every current primitive is either uniformly scaled (balls), has
      // axis-aligned face normals (boxes), or equal radial X/Z scale
      // (cylinders).  Normalizing the model-space transform is therefore exact
      // here and avoids an inverse matrix for every vertex.
      vNormal = normalize(mat3(uModel) * aNormal);
      vUV = aUV;
      gl_Position = uViewProjection * world;
    }
  `;

  const FRAGMENT_SHADER = `#version 300 es
    precision highp float;
    in vec3 vWorldPosition;
    in vec3 vNormal;
    in vec2 vUV;
    uniform vec3 uColor;
    uniform vec3 uCameraPosition;
    uniform sampler2D uTexture;
    uniform int uTextureMode;
    uniform vec2 uTextureScale;
    uniform vec2 uTableHalfSize;
    uniform int uMaterial;
    uniform float uOpacity;
    out vec4 outColor;

    float hash(vec2 p) {
      p = fract(p * vec2(123.34, 345.45));
      p += dot(p, p + 34.345);
      return fract(p.x * p.y);
    }

    void main() {
      vec3 texel = uTextureMode > 0 ? texture(uTexture, vUV * uTextureScale).rgb : vec3(1.0);
      vec3 base = uTextureMode == 1 ? texel : uColor;
      if (uTextureMode == 2) {
        // Material maps are neutral albedo modulation maps. Keeping the table
        // tint in uColor makes the same offline texture useful across modes.
        base *= mix(vec3(1.0), texel * 1.34, 0.58);
      }
      vec3 n = normalize(vNormal);
      vec3 lightDir = normalize(vec3(-0.42, 0.86, 0.30));
      vec3 overheadDir = normalize(vec3(0.08, 0.985, -0.15));
      vec3 fillDir = normalize(vec3(0.72, 0.48, -0.38));
      vec3 viewDir = normalize(uCameraPosition - vWorldPosition);
      float keyLight = max(dot(n, lightDir), 0.0);
      float overheadLight = max(dot(n, overheadDir), 0.0);
      float fillLight = max(dot(n, fillDir), 0.0);
      float hemisphere = mix(0.15, 0.31, clamp(n.y * 0.5 + 0.5, 0.0, 1.0));
      float diffuse = keyLight * 0.48 + overheadLight * 0.25 + fillLight * 0.13;
      float specular = 0.0;
      float rim = 0.0;
      if (uMaterial == 0) {
        hemisphere += 0.20;
        diffuse += 0.060;
        vec3 halfDir = normalize(lightDir + viewDir);
        vec3 overheadHalf = normalize(overheadDir + viewDir);
        vec3 fillHalf = normalize(fillDir + viewDir);
        specular = pow(max(dot(n, halfDir), 0.0), 112.0) * 0.56;
        specular += pow(max(dot(n, overheadHalf), 0.0), 150.0) * 0.68;
        specular += pow(max(dot(n, overheadHalf), 0.0), 22.0) * 0.16;
        specular += pow(max(dot(n, fillHalf), 0.0), 36.0) * 0.08;
        vec3 reflected = reflect(-viewDir, n);
        if (reflected.y > 0.05) {
          vec2 reflectedSlope = reflected.xz / reflected.y;
          vec2 panelSlope = overheadDir.xz / overheadDir.y;
          vec2 panelDelta = abs(reflectedSlope - panelSlope);
          float softPanelReflection = (1.0 - smoothstep(0.085, 0.285, panelDelta.x))
            * (1.0 - smoothstep(0.040, 0.155, panelDelta.y));
          float panelReflection = (1.0 - smoothstep(0.045, 0.145, panelDelta.x))
            * (1.0 - smoothstep(0.022, 0.072, panelDelta.y));
          vec2 fillPanelSlope = lightDir.xz / lightDir.y;
          vec2 fillPanelDelta = abs(reflectedSlope - fillPanelSlope);
          float fillPanelSoft = (1.0 - smoothstep(0.070, 0.235, fillPanelDelta.x))
            * (1.0 - smoothstep(0.035, 0.125, fillPanelDelta.y));
          float fillPanelCore = (1.0 - smoothstep(0.035, 0.105, fillPanelDelta.x))
            * (1.0 - smoothstep(0.018, 0.058, fillPanelDelta.y));
          specular += softPanelReflection * 0.14 + panelReflection * 0.31;
          specular += fillPanelSoft * 0.075 + fillPanelCore * 0.16;
        }
        float fresnel = pow(1.0 - max(dot(n, viewDir), 0.0), 5.0);
        rim = fresnel * 0.082;
      } else if (uMaterial == 1) {
        float fibre = sin(vWorldPosition.x * 145.0 + vWorldPosition.z * 13.0) * 0.0045;
        base *= 1.0 + fibre;
        float edgeDistance = min(uTableHalfSize.x - abs(vWorldPosition.x), uTableHalfSize.y - abs(vWorldPosition.z));
        float railOcclusion = smoothstep(-0.008, 0.105, edgeDistance);
        base *= mix(0.76, 1.0, railOcclusion);
        // The light boxes pool their light toward the centre of the cloth.
        vec2 q = vWorldPosition.xz / uTableHalfSize;
        base *= 1.0 - 0.13 * smoothstep(0.42, 1.4, length(q));
        diffuse *= 0.74;
        specular = pow(max(dot(n, normalize(overheadDir + viewDir)), 0.0), 24.0) * 0.025;
      } else if (uMaterial == 2) {
        float grain = sin(vWorldPosition.x * 69.0 + sin(vWorldPosition.z * 37.0) * 1.7) * 0.018;
        base *= 1.0 + grain;
        specular = pow(max(dot(n, normalize(lightDir + viewDir)), 0.0), 34.0) * 0.14;
        specular += pow(max(dot(n, normalize(overheadDir + viewDir)), 0.0), 54.0) * 0.09;
      } else if (uMaterial == 3) {
        outColor = vec4(base, uOpacity);
        return;
      } else if (uMaterial == 4) {
        diffuse *= 0.60;
        specular = pow(max(dot(n, normalize(overheadDir + viewDir)), 0.0), 48.0) * 0.045;
      } else if (uMaterial == 5) {
        diffuse *= 0.34;
        specular = pow(max(dot(n, normalize(lightDir + viewDir)), 0.0), 118.0) * 0.62;
        specular += pow(max(dot(n, normalize(overheadDir + viewDir)), 0.0), 180.0) * 0.78;
        specular += pow(max(dot(n, normalize(fillDir + viewDir)), 0.0), 72.0) * 0.16;
        rim = pow(1.0 - max(dot(n, viewDir), 0.0), 3.0) * 0.12;
      } else if (uMaterial == 6) {
        // Satin cue lacquer: lifted ambient so side-facing cylinders stay warm
        // under a mostly-overhead lighting rig.
        hemisphere += 0.26;
        diffuse = diffuse * 0.9 + 0.11;
        float lacquer = sin(vWorldPosition.x * 210.0 + vWorldPosition.z * 170.0) * 0.012;
        base *= 1.0 + lacquer;
        specular = pow(max(dot(n, normalize(overheadDir + viewDir)), 0.0), 64.0) * 0.34;
        specular += pow(max(dot(n, normalize(lightDir + viewDir)), 0.0), 26.0) * 0.10;
      }
      vec3 lit = base * (hemisphere + diffuse) + vec3(specular) + base * rim;
      float vignette = 1.0 - clamp(length(vWorldPosition.xz) * 0.008, 0.0, 0.08);
      // A gentle highlight shoulder keeps the overhead fixtures and gold trim
      // bright without hard RGB clipping.
      lit = lit / (vec3(1.0) + max(lit - vec3(0.82), vec3(0.0)) * 0.42);
      outColor = vec4(lit * vignette, uOpacity);
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
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL link error: ${gl.getProgramInfoLog(program)}`);
    return program;
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
    const seed = { cloth: 11, wood: 23, rubber: 37, metal: 53 }[kind] || 7;
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
        }
        value = Math.max(78, Math.min(244, Math.round(value)));
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

  class BilliardsRenderer {
    constructor(canvas) {
      this.canvas = canvas;
      this.gl = canvas.getContext('webgl2', { antialias: true, alpha: false, depth: true, powerPreference: 'high-performance' });
      if (!this.gl) throw new Error('WebGL 2 unavailable');
      const gl = this.gl;
      this.program = createProgram(gl, VERTEX_SHADER, FRAGMENT_SHADER);
      gl.useProgram(this.program);
      gl.bindAttribLocation(this.program, 0, 'aPosition');
      gl.bindAttribLocation(this.program, 1, 'aNormal');
      gl.bindAttribLocation(this.program, 2, 'aUV');
      // Re-link after deterministic attribute bindings.
      gl.linkProgram(this.program);
      this.uniforms = {};
      ['uModel', 'uViewProjection', 'uColor', 'uCameraPosition', 'uTexture', 'uTextureMode', 'uTextureScale', 'uTableHalfSize', 'uMaterial', 'uOpacity'].forEach((name) => {
        this.uniforms[name] = gl.getUniformLocation(this.program, name);
      });
      this.meshes = {
        cube: createMesh(gl, cubeGeometry()),
        sphere: createMesh(gl, sphereGeometry(30, 44)),
        circle: createMesh(gl, circleGeometry()),
        cylinder: createMesh(gl, cylinderGeometry()),
        cueShaft: createMesh(gl, cylinderGeometry(24, 1, 1.95)),
        cueButt: createMesh(gl, cylinderGeometry(20, 1, 1.42)),
        leg: createMesh(gl, cylinderGeometry(22, 1, 0.80)),
        cornerHole: createMesh(gl, sectorGeometry(40, Math.PI * 1.48)),
        sideHole: createMesh(gl, sectorGeometry(32, Math.PI * 1.06)),
        cornerPlate: createMesh(gl, sectorGeometry(40, Math.PI * 1.48, 0.74)),
        sidePlate: createMesh(gl, sectorGeometry(32, Math.PI * 1.06, 0.74)),
        arcLine: createMesh(gl, sectorGeometry(48, Math.PI, 0.9925)),
      };
      this.textures = new Map();
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
      this.resolutionScale = this.softwareRenderer ? 0.65 : 1;
      this.cameraMode = 'perspective';
      this.zoom = 1;
      this.viewProjection = Mat4.identity();
      this.cameraPosition = { x: 0, y: 2.2, z: 2.1 };
      this.table = null;
      this.cssWidth = 1;
      this.cssHeight = 1;
      this.devicePixelRatio = 1;
      gl.enable(gl.DEPTH_TEST);
      gl.depthFunc(gl.LEQUAL);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0.025, 0.065, 0.052, 1);
    }

    setTable(table) {
      this.table = table;
      this.zoom = 1;
      this.updateCamera();
    }

    toggleCamera() {
      this.cameraMode = this.cameraMode === 'perspective' ? 'top' : 'perspective';
      this.updateCamera();
      return this.cameraMode;
    }

    setZoom(delta) {
      this.zoom = clamp(this.zoom * delta, 0.72, 1.55);
      this.updateCamera();
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
        const halfX = this.table.width * 0.63 * this.zoom;
        const halfZ = Math.max(this.table.height * 0.74, halfX / aspect) * this.zoom;
        const widthFromHeight = halfZ * aspect;
        const finalHalfX = Math.max(halfX, widthFromHeight);
        projection = Mat4.ortho(-finalHalfX, finalHalfX, -halfZ, halfZ, 0.1, 12);
        this.cameraPosition = { x: 0, y: 5.5, z: 0.001 };
        view = Mat4.lookAt(this.cameraPosition, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 });
      } else {
        const tableScale = this.table.width;
        // Wider stages sit closer to the broadcast angle; narrow ones back off
        // so the full table always fits.
        const fit = clamp(2.55 / Math.max(aspect, 0.8), 1, 1.9);
        this.cameraPosition = {
          x: -tableScale * 0.02,
          y: tableScale * 0.70 * fit * this.zoom,
          z: tableScale * 0.83 * fit * this.zoom,
        };
        projection = Mat4.perspective(36 * Math.PI / 180, aspect, 0.05, 15);
        view = Mat4.lookAt(this.cameraPosition, { x: 0, y: -0.02, z: tableScale * 0.075 }, { x: 0, y: 1, z: 0 });
      }
      this.viewProjection = Mat4.multiply(projection, view);
    }

    render(world, options = {}) {
      this.resize();
      if (this.table !== world.table) { this.table = world.table; this.updateCamera(); }
      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.uniformMatrix4fv(this.uniforms.uViewProjection, false, this.viewProjection);
      gl.uniform3f(this.uniforms.uCameraPosition, this.cameraPosition.x, this.cameraPosition.y, this.cameraPosition.z);
      gl.uniform1i(this.uniforms.uTexture, 0);
      gl.uniform2f(this.uniforms.uTableHalfSize, world.table.width / 2, world.table.height / 2);

      this.drawEnvironment(world);
      this.drawTable(world);
      this.drawShadows(world);
      this.drawBalls(world);
      if (options.showCue) {
        this.drawCue(world, options.aimDirection, options.elevation || 0, options.pullback || 0, options.tipX || 0, options.tipY || 0);
      }
    }

    drawEnvironment(world) {
      const t = world.table;
      const W = t.width, H = t.height, rail = t.railWidth;
      const chinese = t.style === 'chinese';
      const woodTexture = this.getMaterialTexture('wood');
      const metalTexture = this.getMaterialTexture('metal');
      const carpetTexture = this.getMaterialTexture('rubber');
      const floorY = -0.84;
      const apron = chinese ? '#241610' : world.mode === 'snooker' ? '#1d120b' : '#20130c';
      const gold = '#a8834b';

      this.draw('cube', Mat4.translationScale({ x: 0, y: floorY - 0.02, z: 0 }, { x: W * 1.85, y: 0.02, z: W * 1.05 }), '#101214', 4, 1, carpetTexture, 2, { x: 16, y: 10 });
      this.gl.depthMask(false);
      this.draw('circle', Mat4.translationScale({ x: 0, y: floorY + 0.004, z: 0 }, { x: W * 0.80, y: 1, z: H * 1.10 }), '#000000', 3, 0.26);
      this.draw('circle', Mat4.translationScale({ x: 0, y: floorY + 0.0048, z: 0 }, { x: W * 0.58, y: 1, z: H * 0.78 }), '#000000', 3, 0.26);
      this.gl.depthMask(true);

      // Cabinet body below the rails, then a stepped-in lower chassis.
      this.draw('cube', Mat4.translationScale({ x: 0, y: -0.114, z: 0 }, { x: W / 2 + rail * 0.82, y: 0.078, z: H / 2 + rail * 0.82 }), apron, 2, 1, woodTexture, 2, { x: 7, y: 1.4 });
      this.draw('cube', Mat4.translationScale({ x: 0, y: -0.30, z: 0 }, { x: W / 2 + rail * 0.28, y: 0.115, z: H / 2 + rail * 0.28 }), '#170e08', 2, 1, woodTexture, 2, { x: 6, y: 1.6 });
      if (chinese) {
        const trimX = W / 2 + rail * 0.82, trimZ = H / 2 + rail * 0.82;
        this.draw('cube', Mat4.translationScale({ x: 0, y: -0.041, z: trimZ }, { x: trimX + 0.004, y: 0.0048, z: 0.0042 }), gold, 5, 1, metalTexture, 2, { x: 9, y: 1 });
        this.draw('cube', Mat4.translationScale({ x: 0, y: -0.041, z: -trimZ }, { x: trimX + 0.004, y: 0.0048, z: 0.0042 }), gold, 5, 1, metalTexture, 2, { x: 9, y: 1 });
        this.draw('cube', Mat4.translationScale({ x: trimX, y: -0.041, z: 0 }, { x: 0.0042, y: 0.0048, z: trimZ + 0.004 }), gold, 5, 1, metalTexture, 2, { x: 2, y: 7 });
        this.draw('cube', Mat4.translationScale({ x: -trimX, y: -0.041, z: 0 }, { x: 0.0042, y: 0.0048, z: trimZ + 0.004 }), gold, 5, 1, metalTexture, 2, { x: 2, y: 7 });
      }

      // The Joy signature: tapered golden legs near the corners.
      const legColor = chinese ? '#9c7a40' : '#3a2517';
      const legX = W / 2 - 0.24, legZ = H / 2 - 0.15;
      [-1, 1].forEach((sx) => [-1, 1].forEach((sz) => {
        const x = sx * legX, z = sz * legZ;
        this.draw('leg', Mat4.translationScale({ x, y: -0.585, z }, { x: 0.078, y: 0.275, z: 0.078 }), legColor, chinese ? 5 : 2, 1, chinese ? metalTexture : woodTexture, 2, { x: 2, y: 3 });
        this.draw('cylinder', Mat4.translationScale({ x, y: -0.845, z }, { x: 0.070, y: 0.014, z: 0.070 }), '#14100c', 4);
      }));
    }

    drawTable(world) {
      const t = world.table;
      const W = t.width, H = t.height, rail = t.railWidth;
      const chinese = t.style === 'chinese';
      const snooker = world.mode === 'snooker';
      const wood = snooker ? '#452a18' : chinese ? '#5a3a21' : '#4f2e1b';
      const cloth = snooker ? '#1d7f4c' : chinese ? '#177a4e' : '#12775a';
      const cushion = snooker ? '#186f42' : chinese ? '#136b45' : '#0e684d';
      const plateColor = snooker ? '#2b1d13' : chinese ? '#9c7d49' : '#231910';
      const cushionTop = t.cushionTopHeight || 0.042;
      const railTop = cushionTop + 0.017;
      const railBottom = -0.036;
      const woodInner = 0.056;
      const clothTexture = this.getMaterialTexture('cloth');
      const woodTexture = this.getMaterialTexture('wood');
      const rubberTexture = this.getMaterialTexture('rubber');
      const metalTexture = this.getMaterialTexture('metal');

      // Cloth bed extends slightly under the cushions so no seams show.
      this.draw('cube', Mat4.translationScale({ x: 0, y: -0.023, z: 0 }, { x: W / 2 + 0.045, y: 0.023, z: H / 2 + 0.045 }), cloth, 1, 1, clothTexture, 2, { x: 9, y: 4.5 });

      // Cloth markings: head string + foot spot, or snooker baulk line, D and spots.
      if (snooker) {
        const baulkX = -0.89;
        this.draw('cube', Mat4.translationScale({ x: baulkX, y: 0.0004, z: 0 }, { x: 0.0009, y: 0.0002, z: H / 2 * 0.995 }), '#e6f2ea', 3, 0.15);
        this.draw('arcLine', Mat4.fromTRS({ x: baulkX, y: 0.0006, z: 0 }, yawQuat({ x: -1, z: 0 }), { x: 0.292, y: 1, z: 0.292 }), '#e6f2ea', 3, 0.15);
        [[-0.89, -0.292], [-0.89, 0.292], [-0.89, 0], [0, 0], [0.89, 0], [1.43, 0]].forEach(([x, z]) => {
          this.draw('circle', Mat4.translationScale({ x, y: 0.0006, z }, { x: 0.004, y: 1, z: 0.004 }), '#eef6f0', 3, 0.22);
        });
      } else {
        this.draw('cube', Mat4.translationScale({ x: t.cueStart, y: 0.0004, z: 0 }, { x: 0.0009, y: 0.0002, z: H / 2 * 0.995 }), '#dcebe2', 3, 0.12);
        this.draw('circle', Mat4.translationScale({ x: t.rackApex, y: 0.0006, z: 0 }, { x: 0.005, y: 1, z: 0.005 }), '#dfeee5', 3, 0.2);
      }

      // Cushion profile: a recessed base with an overhanging nose whose face
      // sits exactly on the physics contact line, so rebounds match the visual.
      t.cushions.forEach((segment) => {
        const length = (segment.max - segment.min) / 2;
        const mid = (segment.min + segment.max) / 2;
        const noseY = (cushionTop + 0.019) / 2, noseHalf = (cushionTop - 0.019) / 2;
        const at = (offset, y, halfY, halfDepth) => (segment.axis === 'x'
          ? [{ x: mid, y, z: segment.value - segment.normal.z * offset }, { x: length, y: halfY, z: halfDepth }]
          : [{ x: segment.value - segment.normal.x * offset, y, z: mid }, { x: halfDepth, y: halfY, z: length }]);
        const texScale = segment.axis === 'x' ? { x: 6, y: 1 } : { x: 1, y: 6 };
        const [nosePos, noseScale] = at(0.030, noseY, noseHalf, 0.030);
        const [basePos, baseScale] = at(0.034, 0.0115, 0.0115, 0.028);
        this.draw('cube', Mat4.translationScale(nosePos, noseScale), cushion, 1, 1, clothTexture, 2, texScale);
        this.draw('cube', Mat4.translationScale(basePos, baseScale), cushion, 1, 1, clothTexture, 2, texScale);
      });

      t.jaws.forEach((jaw) => {
        this.draw('cylinder', Mat4.translationScale(
          { x: jaw.x, y: cushionTop / 2, z: jaw.z },
          { x: jaw.radius, y: cushionTop / 2, z: jaw.radius },
        ), cushion, 1, 1, clothTexture, 2, { x: 2, y: 2 });
      });

      // Rail caps: long caps run the full width and own the corners; the short
      // caps butt against them so no coplanar top faces overlap.
      const woodY = (railTop + railBottom) / 2, woodHalfY = (railTop - railBottom) / 2;
      const woodMid = (woodInner + rail) / 2, woodHalf = (rail - woodInner) / 2;
      [-1, 1].forEach((side) => {
        this.draw('cube', Mat4.translationScale(
          { x: 0, y: woodY, z: side * (H / 2 + woodMid) },
          { x: W / 2 + rail, y: woodHalfY, z: woodHalf },
        ), wood, 2, 1, woodTexture, 2, { x: 9, y: 1 });
        this.draw('cube', Mat4.translationScale(
          { x: side * (W / 2 + woodMid), y: woodY, z: 0 },
          { x: woodHalf, y: woodHalfY, z: H / 2 + woodInner },
        ), wood, 2, 1, woodTexture, 2, { x: 1, y: 6 });
      });

      // Pockets: a dark shaft below the slate, then a plate and open hole set
      // into the rail caps.  Sectors face outward so nothing floats over cloth.
      t.pockets.forEach((pocket) => {
        const corner = pocket.type === 'corner';
        const holeR = t.pocketRadius * (corner ? 1.10 : 1.02);
        const plateR = holeR * 1.32;
        const spin = yawQuat(pocket.outward);
        this.draw('cylinder', Mat4.translationScale(
          { x: pocket.x, y: -0.053, z: pocket.z },
          { x: holeR * 0.98, y: 0.049, z: holeR * 0.98 },
        ), '#070404', 4);
        this.draw(corner ? 'cornerPlate' : 'sidePlate', Mat4.fromTRS(
          { x: pocket.x, y: railTop + 0.0012, z: pocket.z }, spin, { x: plateR, y: 1, z: plateR },
        ), plateColor, chinese ? 5 : 4, 1, chinese ? metalTexture : rubberTexture, 2, { x: 2, y: 2 });
        this.draw(corner ? 'cornerHole' : 'sideHole', Mat4.fromTRS(
          { x: pocket.x, y: railTop + 0.0022, z: pocket.z }, spin, { x: holeR, y: 1, z: holeR },
        ), '#040302', 3, 0.985);
      });

      // Mother-of-pearl sights at every eighth (long) and quarter (short) point.
      const sightColor = chinese ? '#cfc4a4' : '#b8c9bf';
      const sightRail = woodMid;
      [-3, -2, -1, 1, 2, 3].forEach((k) => {
        const x = W * k / 8;
        [-1, 1].forEach((side) => {
          this.draw('circle', Mat4.translationScale({ x, y: railTop + 0.0008, z: side * (H / 2 + sightRail) }, { x: 0.0062, y: 1, z: 0.0062 }), sightColor, 3, 0.82);
        });
      });
      [-1, 0, 1].forEach((k) => {
        const z = H * k / 4;
        [-1, 1].forEach((side) => {
          this.draw('circle', Mat4.translationScale({ x: side * (W / 2 + sightRail), y: railTop + 0.0008, z }, { x: 0.0062, y: 1, z: 0.0062 }), sightColor, 3, 0.82);
        });
      });
    }

    drawShadows(world) {
      this.gl.depthMask(false);
      for (const ball of world.balls) {
        if (ball.pocketed && ball.sinkTime > 0.24) continue;
        const fade = ball.pocketed ? Math.max(0, 1 - ball.sinkTime / 0.24) : 1;
        const radius = ball.radius;
        this.draw('circle', Mat4.translationScale({ x: ball.pos.x + radius * 0.26, y: 0.0022, z: ball.pos.z - radius * 0.22 }, { x: radius * 1.52, y: 1, z: radius * 1.16 }), '#000000', 3, 0.10 * fade);
        this.draw('circle', Mat4.translationScale({ x: ball.pos.x + radius * 0.12, y: 0.0028, z: ball.pos.z - radius * 0.10 }, { x: radius * 1.05, y: 1, z: radius * 0.84 }), '#000000', 3, 0.20 * fade);
        this.draw('circle', Mat4.translationScale({ x: ball.pos.x + radius * 0.04, y: 0.0034, z: ball.pos.z - radius * 0.03 }, { x: radius * 0.64, y: 1, z: radius * 0.55 }), '#000000', 3, 0.26 * fade);
      }
      this.gl.depthMask(true);
    }

    drawBalls(world) {
      for (const ball of world.balls) {
        if (ball.pocketed && ball.sinkTime > 0.52) continue;
        const sinkScale = ball.pocketed ? Math.max(0.12, 1 - ball.sinkTime * 1.25) : 1;
        const r = ball.radius * sinkScale;
        const position = { x: ball.pos.x, y: ball.radius - ball.sinkDepth, z: ball.pos.z };
        const model = Mat4.fromTRS(position, ball.rotation, r);
        const texture = this.getBallTexture(ball);
        this.draw('sphere', model, ball.color, 0, ball.pocketed ? Math.max(0, 1 - ball.sinkTime * 1.7) : 1, texture);
      }
    }

    drawCue(world, direction, elevationDegrees, pullback, tipX = 0, tipY = 0) {
      const cue = world.getCueBall();
      if (!cue || cue.pocketed || !direction) return;
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
      const woodTexture = this.getMaterialTexture('wood');
      const rubberTexture = this.getMaterialTexture('rubber');
      const metalTexture = this.getMaterialTexture('metal');
      let cursor = 0.005 + (pullback || 0);
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
      const tipR = spec.tipDiameter / 2;
      const tip = world.getTipSpec ? world.getTipSpec() : { id: 'medium' };
      const tipColor = tip.id === 'soft' ? '#7d5c42' : tip.id === 'hard' ? '#4d3626' : '#6b4c36';
      segment(0.0075, tipR, 'cylinder', tipColor, 4, rubberTexture, { x: 1, y: 1 });
      segment(0.020, tipR * 1.02, 'cylinder', '#f3eee1', 6);
      segment(0.70, tipR * 1.05, 'cueShaft', '#d8ab6d', 6, woodTexture, { x: 4, y: 1 });
      const jointR = tipR * 1.05 * 1.95;
      segment(0.011, jointR * 1.02, 'cylinder', '#c8a45c', 5, metalTexture, { x: 2, y: 1 });
      segment(0.60, jointR, 'cueButt', '#59331c', 6, woodTexture, { x: 4, y: 1 });
      segment(0.010, jointR * 1.30, 'cylinder', '#191411', 4, rubberTexture, { x: 1, y: 1 });
    }

    draw(meshName, model, color, material = 0, opacity = 1, texture = null, textureMode = texture ? 1 : 0, textureScale = { x: 1, y: 1 }) {
      const gl = this.gl;
      const mesh = this.meshes[meshName];
      gl.uniformMatrix4fv(this.uniforms.uModel, false, model);
      const rgb = Array.isArray(color) ? color : hexToRgb(color);
      gl.uniform3f(this.uniforms.uColor, rgb[0], rgb[1], rgb[2]);
      gl.uniform1i(this.uniforms.uMaterial, material);
      gl.uniform1f(this.uniforms.uOpacity, opacity);
      gl.uniform1i(this.uniforms.uTextureMode, textureMode);
      gl.uniform2f(this.uniforms.uTextureScale, textureScale.x || 1, textureScale.y || 1);
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

    getBallTexture(ball) {
      const key = `${ball.kind}:${ball.number ?? ball.id}:${ball.color}`;
      if (this.textures.has(key)) return this.textures.get(key);
      const canvas = document.createElement('canvas');
      canvas.width = 512; canvas.height = 256;
      const ctx = canvas.getContext('2d');
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
    geometry: { cubeGeometry, sphereGeometry, circleGeometry, cylinderGeometry, sectorGeometry },
  };
})(window);
