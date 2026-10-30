// 发布仓库只在这里写一次，渲染层和其它模块都不要重复硬编码
const REPO = 'JoKce114/cmd-toolbox';
// 端到端测试用本地假接口时覆盖这个地址
const API_URL =
  process.env.CMDTOOLBOX_UPDATE_API ||
  `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases`;
const TIMEOUT_MS = 8000;
const CACHE_TTL = 5 * 60 * 1000;
// 带分节和机型列表的详细说明很容易超过 600 字符，截断会正好切在列表中间，
// 公告反而看不明白。上限只用来兜底异常长的正文。
const NOTES_LIMIT = 2400;
const MAX_RELEASES = 30;

// 延迟取 net：单测在纯 Node 里 require 本文件时 electron 不是真实模块
function defaultFetch(url, init) {
  const electron = require('electron');
  if (!electron || !electron.net) throw new Error('当前环境不支持检查更新');
  return electron.net.fetch(url, init);
}

// 兼容 v1.2.0 / release-1.2.0 / 1.2 等写法；解析不出来返回 null，绝不兜底成 0.0.0
function parseVersion(text) {
  const match = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text || ''));
  if (!match) return null;
  return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function announceFor(current, latest, seenVersion) {
  if (!seenVersion) return null;
  const currentVsSeen = compareVersions(current, seenVersion);
  if (currentVsSeen === null) return null;
  if (currentVsSeen > 0) return 'updated';
  if (currentVsSeen < 0) return null;
  if (latest && compareVersions(latest, current) > 0) return 'available';
  return null;
}

// GitHub 的 /releases 按发布时间倒序；草稿和预发布不算正式版本
function usableReleases(list) {
  return (Array.isArray(list) ? list : [])
    .filter((item) => item && item.tag_name && !item.draft && !item.prerelease)
    .map((item) => ({
      version: String(item.tag_name),
      url: item.html_url || RELEASE_PAGE,
      raw: typeof item.body === 'string' ? item.body.trim() : '',
    }))
    .filter((item) => parseVersion(item.version) !== null);
}

// 跳版本时要把中间错过的版本一起列出来：(from, to] 区间内的所有版本，从新到旧
function rangeReleases(releases, from, to) {
  const ordered = releases
    .slice()
    .sort((a, b) => (compareVersions(b.version, a.version) || 0));

  return ordered
    .filter((item) => {
      if (compareVersions(item.version, to) > 0) return false;
      if (!from) return true;
      return compareVersions(item.version, from) > 0;
    })
    .slice(0, MAX_RELEASES)
    .map((item) => ({
      version: item.version,
      url: item.url,
      notes: item.raw.length > NOTES_LIMIT ? `${item.raw.slice(0, NOTES_LIMIT)}…` : item.raw,
    }));
}

function evaluateRelease(current, releases, seenVersion) {
  const list = usableReleases(releases);
  const latestItem = list[0] || null;
  const latest = latestItem ? latestItem.version : null;
  const url = latestItem ? latestItem.url : RELEASE_PAGE;
  const hasUpdate = Boolean(latest) && (compareVersions(latest, current) || 0) > 0;
  const announce = announceFor(current, latest, seenVersion);

  // 公告正文按「用户实际跨过的版本」取，而不是永远取最新那条：
  // 有新版装 → (current, latest]；刚升级完 → (seen, current]。
  // 这样标题的版本号和正文永远是同一批版本，不会再出现标题 1.2.0、正文 1.2.1。
  let announceReleases = [];
  if (announce === 'available') {
    announceReleases = rangeReleases(list, current, latest);
  } else if (announce === 'updated') {
    announceReleases = rangeReleases(list, seenVersion, current);
  }

  // 手动检查是用户主动发起的，即使 announce 判定为 null（比如之前已经点过「稍后」，
  // seenVersion 已经等于新版本），也要能拿到这次更新包含哪些版本。
  const availableReleases = hasUpdate ? rangeReleases(list, current, latest) : [];

  return {
    ok: true,
    current,
    latest,
    hasUpdate,
    url,
    // 兼容旧字段：设置面板只用它判断「有没有说明」，公告已经改用 releases
    notes: announceReleases.length ? announceReleases[0].notes : '',
    releases: announceReleases,
    availableReleases,
    announce,
  };
}

let cache = null;
let inflight = null;

// 供测试清空缓存，避免用例之间互相污染
function resetCache() {
  cache = null;
  inflight = null;
}

// 限流响应带 X-RateLimit-Reset（Unix 秒）。剩余时间太短或头缺失时退回笼统提示，
// 免得算出「0 分钟后」这种没意义的文案。
function rateLimitMessage(response) {
  const raw = response.headers && response.headers.get
    ? response.headers.get('x-ratelimit-reset')
    : null;
  const resetAt = Number(raw) * 1000;
  if (!Number.isFinite(resetAt) || resetAt <= 0) {
    return 'GitHub 接口请求过于频繁，请稍后再试';
  }
  const waitMinutes = Math.ceil((resetAt - Date.now()) / 60000);
  if (waitMinutes <= 0) return 'GitHub 接口请求过于频繁，请稍后再试';
  if (waitMinutes > 60) return 'GitHub 接口请求过于频繁，请稍后再试';
  return `GitHub 接口请求过于频繁，约 ${waitMinutes} 分钟后自动恢复`;
}

async function fetchLatest(fetchImpl) {
  const response = await fetchImpl(API_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'CmdToolbox',
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status === 404) {
    // 仓库名写错返回 404；「还没发过 Release」走的是空数组分支
    console.warn(`[updates] ${REPO} 仓库不存在（404），检查仓库名是否填写正确`);
    return [];
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(rateLimitMessage(response));
  }
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

async function checkForUpdate(current, seenVersion, fetchImpl = defaultFetch) {
  if (process.env.CMDTOOLBOX_NO_UPDATE === '1') {
    return { ok: false, message: '已通过环境变量关闭更新检查' };
  }

  if (cache && Date.now() - cache.at < CACHE_TTL) {
    // 缓存存原始列表：announce 要按调用方本次的 seenVersion 重算
    return evaluateRelease(current, cache.releases, seenVersion);
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const releases = await fetchLatest(fetchImpl);
        cache = { at: Date.now(), releases };
        return evaluateRelease(current, releases, null);
      } catch (error) {
        if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
          return { ok: false, message: '检查更新超时，请确认网络可以访问 GitHub' };
        }
        return { ok: false, message: error && error.message ? error.message : '检查更新失败' };
      } finally {
        inflight = null;
      }
    })();
  }

  const result = await inflight;
  if (!result.ok) return result;
  // 公告判定始终按调用方传入的 seenVersion 现算
  return evaluateRelease(current, cache ? cache.releases : [], seenVersion);
}

module.exports = {
  REPO,
  parseVersion,
  compareVersions,
  evaluateRelease,
  announceFor,
  rangeReleases,
  checkForUpdate,
  resetCache,
};
