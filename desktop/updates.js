const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

// 发布仓库只在这里写一次，渲染层和其它模块都不要重复硬编码
const REPO = 'JoKce114/cmd-toolbox';
// 端到端测试用本地假接口时覆盖这两个地址
const API_URL =
  process.env.CMDTOOLBOX_UPDATE_API ||
  `https://api.github.com/repos/${REPO}/releases?per_page=30`;
// latest.yml 是 Release 的静态附件，走 CDN，不消耗 REST API 的每小时配额
const YML_URL =
  process.env.CMDTOOLBOX_UPDATE_YML ||
  `https://github.com/${REPO}/releases/latest/download/latest.yml`;
const RELEASE_PAGE = `https://github.com/${REPO}/releases`;
const RELEASE_TAG_BASE = `https://github.com/${REPO}/releases/tag`;
const TIMEOUT_MS = 8000;
const CACHE_TTL = 5 * 60 * 1000;
// API 结果在磁盘上留一天，限流或断网时拿它顶替，至少说明还能看
const STALE_TTL = 24 * 60 * 60 * 1000;
// 限流响应没带 X-RateLimit-Reset 时，按这个间隔退避
const RATE_LIMIT_FALLBACK_MS = 15 * 60 * 1000;
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
// 被 GitHub 限流时记下恢复时刻，到点前不再打 API
let blockedUntil = 0;
let cacheFile = null;
let hydrated = false;

// cacheFile 由主进程在 userData 下指定；单测可以指向临时文件或保持为空
function configure(options = {}) {
  const next = options.cacheFile || null;
  if (next === cacheFile) return;
  cacheFile = next;
  hydrated = false;
}

// 测试模拟「重启应用」时传 keepDisk: true，只清内存
function resetCache(options = {}) {
  cache = null;
  inflight = null;
  blockedUntil = 0;
  hydrated = false;
  if (!options.keepDisk && cacheFile) {
    try {
      fs.unlinkSync(cacheFile);
    } catch {
      // 文件不存在或删不掉都不影响后续请求
    }
  }
}

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  if (!cacheFile) return;
  try {
    const data = JSON.parse(await fsp.readFile(cacheFile, 'utf8'));
    if (Array.isArray(data.releases) && data.releases.length) {
      cache = { at: Number(data.at) || 0, releases: data.releases };
    }
    if (Number.isFinite(data.blockedUntil) && data.blockedUntil > Date.now()) {
      blockedUntil = data.blockedUntil;
    }
  } catch {
    // 首次运行或文件损坏：当作没有缓存
  }
}

async function persist() {
  if (!cacheFile) return;
  try {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true });
    await fsp.writeFile(
      cacheFile,
      JSON.stringify({
        at: cache ? cache.at : 0,
        releases: cache ? cache.releases : [],
        blockedUntil,
      }),
      'utf8',
    );
  } catch {
    // 缓存写不进去不影响本次结果，下次重新拉取即可
  }
}

// 限流响应带 X-RateLimit-Reset（Unix 秒）。剩余时间太短或头缺失时退回笼统提示，
// 免得算出「0 分钟后」这种没意义的文案。
function rateLimitMessage(resetAt) {
  const waitMinutes = Math.ceil((resetAt - Date.now()) / 60000);
  if (!Number.isFinite(waitMinutes) || waitMinutes <= 0) {
    return 'GitHub 接口请求过于频繁，请稍后再试';
  }
  if (waitMinutes > 60) return 'GitHub 接口请求过于频繁，请稍后再试';
  return `GitHub 接口请求过于频繁，约 ${waitMinutes} 分钟后自动恢复`;
}

function rateLimitState(response) {
  const readHeader = (name) =>
    response.headers && response.headers.get ? response.headers.get(name) : null;

  const retryAfter = Number(readHeader('retry-after'));
  const resetAt = Number(readHeader('x-ratelimit-reset')) * 1000;
  const now = Date.now();

  // 头缺失或已经过期时，文案回退成笼统提示，但内部仍退避一段时间
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    const until = now + retryAfter * 1000;
    return { until, message: rateLimitMessage(until) };
  }
  if (Number.isFinite(resetAt) && resetAt > now) {
    return { until: resetAt, message: rateLimitMessage(resetAt) };
  }
  return { until: now + RATE_LIMIT_FALLBACK_MS, message: rateLimitMessage(Number.NaN) };
}

// latest.yml 只需要 version 那一行，不为了一个字段引入 YAML 依赖
function ymlVersion(text) {
  const match = /^\s*version:\s*["']?([^"'\s#]+)/m.exec(String(text || ''));
  return match ? match[1] : null;
}

async function probeLatest(fetchImpl) {
  const response = await fetchImpl(YML_URL, {
    headers: { 'User-Agent': 'CmdToolbox' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return null;
  const text = typeof response.text === 'function' ? await response.text() : '';
  const version = ymlVersion(text);
  if (!version || parseVersion(version) === null) return null;
  const tag = /^v/i.test(version) ? version : `v${version}`;
  return { tag, url: `${RELEASE_TAG_BASE}/${tag}` };
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
    const limit = rateLimitState(response);
    throw Object.assign(new Error(limit.message), { rateLimitUntil: limit.until });
  }
  if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload) ? payload : [];
}

function describeFetchError(error) {
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return '检查更新超时，请确认网络可以访问 GitHub';
  }
  return error && error.message ? error.message : '检查更新失败';
}

// 只发一次请求，并发调用共享同一个 inflight
function fetchReleasesOnce(fetchImpl) {
  if (!inflight) {
    inflight = (async () => {
      try {
        const releases = await fetchLatest(fetchImpl);
        cache = { at: Date.now(), releases };
        await persist();
        return { ok: true, releases, at: cache.at };
      } catch (error) {
        if (error && error.rateLimitUntil) {
          blockedUntil = error.rateLimitUntil;
          await persist();
        }
        return { ok: false, message: describeFetchError(error) };
      } finally {
        inflight = null;
      }
    })();
  }
  return inflight;
}

async function loadReleaseList(fetchImpl) {
  if (cache && Date.now() - cache.at < CACHE_TTL) {
    return { releases: cache.releases, at: cache.at, error: null };
  }

  const staleUsable = cache && Date.now() - cache.at < STALE_TTL;
  const stale = () =>
    staleUsable ? { releases: cache.releases, at: cache.at } : { releases: null, at: null };

  if (blockedUntil > Date.now()) {
    return { ...stale(), error: rateLimitMessage(blockedUntil) };
  }

  const result = await fetchReleasesOnce(fetchImpl);
  if (result.ok) return { releases: result.releases, at: result.at, error: null };
  return { ...stale(), error: result.message };
}

// 只在「确实要展示说明」时才查 API：有新版，或刚升级完要看改了什么
function needsReleaseNotes(current, latest, seenVersion) {
  if (!latest) return true;
  if ((compareVersions(latest, current) || 0) > 0) return true;
  return announceFor(current, latest, seenVersion) === 'updated';
}

function probeResult(current, probe, seenVersion) {
  const hasUpdate = (compareVersions(probe.tag, current) || 0) > 0;
  return {
    ok: true,
    current,
    latest: probe.tag,
    hasUpdate,
    url: probe.url,
    notes: '',
    releases: [],
    availableReleases: [],
    // 拿不到说明时不弹「已更新到」这种空公告
    announce: hasUpdate ? announceFor(current, probe.tag, seenVersion) : null,
    ymlOnly: true,
  };
}

async function checkForUpdate(current, seenVersion, fetchImpl = defaultFetch) {
  if (process.env.CMDTOOLBOX_NO_UPDATE === '1') {
    return { ok: false, message: '已通过环境变量关闭更新检查' };
  }

  await hydrate();

  if (cache && Date.now() - cache.at < CACHE_TTL) {
    // 缓存存原始列表：announce 要按调用方本次的 seenVersion 重算
    return evaluateRelease(current, cache.releases, seenVersion);
  }

  // latest.yml 不占 API 配额，先用它判断「到底有没有新版」
  let probe = null;
  try {
    probe = await probeLatest(fetchImpl);
  } catch {
    probe = null;
  }

  if (probe && !needsReleaseNotes(current, probe.tag, seenVersion)) {
    // 磁盘里可能留着比 latest.yml 更新的列表（yml 没同步），取较高版本
    if (cache && Date.now() - cache.at < STALE_TTL) {
      const cached = evaluateRelease(current, cache.releases, seenVersion);
      if (cached.hasUpdate) return { ...cached, stale: true };
    }
    return probeResult(current, probe, seenVersion);
  }

  const loaded = await loadReleaseList(fetchImpl);

  if (loaded.releases) {
    const result = evaluateRelease(current, loaded.releases, seenVersion);
    const stale = Date.now() - loaded.at > CACHE_TTL;
    return loaded.error
      ? { ...result, stale, warning: loaded.error }
      : stale
        ? { ...result, stale }
        : result;
  }

  // API 打不通（限流/断网）但 latest.yml 拿到了结论：至少还能告诉用户有没有新版
  if (probe) return { ...probeResult(current, probe, seenVersion), warning: loaded.error };
  return { ok: false, message: loaded.error || '检查更新失败' };
}

module.exports = {
  REPO,
  parseVersion,
  compareVersions,
  evaluateRelease,
  announceFor,
  rangeReleases,
  checkForUpdate,
  configure,
  resetCache,
};
