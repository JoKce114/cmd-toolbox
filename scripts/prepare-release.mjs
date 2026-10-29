import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// 发版前的一站式准备：
// 1. 从 CHANGELOG.md 抽出当前版本的更新说明（粘到 GitHub Release 说明栏）
// 2. 把需要上传的附件集中到 release/upload/，一次全选拖进 "Attach binaries"

const root = resolve(import.meta.dirname, '..');
const releaseDir = resolve(root, 'release');
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const version = pkg.version;
const changelogPath = resolve(root, 'CHANGELOG.md');
const today = new Date().toISOString().slice(0, 10);

const CHANGELOG_HEADER = '# 更新日志\n';
const EMPTY_SECTION_MARK = '（待填写）';

// 这些是构建过程产物，不属于要上传的附件
const NOT_FOR_UPLOAD = new Set(['builder-debug.yml']);

function emptySection() {
  return [
    `## [${version}] - ${today}`,
    '',
    '### 新增',
    '',
    `- ${EMPTY_SECTION_MARK}`,
    '',
    '### 修复',
    '',
    `- ${EMPTY_SECTION_MARK}`,
    '',
    '### 说明',
    '',
    `- ${EMPTY_SECTION_MARK}`,
    '',
  ].join('\n');
}

// 取从 "## [x.y.z]" 开始到下一个二级标题之前的内容
function extractSection(text, target) {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const heading = new RegExp(`^## \\[${escaped}\\][^\\n]*$`, 'm');
  const match = heading.exec(text);
  if (!match) return null;

  const start = match.index;
  const rest = text.slice(start + match[0].length);
  const next = /\n## \[/.exec(rest);
  const body = next ? rest.slice(0, next.index) : rest;
  return `${match[0]}${body}`.trim();
}

function ensureSection(text) {
  if (extractSection(text, version)) return { text, created: false };
  // 插在开头的说明文字之后、第一个版本小节之前，新人永远在最上面
  const firstHeading = /^## \[/m.exec(text);
  const insertAt = firstHeading ? firstHeading.index : text.length;
  const head = text.slice(0, insertAt).replace(/\s+$/, '');
  const tail = text.slice(insertAt).replace(/^\s+/, '');
  const next = `${head}\n\n${emptySection()}${tail ? `\n${tail}` : ''}`;
  return { text: next, created: true };
}

let changelog = existsSync(changelogPath)
  ? readFileSync(changelogPath, 'utf8')
  : `${CHANGELOG_HEADER}\n`;

const { text: updated, created } = ensureSection(changelog);
if (created) {
  writeFileSync(changelogPath, updated, 'utf8');
  changelog = updated;
  console.log(`CHANGELOG.md 已补充 ${version} 的空模板：${changelogPath}`);
}

const section = extractSection(changelog, version);
if (!section) {
  console.error(`无法从 CHANGELOG.md 抽取 ${version} 的更新说明`);
  process.exit(1);
}

mkdirSync(releaseDir, { recursive: true });
const notesPath = resolve(releaseDir, `更新说明-v${version}.md`);
writeFileSync(notesPath, `${section}\n`, 'utf8');
console.log(`已生成 ${notesPath}`);

if (section.includes(EMPTY_SECTION_MARK)) {
  console.warn('! 这份说明还是空模板，记得先在 CHANGELOG.md 里补内容再重新打包');
}

// ---- 整理附件 ----

const uploadDir = resolve(releaseDir, 'upload');
rmSync(uploadDir, { recursive: true, force: true });
mkdirSync(uploadDir, { recursive: true });

const entries = readdirSync(releaseDir).filter((name) => {
  if (name === 'upload' || name === 'win-unpacked') return false;
  if (NOT_FOR_UPLOAD.has(name) || name.endsWith('.md')) return false;
  return statSync(resolve(releaseDir, name)).isFile();
});

if (!entries.length) {
  console.error('release/ 里没有可上传的文件，先运行 npm run dist');
  process.exit(1);
}

for (const name of entries) {
  copyFileSync(resolve(releaseDir, name), resolve(uploadDir, name));
}

const mb = (name) =>
  (statSync(resolve(uploadDir, name)).size / 1024 / 1024).toFixed(1) + ' MB';

console.log(`\n已整理 ${uploadDir}`);
for (const name of entries) console.log(`  ${name}  (${mb(name)})`);

const hasManifest = entries.includes('latest.yml');
console.log('\n发版步骤：');
console.log(`  1. tag 用 v${version}`);
console.log('  2. 打开 release/upload 文件夹，Ctrl+A 全选后拖进 Attach binaries');
console.log(`  3. Release 说明栏粘贴 ${notesPath} 的内容`);
if (!hasManifest) {
  console.warn('! 没有 latest.yml，自动更新会失效，请确认这次构建是否正常结束');
}
