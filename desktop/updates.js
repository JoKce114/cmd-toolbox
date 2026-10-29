// 发布仓库只在这里写一次，渲染层和其它模块都不要重复硬编码
const REPO = 'JoKce114/cmd-toolbox';
const API_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases`;
const TIMEOUT_MS = 8000;
const CACHE_TTL = 5 * 60 * 1000;
const NOTES_LIMIT = 600;

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

function evaluateRelease(current, release, seenVersion) {
  const latest = release && release.tag_name ? String(release.tag_name) : null;
  const url = (release && release.html_url) || RELEASE_PAGE;
  const raw = release && typeof release.body === 'string' ? release.body.trim() : '';
  const notes = raw.length > NOTES_LIMIT ? `${raw.slice(0, NOTES_LIMIT)}…` : raw;
  const hasUpdate = Boolean(latest) && (compareVersions(latest, current) || 0) > 0;

  return {
    ok: true,
    current,
    latest,
    hasUpdate,
    url,
    notes,
    announce: announceFor(current, latest, seenVersion),
  };
}

let cache = null;
let inflight = null;

// 供测试清空缓存，避免用例之间互相污染
function resetCache() {
  cache = null;
  inflight = null;
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
    // 仓库名写错和「还没发过 Release」返回一样，留一条日志便于区分排查
    console.warn(`[updates] ${REPO} 没有可用的 Release（404），检查仓库名是否填写正确`);
    return null;
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error('GitHub 接口请求过于频繁，请稍后再试');
  }
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  return response.json();
}

async function checkForUpdate(current, seenVersion, fetchImpl = defaultFetch) {
  if (process.env.CMDTOOLBOX_NO_UPDATE === '1') {
    return { ok: false, message: '已通过环境变量关闭更新检查' };
  }

  if (cache && Date.now() - cache.at < CACHE_TTL) {
    return { ...cache.result, announce: announceFor(current, cache.result.latest, seenVersion) };
  }

  if (!inflight) {
    inflight = (async () => {
      try {
        const release = await fetchLatest(fetchImpl);
        const result = evaluateRelease(current, release, null);
        cache = { at: Date.now(), result };
        return result;
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
  // 缓存里存的是不带 announce 的结果，公告判定始终按调用方传入的 seenVersion 现算
  return { ...result, announce: announceFor(current, result.latest, seenVersion) };
}

module.exports = {
  REPO,
  parseVersion,
  compareVersions,
  evaluateRelease,
  announceFor,
  checkForUpdate,
  resetCache,
};
