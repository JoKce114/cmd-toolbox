import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const updates = require('../desktop/updates.js');

let passed = 0;
function assert(condition, message) {
  if (!condition) throw new Error(`断言失败：${message}`);
  passed += 1;
  console.log(`  ok  ${message}`);
}

function makeFetch(payload, status = 200, headers = {}) {
  return async () => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
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
const newer = updates.evaluateRelease('1.0.0', [release], null);
assert(newer.ok === true && newer.hasUpdate === true, '更新版本被识别');
assert(newer.latest === 'v1.1.0' && newer.url.includes('v1.1.0'), '带出 tag 与页面地址');
assert(newer.notes.length < 900, '更新说明被截断');

const same = updates.evaluateRelease('1.1.0', [release], null);
assert(same.hasUpdate === false, '同版本不提示更新');

const older = updates.evaluateRelease('2.0.0', [release], null);
assert(older.hasUpdate === false, '当前版本更高时不提示更新');

const none = updates.evaluateRelease('1.0.0', [], null);
assert(none.ok === true && none.latest === null && none.hasUpdate === false, '没有 Release 时正常返回');
assert(none.url.includes('/releases'), '没有 Release 时仍给出下载页');

console.log('3. 公告判定');
assert(updates.announceFor('1.0.0', 'v1.1.0', null) === null, '首次启用不弹公告');
assert(updates.announceFor('1.0.0', 'v1.1.0', '1.0.0') === 'available', '有新版且已看过当前版本 → available');
assert(updates.announceFor('1.0.0', 'v1.0.0', '1.0.0') === null, '已看过且无新版不弹');
assert(updates.announceFor('1.1.0', 'v1.1.0', '1.0.0') === 'updated', '版本前进 → updated');
assert(updates.announceFor('1.0.0', 'v1.1.0', '1.1.0') === null, '用户回退版本不弹');
assert(updates.announceFor('weird', 'v1.1.0', '1.0.0') === null, '版本号异常时不弹');

console.log('3b. 跳版本时列出区间内的所有版本');
const multi = [
  { tag_name: 'v1.3.0', html_url: 'u1.3.0', body: '1.3.0 说明' },
  { tag_name: 'v1.2.0', html_url: 'u1.2.0', body: '1.2.0 说明' },
  { tag_name: 'v1.1.0', html_url: 'u1.1.0', body: '1.1.0 说明' },
  { tag_name: 'v1.0.0', html_url: 'u1.0.0', body: '1.0.0 说明' },
];

// 本地 1.0.0，线上最新 1.3.0 → 列出 1.3.0 / 1.2.0 / 1.1.0
const jumped = updates.evaluateRelease('1.0.0', multi, '1.0.0');
assert(jumped.announce === 'available', '识别出新版本');
assert(
  jumped.releases.map((r) => r.version).join(',') === 'v1.3.0,v1.2.0,v1.1.0',
  '列出区间内全部版本，从新到旧',
);
assert(
  jumped.releases.every((r) => r.notes && r.url),
  '每个版本都带自己的说明和链接',
);
assert(
  jumped.releases.find((r) => r.version === 'v1.2.0').notes === '1.2.0 说明',
  '说明与版本对应，没有错配',
);
assert(jumped.notes === '1.3.0 说明', 'notes 兼容字段取最新一条');

// 刚升级完：seen=1.1.0，current=1.3.0 → 列出 1.3.0 / 1.2.0
const upgraded = updates.evaluateRelease('1.3.0', multi, '1.1.0');
assert(upgraded.announce === 'updated', '识别为已升级');
assert(
  upgraded.releases.map((r) => r.version).join(',') === 'v1.3.0,v1.2.0',
  '列出本次跨过的版本',
);

// 只差一个版本时只列一个
const single = updates.evaluateRelease('1.2.0', multi, '1.2.0');
assert(single.releases.length === 1 && single.releases[0].version === 'v1.3.0', '只跳一版时只列一条');

// 没有新版可装时 releases 为空
const upToDate = updates.evaluateRelease('1.3.0', multi, '1.3.0');
assert(upToDate.releases.length === 0, '已是最新时不列任何版本');

console.log('3c. 草稿与预发布被过滤');
const withDrafts = [
  { tag_name: 'v1.4.0', html_url: 'd', body: '草稿', draft: true },
  { tag_name: 'v1.3.1', html_url: 'p', body: '预览', prerelease: true },
  { tag_name: 'v1.3.0', html_url: 'r', body: '正式' },
];
const filtered = updates.evaluateRelease('1.0.0', withDrafts, '1.0.0');
assert(filtered.latest === 'v1.3.0', '草稿和预发布不算最新版本');
assert(filtered.releases.length === 1, '草稿和预发布不出现在列表里');

console.log('3d. 列表上限与说明截断');
const many = Array.from({ length: 40 }, (_, i) => ({
  tag_name: `v1.0.${40 - i}`,
  html_url: `u${i}`,
  body: 'b'.repeat(1200),
}));
const capped = updates.evaluateRelease('0.0.1', many, '0.0.1');
assert(capped.releases.length === 30, '最多列出 30 个版本');
assert(capped.releases.every((r) => r.notes.length <= 601), '单条说明被截断');

console.log('4. checkForUpdate 走网络时的返回形状');
const okResult = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch([release]),
);
assert(okResult.ok === true && okResult.announce === 'available', '注入 fetch 后可得到公告判定');
assert(okResult.current === '1.0.0', '返回当前版本');

const cacheResult = await updates.checkForUpdate('1.0.0', '1.1.0', makeFetch([release]));
assert(cacheResult.announce === null, '缓存复用时按本次 seenVersion 重新判定');

updates.resetCache();
const missing = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 404),
);
assert(missing.ok === true && missing.latest === null, '404 视为还没有 Release');

updates.resetCache();
const emptyList = await updates.checkForUpdate('1.0.0', '1.0.0', makeFetch([]));
assert(emptyList.ok === true && emptyList.latest === null, '空列表视为还没有 Release');

updates.resetCache();
const limited = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 403),
);
assert(limited.ok === false && limited.message.includes('频繁'), '403 给出限流提示');

updates.resetCache();
const resetAt = Math.floor((Date.now() + 20 * 60 * 1000) / 1000);
const limitedWithReset = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 403, { 'x-ratelimit-reset': String(resetAt) }),
);
assert(
  limitedWithReset.ok === false && /\d+ 分钟后自动恢复/.test(limitedWithReset.message),
  '403 带 X-RateLimit-Reset 时给出恢复时间',
);
assert(
  limitedWithReset.message.includes('频繁') &&
    !limitedWithReset.message.includes('请稍后再试'),
  '能算出恢复时间时不再用笼统文案',
);

updates.resetCache();
// 已经过了重置时间时不显示「0 分钟后」
const pastReset = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 429, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) - 60) }),
);
assert(
  pastReset.ok === false && pastReset.message.includes('请稍后再试'),
  '重置时间已过时回退到笼统提示',
);

updates.resetCache();
// 超过一小时按笼统提示，不给出「87 分钟后」
const farReset = await updates.checkForUpdate(
  '1.0.0',
  '1.0.0',
  makeFetch({}, 403, { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3 * 3600) }),
);
assert(
  farReset.ok === false && farReset.message.includes('请稍后再试'),
  '重置时间超过一小时时回退到笼统提示',
);

updates.resetCache();
const broken = await updates.checkForUpdate('1.0.0', '1.0.0', async () => {
  const error = new Error('getaddrinfo ENOTFOUND');
  error.name = 'AbortError';
  throw error;
});
assert(broken.ok === false && broken.message.includes('超时'), '超时/中断给出可读提示');

console.log(`\n全部通过：${passed} 项`);
