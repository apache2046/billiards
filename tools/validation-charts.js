'use strict';

// Regenerates the README validation charts (docs/images/*.svg) from the live
// physics model and the published measurements it is calibrated against.
//   node tools/validation-charts.js
const fs = require('node:fs');
const path = require('node:path');
global.window = global;
require('../js/math.js');
require('../js/physics.js');
const { PhysicsWorld } = BilliardsPhysics;

const OUT = path.join(__dirname, '..', 'docs', 'images');
const D = 180 / Math.PI;
const FONT = "system-ui, -apple-system, 'Segoe UI', 'PingFang SC', 'Noto Sans CJK SC', 'Microsoft YaHei', sans-serif";
const COLORS = { model: '#0f9b77', model2: '#2f6fd0', model3: '#b0527a', data: '#e0892b', data2: '#8a5cc2', grid: '#e3e7e5', axis: '#5d6966', text: '#1f2a28' };

// Rolling (top = 1), stunned (0) or drawn (−1) ball launched at the top rail.
function railShot(mode, { speed, angle, top = 1 }) {
  const w = new PhysicsWorld(mode, { silent: true });
  const b = w.getCueBall(); w.balls = [b];
  const R = b.radius, H = w.table.height, a = angle / D;
  const vx = speed * Math.sin(a), vz = speed * Math.cos(a);
  Object.assign(b, {
    pos: { x: -0.6, z: H / 2 - R - 0.003 }, vel: { x: vx, z: vz }, posY: 0, velY: 0,
    omega: { x: top * vz / R, y: 0, z: -top * vx / R }, state: 'sliding',
  });
  let event = null, after = null;
  w.onEvent((e) => { if (e.type === 'cushion' && !event) event = e; });
  for (let i = 0; i < 16000; i += 1) {
    w.step(0.0005);
    if (event && !after) after = { vx: b.vel.x, vz: b.vel.z };
    if (after && (Math.hypot(b.vel.x + b.omega.z * R, b.vel.z - b.omega.x * R) < 1e-3 || b.pos.z < -H / 2 + 0.1)) break;
  }
  return {
    cor: event.restitution,
    immediate: 90 - Math.atan2(Math.abs(after.vx), -after.vz) * D,
    effective: 90 - Math.atan2(Math.abs(b.vel.x), -b.vel.z) * D,
  };
}

// Backspin left 2 ft after a 5.0 m/s, 34.84 rev/s draw stroke (TP B.10 set-up).
function backspinAt2ft(elevation) {
  const probe = new PhysicsWorld('eight', { silent: true });
  let tipY = -0.6, speed = 7;
  for (let i = 0; i < 40; i += 1) {
    const m = probe.cueImpactMetrics({ direction: { x: 1, z: 0 }, speed, tipY, elevation: 0 });
    speed *= 5.0 / m.speed;
    tipY = Math.max(-m.safeOffset * 0.999, tipY * 34.84 / (Math.abs(m.omega.z) / (2 * Math.PI)));
  }
  const w = new PhysicsWorld('eight', { silent: true });
  const c = w.getCueBall(); w.balls = [c]; c.pos = { x: -1, z: 0 };
  w.strike({ direction: { x: 1, z: 0 }, speed, tipY, elevation });
  for (let i = 0; i < 5000 && c.pos.x < -1 + 0.6096; i += 1) w.step(0.0002);
  return Math.abs(c.omega.z) / (2 * Math.PI);
}

function chart({ title, subtitle, xLabel, yLabel, x, y, series, legend, legendAt = 'tr', note, annotations = [] }) {
  const W = 760, H = 460, L = 70, T = 78, Rm = 24, B = 82;
  const pw = W - L - Rm, ph = H - T - B;
  const sx = (v) => L + (v - x.min) / (x.max - x.min) * pw;
  const sy = (v) => T + ph - (v - y.min) / (y.max - y.min) * ph;
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="${FONT}">`);
  out.push(`<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="14" fill="#ffffff" stroke="#d9dfdc"/>`);
  out.push(`<text x="${L - 46}" y="34" font-size="19" font-weight="700" fill="${COLORS.text}">${title}</text>`);
  if (subtitle) out.push(`<text x="${L - 46}" y="56" font-size="12.5" fill="${COLORS.axis}">${subtitle}</text>`);
  for (const v of x.ticks) {
    out.push(`<line x1="${sx(v)}" y1="${T}" x2="${sx(v)}" y2="${T + ph}" stroke="${COLORS.grid}"/>`);
    out.push(`<text x="${sx(v)}" y="${T + ph + 20}" font-size="12" text-anchor="middle" fill="${COLORS.axis}">${x.format ? x.format(v) : v}</text>`);
  }
  for (const v of y.ticks) {
    out.push(`<line x1="${L}" y1="${sy(v)}" x2="${L + pw}" y2="${sy(v)}" stroke="${COLORS.grid}"/>`);
    out.push(`<text x="${L - 10}" y="${sy(v) + 4}" font-size="12" text-anchor="end" fill="${COLORS.axis}">${y.format ? y.format(v) : v}</text>`);
  }
  out.push(`<rect x="${L}" y="${T}" width="${pw}" height="${ph}" fill="none" stroke="#c9d1ce"/>`);
  out.push(`<text x="${L + pw / 2}" y="${T + ph + 44}" font-size="13" text-anchor="middle" fill="${COLORS.text}">${xLabel}</text>`);
  out.push(`<text transform="translate(20 ${T + ph / 2}) rotate(-90)" font-size="13" text-anchor="middle" fill="${COLORS.text}">${yLabel}</text>`);
  for (const s of series) {
    if (s.band) {
      // A horizontal range, across the plot or over [from, to] only.
      const x0 = s.from == null ? L : sx(s.from), x1 = s.to == null ? L + pw : sx(s.to);
      out.push(`<rect x="${x0}" y="${sy(s.band[1])}" width="${x1 - x0}" height="${sy(s.band[0]) - sy(s.band[1])}" fill="${s.color}" opacity="${s.opacity || 0.12}"/>`);
      continue;
    }
    if (s.line) {
      const d = s.points.map(([px, py], i) => `${i ? 'L' : 'M'}${sx(px).toFixed(1)},${sy(py).toFixed(1)}`).join(' ');
      out.push(`<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.6}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ''} stroke-linejoin="round" stroke-linecap="round"/>`);
    }
    if (s.dots) {
      for (const [px, py] of s.points) {
        out.push(s.shape === 'square'
          ? `<rect x="${sx(px) - 5}" y="${sy(py) - 5}" width="10" height="10" fill="#fff" stroke="${s.color}" stroke-width="2.4"/>`
          : `<circle cx="${sx(px)}" cy="${sy(py)}" r="5.2" fill="${s.hollow ? '#fff' : s.color}" stroke="${s.color}" stroke-width="2.4"/>`);
      }
    }
  }
  for (const a of annotations) {
    out.push(`<text x="${sx(a.x)}" y="${sy(a.y)}" font-size="11.5" text-anchor="${a.anchor || 'middle'}" fill="${COLORS.axis}">${a.text}</text>`);
  }
  // Legend inside the plot, in the corner the data leaves empty.
  const width = Math.max(...legend.map((item) => item.label.length)) * 12.5 + 44;
  const height = legend.length * 21 + 10;
  const left = legendAt.endsWith('l') ? L + 12 : L + pw - 12 - width;
  const top = legendAt.startsWith('t') ? T + 8 : T + ph - 8 - height;
  let ly = top + 17;
  out.push(`<rect x="${left}" y="${top}" width="${width}" height="${height}" rx="8" fill="#ffffff" fill-opacity="0.94" stroke="#e1e6e4"/>`);
  for (const item of legend) {
    const x0 = left + 12;
    if (item.kind === 'line') out.push(`<line x1="${x0}" y1="${ly}" x2="${x0 + 22}" y2="${ly}" stroke="${item.color}" stroke-width="2.6" ${item.dash ? `stroke-dasharray="${item.dash}"` : ''}/>`);
    else if (item.kind === 'band') out.push(`<rect x="${x0}" y="${ly - 6}" width="22" height="12" fill="${item.color}" opacity="0.25"/>`);
    else if (item.kind === 'square') out.push(`<rect x="${x0 + 6}" y="${ly - 5}" width="10" height="10" fill="#fff" stroke="${item.color}" stroke-width="2.4"/>`);
    else out.push(`<circle cx="${x0 + 11}" cy="${ly}" r="5" fill="${item.hollow ? '#fff' : item.color}" stroke="${item.color}" stroke-width="2.4"/>`);
    out.push(`<text x="${x0 + 30}" y="${ly + 4.5}" font-size="12.5" fill="${COLORS.text}">${item.label}</text>`);
    ly += 21;
  }
  if (note) out.push(`<text x="${W - Rm}" y="${H - 12}" font-size="11" text-anchor="end" fill="${COLORS.axis}">${note}</text>`);
  out.push('</svg>');
  return `${out.join('\n')}\n`;
}

fs.mkdirSync(OUT, { recursive: true });

// 1. TP B.11: slow rolling ball, angles measured from the rail.
{
  const data = [[10, 5, 3.5], [20, 10.5, 8.4], [30, 23, 16.9], [40, 37, 25.2], [50, 46, 35.7], [60, 56, 48.7], [70, 70, 64.1], [80, 79.95, 75.5]];
  const model = [];
  for (let incoming = 6; incoming <= 84; incoming += 2) model.push([incoming, railShot('eight', { speed: 0.6, angle: 90 - incoming })]);
  fs.writeFileSync(path.join(OUT, 'rail-rebound.svg'), chart({
    title: '吃库角度：模型 vs Dr Dave / Jewett 实测（TP B.11）',
    subtitle: '美式台，慢速滚动母球、无侧塞；角度均从库线量起',
    xLabel: '入库角（°，离库线）', yLabel: '出库角（°，离库线）',
    x: { min: 0, max: 90, ticks: [0, 15, 30, 45, 60, 75, 90] },
    y: { min: 0, max: 90, ticks: [0, 15, 30, 45, 60, 75, 90] },
    series: [
      { line: true, points: [[0, 0], [90, 90]], color: '#b9c3bf', width: 1.4, dash: '5 5' },
      { line: true, points: model.map(([i, r]) => [i, r.immediate]), color: COLORS.model2 },
      { line: true, points: model.map(([i, r]) => [i, r.effective]), color: COLORS.model },
      { dots: true, hollow: true, points: data.map(([i, now]) => [i, now]), color: COLORS.data2 },
      { dots: true, points: data.map(([i, , later]) => [i, later]), color: COLORS.data },
    ],
    legend: [
      { kind: 'dot', hollow: true, color: COLORS.data2, label: '实测：刚离库（高速摄像）' },
      { kind: 'line', color: COLORS.model2, label: '模型：刚离库' },
      { kind: 'dot', color: COLORS.data, label: '实测：回弯后（到下一库）' },
      { kind: 'line', color: COLORS.model, label: '模型：回弯后' },
      { kind: 'line', color: '#b9c3bf', dash: '5 5', label: '镜面反射（入 = 出）' },
    ],
    legendAt: 'tl',
    note: '数据：drdavepoolinfo.com TP B.11',
  }));
}

// 2. Rolling ball driven straight into the rail: rebound/incident speed.
{
  const speeds = [];
  for (let v = 0.25; v <= 4.01; v += 0.125) speeds.push(v);
  const curve = (mode) => speeds.map((v) => [v, railShot(mode, { speed: v, angle: 0 }).cor]);
  // Mathavan 2009, 31 rolling shots: the paper's quadratic fit of rebound vs
  // incident speed, and the spread of the plotted points (read off the figure).
  const fit = [];
  for (let v = 0.5; v <= 3.501; v += 0.125) fit.push([v, (-0.0877 * v * v + 1.131 * v - 0.0953) / v]);
  fs.writeFileSync(path.join(OUT, 'cushion-cor.svg'), chart({
    title: '库边回弹：滚动球正撞库的出/入速度比',
    subtitle: '美式按 Dr Dave（TP B.6、HSV B.15）标定；斯诺克按 Mathavan 等（AJP 2009）；中式沿用斯诺克式钢库胶边',
    xLabel: '入库速度（m/s）', yLabel: '出/入速度比',
    x: { min: 0, max: 4, ticks: [0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4] },
    y: { min: 0.3, max: 1.0, ticks: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0], format: (v) => v.toFixed(1) },
    series: [
      { band: [0.66, 0.78], color: COLORS.data },
      { band: [0.87, 0.95], from: 0.28, to: 2.5, color: COLORS.data2, opacity: 0.16 },
      { band: [0.81, 0.85], from: 2.7, to: 3.4, color: COLORS.data2, opacity: 0.16 },
      { line: true, points: fit, color: COLORS.data2, dash: '6 5', width: 2 },
      { line: true, points: curve('eight'), color: COLORS.model },
      { line: true, points: curve('chineseEight'), color: COLORS.model2 },
      { line: true, points: curve('snooker'), color: COLORS.model3 },
    ],
    legend: [
      { kind: 'line', color: COLORS.model, label: '模型：美式' },
      { kind: 'line', color: COLORS.model2, label: '模型：中式' },
      { kind: 'line', color: COLORS.model3, label: '模型：斯诺克' },
      { kind: 'band', color: COLORS.data2, label: 'Mathavan 2009 斯诺克 31 杆实测点范围' },
      { kind: 'line', color: COLORS.data2, dash: '6 5', label: 'Mathavan 2009 二次拟合' },
      { kind: 'band', color: COLORS.data, label: 'Dr Dave：美式约 0.7（HSV B.15 实测 0.72）' },
    ],
    legendAt: 'br',
    note: '数据：Am. J. Phys. 77, 788；drdavepoolinfo.com TP B.6 / HSV B.15',
  }));
}

// 3. TP B.10: backspin left after 2 ft vs cue elevation.
{
  const model = [];
  for (let e = 0; e <= 12.5; e += 0.25) model.push([e, backspinAt2ft(e)]);
  fs.writeFileSync(path.join(OUT, 'elevated-draw.svg'), chart({
    title: '抬杆低杆的转速损失：模型 vs Dr Dave TP B.10',
    subtitle: '5.0 m/s、34.84 转/秒的低杆，走 2 英尺（0.61 m）后剩余的回旋',
    xLabel: '球杆仰角（°）', yLabel: '剩余回旋（转/秒）',
    x: { min: 0, max: 12.5, ticks: [0, 2, 4, 6, 8, 10, 12] },
    y: { min: 24, max: 33, ticks: [24, 26, 28, 30, 32] },
    series: [
      { line: true, points: model, color: COLORS.model },
      { dots: true, points: [[0, 31.43], [5, 30.12], [12, 27.42]], color: COLORS.data },
    ],
    legend: [
      { kind: 'line', color: COLORS.model, label: '模型（石板反弹摩擦 + 落地）' },
      { kind: 'dot', color: COLORS.data, label: 'TP B.10：31.43 / 30.12 / 27.42' },
    ],
    legendAt: 'bl',
    annotations: [{ x: 8, y: 31.4, text: '台阶：抬到一定角度开始弹跳，2 英尺内的落地次数随仰角跳变' }],
    note: '数据：drdavepoolinfo.com TP B.10',
  }));
}

console.log(`Charts written to ${path.relative(process.cwd(), OUT) || OUT}`);
