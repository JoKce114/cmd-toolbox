import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const updates = require('../desktop/updates.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

function makeFetch(payload, status = 200) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  });
}

console.log('1. 版本号比较');
assert(updates.compareVersions('1.10.0', '1.9.0') > 0, '1.10.0 高于 1.9.0');
assert(updates.compareVersions('v1.2.0', '1.2.0') === 0, 'v 前缀不影响比较');
assert(updates.compareVersions('release-1.2.0', '1.1.9') > 0, 'release- 前缀也能解析');
assert(updates.compareVersions('1.2', '1.2.0') === 0, '缺 patch 位按 0 处理');
assert(updates.compareVersions('1.2.0-beta.1', '1.2.0') === 0, '预发布后缀被忽略');
assert(updates.compareVersions('abc', '1.0.0') === null, '无法解析时返回 null');
assert(updates.parseVersion('') === null, '空字符串解析为 null');

console.log('2. Release 判定');
const release = {
  tag_name: 'v1.1.0',
  html_url: 'https://github.com/o/r/releases/tag/v1.1.0',
  body: 'a'.repeat(900),
};
const newer = updates.evaluateRelease('1.0.0', release, null);
assert(newer.ok === true && newer.hasUpdate === true, '更新版本被识别');
assert(newer.latest === 'v1.1.0' && newer.url.includes('v1.1.0'), '带出 tag 与页面地址');
assert(newer.notes.length < 900, '更新说明被截断');

const same = updates.evaluateRelease('1.1.0', release, null);
assert(same.hasUpdate === false, '同版本不提示更新');

const older = updates.evaluateRelease('2.0.0', release, null);
assert(older.hasUpdate === false, '当前版本更高时不提示更新');

const none = updates.evaluateRelease('1.0.0', null, null);
assert(none.ok === true && none.latest === null && none.hasUpdate === false, '没有 Release 时正常返回');
assert(none.url.includes('/releases'), '没有 Release 时仍给出下载页');

console.log('3. 公告判定');
assert(updates.announceFor('1.0.0', 'v1.1.0', null) === null, '首次启用不弹公告');
assert(updates.announceFor('1.0.0', 'v1.1.0', '1.0.0') === 'available', '有新版且已看过当前版本 → available');
assert(updates.announceFor('1.0.0', 'v1.0.0', '1.0.0') === null, '已看过且无新版不弹');
assert(updates.announceFor('1.1.0', 'v1.1.0', '1.0.0') === 'updated', '版本前进 → updated');
assert(updates.announceFor('1.0.0', 'v1.1.0', '1.1.0') === null, '用户回退版本不弹');
assert(updates.announceFor('weird', 'v1.1.0', '1.0.0') === null, '版本号异常时不弹');

console.log('4. checkForUpdate 走网络时的返回形状');
const okResult = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch(release),
);
assert(okResult.ok === true && okResult.announce === 'available', '注入 fetch 后可得到公告判定');
assert(okResult.current === '1.0.0', '返回当前版本');

const cacheResult = await updates.checkForUpdate('1.0.0', '1.1.0', makeFetch(release));
assert(cacheResult.announce === null, '缓存复用时按本次 seenVersion 重新判定');

updates.resetCache();
const missing = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 404),
);
assert(missing.ok === true && missing.latest === null, '404 视为还没有 Release');

updates.resetCache();
const limited = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 403),
);
assert(limited.ok === false && limited.message.includes('频繁'), '403 给出限流提示');

updates.resetCache();
const broken = await updates.checkForUpdate('1.0.0', '1.0.0', async () => {
  const error = new Error('getaddrinfo ENOTFOUND');
  error.name = 'AbortError';
  throw error;
});
assert(broken.ok === false && broken.message.includes('超时'), '超时/中断给出可读提示');

console.log(`\n全部通过：${passed} 项`);
