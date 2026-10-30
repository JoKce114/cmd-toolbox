// 内置浏览器的移动端模拟。只用前端能力：把 <webview> 元素设成设备尺寸，
// CSS 视口随之变化；UA 用 webview 自带的 setUserAgent。
// 不要改用 webContents.enableDeviceEmulation —— 实测在 webview 上会缩放视口
// （375×667 变成 innerWidth=981），见 tests/device-emulation-probe.mjs。

export type DeviceProfile = {
  presetId: string;
  width: number;
  height: number;
  rotated: boolean;
};

export type DevicePreset = {
  id: string;
  label: string;
  width: number;
  height: number;
  group: DeviceGroupId;
};

export type DeviceGroupId = 'mobile' | 'foldable' | 'tablet' | 'display';

export const DEVICE_GROUPS: Array<{ id: DeviceGroupId; label: string }> = [
  { id: 'mobile', label: '手机' },
  { id: 'foldable', label: '折叠屏' },
  { id: 'tablet', label: '平板与桌面' },
  { id: 'display', label: '智能屏' },
];

// 尺寸取 Chrome DevTools 设备列表的 CSS 逻辑像素（竖屏为默认朝向）。
export const DEVICE_PRESETS: DevicePreset[] = [
  { id: 'iphone-se', label: 'iPhone SE', width: 375, height: 667, group: 'mobile' },
  { id: 'iphone-16', label: 'iPhone 16', width: 393, height: 852, group: 'mobile' },
  {
    id: 'iphone-16-pro-max',
    label: 'iPhone 16 Pro Max',
    width: 440,
    height: 956,
    group: 'mobile',
  },
  { id: 'pixel-9', label: 'Pixel 9', width: 412, height: 923, group: 'mobile' },
  { id: 'pixel-9-pro', label: 'Pixel 9 Pro', width: 428, height: 952, group: 'mobile' },
  { id: 'pixel-10', label: 'Pixel 10', width: 412, height: 923, group: 'mobile' },
  {
    id: 'galaxy-a55',
    label: 'Samsung Galaxy A55',
    width: 412,
    height: 892,
    group: 'mobile',
  },
  {
    id: 'pixel-9-pro-fold',
    label: 'Pixel 9 Pro Fold',
    width: 673,
    height: 841,
    group: 'foldable',
  },
  {
    id: 'galaxy-z-fold-6',
    label: 'Galaxy Z Fold 6',
    width: 742,
    height: 864,
    group: 'foldable',
  },
  { id: 'ipad-mini', label: 'iPad mini', width: 768, height: 1024, group: 'tablet' },
  { id: 'ipad-pro-13', label: 'iPad Pro 13"', width: 1032, height: 1376, group: 'tablet' },
  {
    id: 'surface-pro-10',
    label: 'Surface Pro 10',
    width: 1440,
    height: 960,
    group: 'tablet',
  },
  { id: 'nest-hub-max', label: 'Nest Hub Max', width: 1280, height: 800, group: 'display' },
];

export const DEVICE_MIN_WIDTH = 240;
export const DEVICE_MAX_WIDTH = 1920;
export const DEVICE_MIN_HEIGHT = 320;
export const DEVICE_MAX_HEIGHT = 2400;

export const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

function clamp(value: number, min: number, max: number) {
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function resolveViewSize(profile: DeviceProfile): { width: number; height: number } {
  const width = clamp(profile.width, DEVICE_MIN_WIDTH, DEVICE_MAX_WIDTH);
  const height = clamp(profile.height, DEVICE_MIN_HEIGHT, DEVICE_MAX_HEIGHT);
  return profile.rotated ? { width: height, height: width } : { width, height };
}

export function presetById(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find((preset) => preset.id === id);
}

export function presetsByGroup(group: DeviceGroupId): DevicePreset[] {
  return DEVICE_PRESETS.filter((preset) => preset.group === group);
}

export function deviceLabel(profile: DeviceProfile): string {
  const size = resolveViewSize(profile);
  const base =
    profile.presetId === 'custom'
      ? '自定义'
      : presetById(profile.presetId)?.label || '自定义';
  return `${base} ${size.width}×${size.height}`;
}

export function clampDeviceProfile(input: unknown): DeviceProfile | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as Partial<DeviceProfile>;
  const width = Number(source.width);
  const height = Number(source.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  const presetId =
    typeof source.presetId === 'string' && (source.presetId === 'custom' || presetById(source.presetId))
      ? source.presetId
      : 'custom';
  return {
    presetId,
    width: clamp(width, DEVICE_MIN_WIDTH, DEVICE_MAX_WIDTH),
    height: clamp(height, DEVICE_MIN_HEIGHT, DEVICE_MAX_HEIGHT),
    rotated: Boolean(source.rotated),
  };
}
