import type { LucideIcon } from 'lucide-react';
import {
  Database,
  File,
  FileArchive,
  FileCode2,
  FileJson,
  FileText,
  Hash,
  Image,
  Settings,
} from 'lucide-react';

export type FileIconSpec = {
  Icon: LucideIcon;
  color: string;
};

const DEFAULT_ICON: FileIconSpec = { Icon: File, color: '#9aa0a6' };

// 只按大类区分，够认出「这是配置文件 / 样式 / 脚本」即可，不追求与 VS Code 完全一致
const BY_EXTENSION: Record<string, FileIconSpec> = {
  json: { Icon: FileJson, color: '#d9a825' },
  jsonc: { Icon: FileJson, color: '#d9a825' },
  php: { Icon: FileCode2, color: '#8b7cf6' },
  js: { Icon: FileCode2, color: '#e0a91a' },
  mjs: { Icon: FileCode2, color: '#e0a91a' },
  cjs: { Icon: FileCode2, color: '#e0a91a' },
  jsx: { Icon: FileCode2, color: '#e0a91a' },
  ts: { Icon: FileCode2, color: '#3178c6' },
  tsx: { Icon: FileCode2, color: '#3178c6' },
  vue: { Icon: FileCode2, color: '#41b883' },
  html: { Icon: FileCode2, color: '#e44d26' },
  htm: { Icon: FileCode2, color: '#e44d26' },
  css: { Icon: Hash, color: '#4aa8e0' },
  scss: { Icon: Hash, color: '#d05f8f' },
  sass: { Icon: Hash, color: '#d05f8f' },
  less: { Icon: Hash, color: '#4a6bd0' },
  styl: { Icon: Hash, color: '#4a6bd0' },
  md: { Icon: FileText, color: '#519aba' },
  markdown: { Icon: FileText, color: '#519aba' },
  txt: { Icon: FileText, color: '#9aa0a6' },
  log: { Icon: FileText, color: '#9aa0a6' },
  sql: { Icon: Database, color: '#e38c00' },
  yml: { Icon: Settings, color: '#a074c4' },
  yaml: { Icon: Settings, color: '#a074c4' },
  toml: { Icon: Settings, color: '#a074c4' },
  ini: { Icon: Settings, color: '#a074c4' },
  conf: { Icon: Settings, color: '#a074c4' },
  config: { Icon: Settings, color: '#a074c4' },
  cfg: { Icon: Settings, color: '#a074c4' },
  properties: { Icon: Settings, color: '#a074c4' },
  xml: { Icon: Settings, color: '#a074c4' },
  env: { Icon: Settings, color: '#a074c4' },
  png: { Icon: Image, color: '#4caf50' },
  jpg: { Icon: Image, color: '#4caf50' },
  jpeg: { Icon: Image, color: '#4caf50' },
  gif: { Icon: Image, color: '#4caf50' },
  webp: { Icon: Image, color: '#4caf50' },
  svg: { Icon: Image, color: '#c9a227' },
  ico: { Icon: Image, color: '#4caf50' },
  zip: { Icon: FileArchive, color: '#b08050' },
  gz: { Icon: FileArchive, color: '#b08050' },
  rar: { Icon: FileArchive, color: '#b08050' },
  '7z': { Icon: FileArchive, color: '#b08050' },
  sh: { Icon: FileCode2, color: '#4caf50' },
  bat: { Icon: FileCode2, color: '#4caf50' },
  cmd: { Icon: FileCode2, color: '#4caf50' },
  ps1: { Icon: FileCode2, color: '#4a8fd0' },
};

// 无扩展名或扩展名有歧义的文件靠名字认
const BY_NAME: Record<string, FileIconSpec> = {
  dockerfile: { Icon: Settings, color: '#4a8fd0' },
  'docker-compose.yml': { Icon: Settings, color: '#4a8fd0' },
  'docker-compose.yaml': { Icon: Settings, color: '#4a8fd0' },
  '.gitignore': { Icon: FileText, color: '#9aa0a6' },
  '.gitattributes': { Icon: FileText, color: '#9aa0a6' },
  '.editorconfig': { Icon: Settings, color: '#a074c4' },
  '.env': { Icon: Settings, color: '#a074c4' },
  '.env.local': { Icon: Settings, color: '#a074c4' },
  '.env.example': { Icon: Settings, color: '#a074c4' },
  '.npmrc': { Icon: Settings, color: '#a074c4' },
  '.babelrc': { Icon: Settings, color: '#a074c4' },
  '.eslintrc': { Icon: Settings, color: '#a074c4' },
  '.prettierrc': { Icon: Settings, color: '#a074c4' },
  '.htaccess': { Icon: Settings, color: '#a074c4' },
  makefile: { Icon: Settings, color: '#9aa0a6' },
  license: { Icon: FileText, color: '#9aa0a6' },
  readme: { Icon: FileText, color: '#519aba' },
};

export function fileIconFor(relPath: string): FileIconSpec {
  const name = (relPath.split(/[\\/]/).pop() || '').toLowerCase();
  const byName = BY_NAME[name];
  if (byName) return byName;
  const dot = name.lastIndexOf('.');
  // dot 为 0 是以点开头的隐藏文件（如 .gitignore），没有扩展名可用
  if (dot <= 0) return DEFAULT_ICON;
  return BY_EXTENSION[name.slice(dot + 1)] ?? DEFAULT_ICON;
}

export function FileTypeIcon({ path, size = 13 }: { path: string; size?: number }) {
  const { Icon, color } = fileIconFor(path);
  return (
    <Icon
      className="file-type-icon"
      size={size}
      color={color}
      strokeWidth={1.8}
      aria-hidden={true}
    />
  );
}
