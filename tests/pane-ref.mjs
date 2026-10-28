// 验证页签引用的解析规则（不启动 Electron，直接测纯函数逻辑）
import assert from 'node:assert';

let passed = 0;
const ok = (cond, msg) => {
  assert.ok(cond, msg);
  passed += 1;
  console.log('  ok  ' + msg);
};

// 与 desktop/pane-api.js 中 findPane 保持一致
function makeFindPane(panes) {
  return function findPane(ref) {
    const raw = String(ref || '').trim();
    if (!raw) return null;
    const byId = panes.find((pane) => pane.id === raw);
    if (byId) return byId;
    const scoped = raw.match(/^(.*)#(\d+)$/);
    if (scoped) {
      const projectName = scoped[1].trim();
      const number = Number(scoped[2]);
      if (projectName) {
        return (
          panes.find(
            (pane) =>
              pane.paneNo === number &&
              String(pane.groupName || '').toLowerCase() === projectName.toLowerCase(),
          ) || null
        );
      }
    }
    const number = Number(raw.replace(/^#/, ''));
    if (!Number.isFinite(number) || number < 1) return null;
    const hits = panes.filter((pane) => pane.paneNo === number);
    if (hits.length > 1) {
      const names = hits.map((pane) => pane.groupName || '未命名项目').join('、');
      const error = new Error(
        `编号 #${number} 在多个项目里都有（${names}）。请改用「项目名#编号」，例如 ${hits[0].groupName}#${number}`,
      );
      error.status = 409;
      throw error;
    }
    return hits[0] || null;
  };
}

const panes = [
  { id: 'id-a1', paneNo: 1, groupName: 'CmdToolbox工具', kind: 'terminal' },
  { id: 'id-b1', paneNo: 1, groupName: 'B2C 6.0', kind: 'terminal' },
  { id: 'id-b2', paneNo: 2, groupName: 'B2C 6.0', kind: 'browser' },
];
const findPane = makeFindPane(panes);

console.log('1. 按 id 精确匹配');
ok(findPane('id-a1').groupName === 'CmdToolbox工具', 'id 命中正确页签');

console.log('2. 按「项目名#编号」限定');
ok(findPane('CmdToolbox工具#1').id === 'id-a1', '中文项目名可定位');
ok(findPane('B2C 6.0#1').id === 'id-b1', '带空格的项目名可定位');
ok(findPane('b2c 6.0#1').id === 'id-b1', '项目名大小写不敏感');
ok(findPane('B2C 6.0#2').kind === 'browser', '同项目第二个页签命中');

console.log('3. 编号唯一时 #N 仍可用');
ok(findPane('#2').id === 'id-b2', '#2 唯一，正常命中');

console.log('4. 编号重复时报错而非乱选');
let err = null;
try {
  findPane('#1');
} catch (error) {
  err = error;
}
ok(Boolean(err), '重号时抛错');
ok(err.status === 409, '错误码为 409');
ok(err.message.includes('B2C 6.0') && err.message.includes('CmdToolbox工具'), '错误信息列出冲突项目');
ok(
  err.message.includes('CmdToolbox工具#1') || err.message.includes('B2C 6.0#1'),
  '错误信息给出正确写法示例',
);

console.log('5. 无效输入');
ok(findPane('') === null, '空字符串返回 null');
ok(findPane('不存在的项目#1') === null, '项目名不匹配返回 null');
ok(findPane('#99') === null, '编号不存在返回 null');

console.log(`\n全部通过：${passed} 项`);
