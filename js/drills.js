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
      // A cue ball only comes back to a rail it has just left while it still
      // carries excess topspin, i.e. within a few centimetres of the object
      // ball: the 1 sits 4 cm off the rail beside the middle pocket.
      follow: () => ({
        ...cutShot({ x: -0.04, z: table.height / 2 - R - 0.04 }, table.pockets.find(p => p.id === 'tm'), 15, 0.40),
        spin: { x: 0, y: 0.65 }, power: 0.90, elevation: 3,
        hint: '1 号球离库只有 4 cm：90% 力度大高杆切进中袋，母球带着多余前旋顶库、弹出十来厘米后被拉回同一库边。撤销后减小力度或高杆，看回吸何时消失。',
      }),
      draw: () => ({
        ...cutShot({ x: 0.80, z: -0.35 }, table.pockets.find(p => p.id === 'br'), 5, 1.80),
        spin: { x: 0, y: -0.65 }, power: 0.95, elevation: 3,
        hint: '1.8 米长台、95% 力度、深低杆。偏心击球要分一部分出杆能量给旋转，长台回拉需要接近全力；撤销后改为 80%，比较途中后旋的损失。',
      }),
      gear: () => ({
        cue: { x: -2 * R * Math.cos(Math.PI / 6) - 0.08, z: -R }, target: { x: 0, z: 0 },
        aim: { x: 1, z: 0 }, spin: { x: 0, y: 0 }, power: 0.45, elevation: 3,
        hint: '30° 切球先看无塞抛掷，再撤销、逐步加左侧外塞。恰当外塞可抵消抛掷，过量则反向；齿轮条件取决于碰球瞬间的旋转。',
      }),
      masse: () => ({
        cue: { x: -0.45, z: -0.18 }, target: { x: -0.15, z: -0.18 }, aim: { x: 1, z: 0 },
        spin: { x: 0.40, y: -0.50 }, power: 0.45, elevation: 60,
        hint: '中等力度抬杆 60°，让母球向侧面弯开障碍球。空中不受台呢摩擦，落地后继续回弯；起跳幅度是近似模型，尚非实台器材标定。',
      }),
    };
    const id = Object.hasOwn(setups, kind) ? kind : 'english';
    return { id, ...setups[id]() };
  }

  global.BilliardsDrills = { createDrill };
})(window);
