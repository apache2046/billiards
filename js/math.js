(function (global) {
  'use strict';

  const EPS = 1e-9;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const saturate = (v) => clamp(v, 0, 1);
  const lerp = (a, b, t) => a + (b - a) * t;
  const smoothstep = (a, b, v) => {
    const t = saturate((v - a) / (b - a || 1));
    return t * t * (3 - 2 * t);
  };

  const V2 = {
    create: (x = 0, z = 0) => ({ x, z }),
    clone: (v) => ({ x: v.x, z: v.z }),
    add: (a, b) => ({ x: a.x + b.x, z: a.z + b.z }),
    sub: (a, b) => ({ x: a.x - b.x, z: a.z - b.z }),
    scale: (v, s) => ({ x: v.x * s, z: v.z * s }),
    dot: (a, b) => a.x * b.x + a.z * b.z,
    cross: (a, b) => a.x * b.z - a.z * b.x,
    lengthSq: (v) => v.x * v.x + v.z * v.z,
    length: (v) => Math.hypot(v.x, v.z),
    distance: (a, b) => Math.hypot(a.x - b.x, a.z - b.z),
    normalize(v, fallback = { x: 1, z: 0 }) {
      const len = Math.hypot(v.x, v.z);
      return len > EPS ? { x: v.x / len, z: v.z / len } : { x: fallback.x, z: fallback.z };
    },
    perp: (v) => ({ x: -v.z, z: v.x }),
    reflect: (v, n) => {
      const d = 2 * (v.x * n.x + v.z * n.z);
      return { x: v.x - d * n.x, z: v.z - d * n.z };
    },
  };

  const V3 = {
    create: (x = 0, y = 0, z = 0) => ({ x, y, z }),
    add: (a, b) => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }),
    sub: (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }),
    scale: (v, s) => ({ x: v.x * s, y: v.y * s, z: v.z * s }),
    dot: (a, b) => a.x * b.x + a.y * b.y + a.z * b.z,
    cross: (a, b) => ({
      x: a.y * b.z - a.z * b.y,
      y: a.z * b.x - a.x * b.z,
      z: a.x * b.y - a.y * b.x,
    }),
    length: (v) => Math.hypot(v.x, v.y, v.z),
    normalize(v, fallback = { x: 0, y: 1, z: 0 }) {
      const len = Math.hypot(v.x, v.y, v.z);
      return len > EPS ? { x: v.x / len, y: v.y / len, z: v.z / len } : { ...fallback };
    },
  };

  const Quat = {
    identity: () => [0, 0, 0, 1],
    normalize(q) {
      const len = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      q[0] /= len; q[1] /= len; q[2] /= len; q[3] /= len;
      return q;
    },
    integrate(q, omega, dt) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const wx = omega.x, wy = omega.y, wz = omega.z;
      const h = 0.5 * dt;
      q[0] += h * (wx * w + wy * z - wz * y);
      q[1] += h * (-wx * z + wy * w + wz * x);
      q[2] += h * (wx * y - wy * x + wz * w);
      q[3] += h * (-wx * x - wy * y - wz * z);
      return Quat.normalize(q);
    },
  };

  const Mat4 = {
    identity() {
      return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    },
    multiply(a, b) {
      const out = new Float32Array(16);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      let b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
      out[0] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[4]; b1 = b[5]; b2 = b[6]; b3 = b[7];
      out[4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[5] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[6] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[7] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[8]; b1 = b[9]; b2 = b[10]; b3 = b[11];
      out[8] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[9] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[10] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[11] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      b0 = b[12]; b1 = b[13]; b2 = b[14]; b3 = b[15];
      out[12] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
      out[13] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
      out[14] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
      out[15] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
      return out;
    },
    perspective(fovy, aspect, near, far) {
      const f = 1 / Math.tan(fovy / 2);
      const nf = 1 / (near - far);
      const out = new Float32Array(16);
      out[0] = f / aspect;
      out[5] = f;
      out[10] = (far + near) * nf;
      out[11] = -1;
      out[14] = 2 * far * near * nf;
      return out;
    },
    ortho(left, right, bottom, top, near, far) {
      const lr = 1 / (left - right), bt = 1 / (bottom - top), nf = 1 / (near - far);
      const out = Mat4.identity();
      out[0] = -2 * lr; out[5] = -2 * bt; out[10] = 2 * nf;
      out[12] = (left + right) * lr; out[13] = (top + bottom) * bt; out[14] = (far + near) * nf;
      return out;
    },
    lookAt(eye, center, up) {
      let z = V3.normalize(V3.sub(eye, center));
      let x = V3.normalize(V3.cross(up, z), { x: 1, y: 0, z: 0 });
      let y = V3.cross(z, x);
      const out = Mat4.identity();
      out[0] = x.x; out[1] = y.x; out[2] = z.x;
      out[4] = x.y; out[5] = y.y; out[6] = z.y;
      out[8] = x.z; out[9] = y.z; out[10] = z.z;
      out[12] = -V3.dot(x, eye); out[13] = -V3.dot(y, eye); out[14] = -V3.dot(z, eye);
      return out;
    },
    fromTRS(position, q, scale) {
      const x = q[0], y = q[1], z = q[2], w = q[3];
      const x2 = x + x, y2 = y + y, z2 = z + z;
      const xx = x * x2, xy = x * y2, xz = x * z2;
      const yy = y * y2, yz = y * z2, zz = z * z2;
      const wx = w * x2, wy = w * y2, wz = w * z2;
      const sx = typeof scale === 'number' ? scale : scale.x;
      const sy = typeof scale === 'number' ? scale : scale.y;
      const sz = typeof scale === 'number' ? scale : scale.z;
      const out = new Float32Array(16);
      out[0] = (1 - (yy + zz)) * sx; out[1] = (xy + wz) * sx; out[2] = (xz - wy) * sx; out[3] = 0;
      out[4] = (xy - wz) * sy; out[5] = (1 - (xx + zz)) * sy; out[6] = (yz + wx) * sy; out[7] = 0;
      out[8] = (xz + wy) * sz; out[9] = (yz - wx) * sz; out[10] = (1 - (xx + yy)) * sz; out[11] = 0;
      out[12] = position.x; out[13] = position.y; out[14] = position.z; out[15] = 1;
      return out;
    },
    translationScale(position, scale) {
      return Mat4.fromTRS(position, Quat.identity(), scale);
    },
    rotationY(angle) {
      const c = Math.cos(angle), s = Math.sin(angle);
      return new Float32Array([c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1]);
    },
    invert(a) {
      const out = new Float32Array(16);
      const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
      const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
      const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
      const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];
      const b00 = a00 * a11 - a01 * a10;
      const b01 = a00 * a12 - a02 * a10;
      const b02 = a00 * a13 - a03 * a10;
      const b03 = a01 * a12 - a02 * a11;
      const b04 = a01 * a13 - a03 * a11;
      const b05 = a02 * a13 - a03 * a12;
      const b06 = a20 * a31 - a21 * a30;
      const b07 = a20 * a32 - a22 * a30;
      const b08 = a20 * a33 - a23 * a30;
      const b09 = a21 * a32 - a22 * a31;
      const b10 = a21 * a33 - a23 * a31;
      const b11 = a22 * a33 - a23 * a32;
      let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
      if (!det) return null;
      det = 1 / det;
      out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
      out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
      out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
      out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
      out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
      out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
      out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
      out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
      out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
      out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
      out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
      out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
      out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
      out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
      out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
      out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
      return out;
    },
    transformVec4(m, v) {
      return [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
      ];
    },
  };

  const hexToRgb = (hex) => {
    const value = parseInt(hex.replace('#', ''), 16);
    return [(value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255];
  };

  global.BilliardsMath = { EPS, clamp, saturate, lerp, smoothstep, V2, V3, Quat, Mat4, hexToRgb };
})(window);
