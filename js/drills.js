(function (global) {
  'use strict';

  const { V2 } = global.BilliardsMath;

  // Pure layouts shared by the UI and end-to-end physics tests. These are
  // repeatable examples, not special-case forces or guaranteed potting rules.
  function createDrill(kind, table, R) {
    const cutShot = (target, pocket, cut, distance) => {
      const normal = V2.normalize(V2.sub(pocket, target));
      const angle = Math.atan2(normal.z, normal.x) + cut * Math.PI / 180;
      const aim = { x: Math.cos(angle), z: Math.sin(angle) };
      return { target, aim, cue: V2.sub(V2.sub(target, V2.scale(normal, 2 * R)), V2.scale(aim, distance)) };
    };
    const setups = {
      railFrozen: () => ({
        cue: { x: 0.20, z: table.height / 2 - R - 0.00015 }, target: { x: 0.78, z: table.height / 2 - R - 0.00015 },
        aim: { x: 1, z: 0 }, spin: { x: 0, y: 0 }, power: 0.34, elevation: 1,
        hint: '母球与 1 号球都贴长库。观察目标球沿库到圆弧袋角时，是进袋、晃袋还是被圆角弹出。',
      }),
      english: () => ({
        cue: { x: -0.50, z: -0.27 }, aim: V2.normalize({ x: 0.50, z: 1 }),
        spin: { x: -0.45, y: 0 }, power: 0.48, elevation: 3,
        hint: '当前是左塞顺塞。击打一杆后撤销，只改成右塞再打；对照首库入/出角和让点读数。',
      }),
      follow: () => ({
        ...cutShot({ x: 1.18, z: 0.57 }, table.pockets.find(p => p.id === 'tr'), -10, 0.10),
        spin: { x: 0, y: 0.60 }, power: 0.80, elevation: 3,
        hint: '先厚切 1 号球入角袋，再看母球碰短库、离库和回吸。首库显示前旋状态，实际回到同一库边才标为「回吸同库」。',
      }),
      draw: () => ({
        ...cutShot({ x: 0.80, z: -0.35 }, table.pockets.find(p => p.id === 'br'), 5, 1.80),
        spin: { x: 0, y: -0.65 }, power: 0.80, elevation: 3,
        hint: '1.8 米长台、80% 力度、深低杆。观察进球后的回拉碰库；撤销后改为 62%，比较途中后旋的损失。',
      }),
      gear: () => ({
        cue: { x: -2 * R * Math.cos(Math.PI / 6) - 0.08, z: -R }, target: { x: 0, z: 0 },
        aim: { x: 1, z: 0 }, spin: { x: 0, y: 0 }, power: 0.45, elevation: 3,
        hint: '30° 切球先看无塞抛掷，再撤销、逐步加左侧外塞。恰当外塞可抵消抛掷，过量则反向；齿轮条件取决于碰球瞬间的旋转。',
      }),
      masse: () => ({
        cue: { x: -0.45, z: -0.18 }, target: { x: -0.15, z: -0.18 }, aim: { x: 1, z: 0 },
        spin: { x: 0.40, y: -0.55 }, power: 0.30, elevation: 60,
        hint: '轻力抬杆，让母球向侧面弯开障碍球。空中不受台呢摩擦，落地后继续回弯；起跳幅度是近似模型，尚非实台器材标定。',
      }),
    };
    const id = Object.hasOwn(setups, kind) ? kind : 'english';
    return { id, ...setups[id]() };
  }

  global.BilliardsDrills = { createDrill };
})(window);
