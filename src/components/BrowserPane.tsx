import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Minus,
  Plus,
  RotateCw,
  Search,
  Smartphone,
  Star,
  X,
} from 'lucide-react';
import { normalizeHttpUrl, toErrorMessage } from '../lib';
import {
  DEVICE_GROUPS,
  MOBILE_UA,
  clampDeviceProfile,
  deviceLabel,
  presetsByGroup,
  resolveViewSize,
  type DeviceProfile,
} from '../deviceProfiles';
import type { Group, MenuEntry, Tab } from '../types';
import type { ToastKind } from './Toast';
import { Modal } from './Modal';
import { PopupMenu } from './PopupMenu';

type BrowserPaneProps = {
  tab: Tab;
  group: Group;
  active: boolean;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onUrlChange: (tabId: string, url: string) => void;
  onDeviceChange: (tabId: string, device: DeviceProfile | null) => void;
};

export function BrowserPane({
  tab,
  group,
  active,
  onClose,
  onToast,
  onUrlChange,
  onDeviceChange,
}: BrowserPaneProps) {
  const viewRef = useRef<HTMLWebViewElement | null>(null);
  const toastRef = useRef(onToast);
  const onUrlChangeRef = useRef(onUrlChange);
  const onDeviceChangeRef = useRef(onDeviceChange);
  const initialSrc = useRef(tab.url && tab.url !== 'about:blank' ? tab.url : 'about:blank');
  const [address, setAddress] = useState(tab.url && tab.url !== 'about:blank' ? tab.url : '');
  const [loading, setLoading] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [bookmarks, setBookmarks] = useState<Array<{ title: string; url: string }>>(() => {
    try {
      const raw = window.localStorage.getItem('cmd-toolbox.bookmarks');
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const findInputRef = useRef<HTMLInputElement>(null);
  const [device, setDevice] = useState<DeviceProfile | null>(() =>
    clampDeviceProfile(tab.device),
  );
  const [deviceMenu, setDeviceMenu] = useState<{
    x: number;
    y: number;
    items: MenuEntry[];
  } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [customWidth, setCustomWidth] = useState('500');
  const [customHeight, setCustomHeight] = useState('900');
  const zoomBeforeDevice = useRef(1);
  const deviceRef = useRef<DeviceProfile | null>(device);

  toastRef.current = onToast;
  onUrlChangeRef.current = onUrlChange;
  onDeviceChangeRef.current = onDeviceChange;
  deviceRef.current = device;

  useEffect(() => {
    if (!findOpen) return;
    findInputRef.current?.focus();
    findInputRef.current?.select();
  }, [findOpen]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    const syncUrl = (url: string) => {
      if (!url || url === 'about:blank') {
        setAddress('');
        onUrlChangeRef.current(tab.id, 'about:blank');
        return;
      }
      setAddress(url);
      onUrlChangeRef.current(tab.id, url);
    };

    const handleNavigate = (event: Event) => {
      const url = (event as Event & { url?: string }).url || view.getURL();
      syncUrl(url);
    };
    const handleStart = () => setLoading(true);
    const handleStop = () => {
      setLoading(false);
      syncUrl(view.getURL());
    };
    const handleFail = (event: Event) => {
      const detail = event as Event & { errorCode?: number; isMainFrame?: boolean };
      if (detail.errorCode === -3 || detail.isMainFrame === false) return;
      setLoading(false);
      toastRef.current('网页加载失败', 'error');
    };
    const handleAttach = () => {
      try {
        window.api.panes.attachBrowser(tab.id, view.getWebContentsId());
        syncDeviceToView(view, deviceRef.current);
      } catch {
        // guest not ready
      }
    };

    view.addEventListener('did-navigate', handleNavigate);
    view.addEventListener('did-navigate-in-page', handleNavigate);
    view.addEventListener('did-start-loading', handleStart);
    view.addEventListener('did-stop-loading', handleStop);
    view.addEventListener('did-fail-load', handleFail);
    view.addEventListener('did-attach', handleAttach);
    if (typeof view.getWebContentsId === 'function') {
      try {
        handleAttach();
      } catch {
        // wait for did-attach
      }
    }
    return () => {
      view.removeEventListener('did-navigate', handleNavigate);
      view.removeEventListener('did-navigate-in-page', handleNavigate);
      view.removeEventListener('did-start-loading', handleStart);
      view.removeEventListener('did-stop-loading', handleStop);
      view.removeEventListener('did-fail-load', handleFail);
      view.removeEventListener('did-attach', handleAttach);
    };
  }, [tab.id]);

  const applyZoom = (next: number) => {
    const value = Math.min(1.8, Math.max(0.6, Math.round(next * 10) / 10));
    setZoom(value);
    try {
      viewRef.current?.setZoomFactor(value);
    } catch {
      // guest not ready
    }
  };

  // 设备模拟只改 webview 元素尺寸和 UA，不碰主进程。
  const syncDeviceToView = (view: HTMLWebViewElement, next: DeviceProfile | null) => {
    if (!next) {
      view.style.width = '';
      view.style.height = '';
      view.style.flex = '';
      try {
        view.setUserAgent('');
        view.setZoomFactor(zoomBeforeDevice.current);
      } catch {
        // guest not ready
      }
      return;
    }
    const size = resolveViewSize(next);
    view.style.width = `${size.width}px`;
    view.style.height = `${size.height}px`;
    view.style.flex = '0 0 auto';
    try {
      view.setZoomFactor(1);
      view.setUserAgent(MOBILE_UA);
    } catch {
      // guest not ready
    }
  };

  const applyDevice = (next: DeviceProfile | null) => {
    if (next && !device) zoomBeforeDevice.current = zoom;
    setDevice(next);
    onDeviceChangeRef.current(tab.id, next);
    setZoom(next ? 1 : zoomBeforeDevice.current);
    const view = viewRef.current;
    if (view) syncDeviceToView(view, next);
  };

  const openDeviceMenu = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const items: MenuEntry[] = [
      {
        type: 'item',
        id: 'device-desktop',
        label: '桌面',
        disabled: !device,
        title: '按窗口宽度渲染',
        onSelect: () => applyDevice(null),
      },
      { type: 'separator', id: 'device-sep' },
      ...DEVICE_GROUPS.flatMap<MenuEntry>((group) => [
        { type: 'label', id: `device-group-${group.id}`, label: group.label },
        ...presetsByGroup(group.id).map<MenuEntry>((preset) => {
          const isCurrent = device?.presetId === preset.id;
          return {
            type: 'item',
            id: `device-${preset.id}`,
            label: preset.label,
            shortcut: isCurrent ? `${preset.width}×${preset.height}` : undefined,
            onSelect: () =>
              applyDevice({
                presetId: preset.id,
                width: preset.width,
                height: preset.height,
                rotated: false,
              }),
          };
        }),
      ]),
      { type: 'separator', id: 'device-sep-2' },
      {
        type: 'item',
        id: 'device-rotate',
        label: device?.rotated ? '切换为竖屏' : '切换为横屏',
        disabled: !device,
        onSelect: () => device && applyDevice({ ...device, rotated: !device.rotated }),
      },
      {
        type: 'item',
        id: 'device-custom',
        label: '自定义尺寸…',
        onSelect: () => {
          if (device) {
            setCustomWidth(String(device.width));
            setCustomHeight(String(device.height));
          }
          setCustomOpen(true);
        },
      },
    ];
    setDeviceMenu({ x: rect.left, y: rect.bottom + 4, items });
  };

  const submitCustomDevice = () => {
    const width = Number(customWidth);
    const height = Number(customHeight);
    const profile = clampDeviceProfile({
      presetId: 'custom',
      width,
      height,
      rotated: device?.rotated ?? false,
    });
    if (!profile) {
      toastRef.current('请输入有效的宽高', 'error');
      return;
    }
    setCustomOpen(false);
    applyDevice(profile);
  };

  const starred = Boolean(address && bookmarks.some((item) => item.url === address));

  const toggleBookmark = () => {
    if (!address || address === 'about:blank') {
      toastRef.current('还没有可收藏的网址', 'error');
      return;
    }
    const next = starred
      ? bookmarks.filter((item) => item.url !== address)
      : [...bookmarks, { title: address, url: address }];
    setBookmarks(next);
    window.localStorage.setItem('cmd-toolbox.bookmarks', JSON.stringify(next));
  };

  const go = (raw: string) => {
    const url = normalizeHttpUrl(raw);
    if (!url) {
      toastRef.current('只支持 http 或 https 地址', 'error');
      return;
    }
    try {
      viewRef.current?.loadURL(url);
    } catch (error) {
      toastRef.current(toErrorMessage(error), 'error');
    }
  };

  return (
    <section
      className={`terminal-pane browser-pane${active ? '' : ' is-hidden'}`}
      aria-hidden={!active}
      onKeyDown={(event) => {
        if (!active) return;
        if (event.ctrlKey && event.key.toLowerCase() === 'f') {
          event.preventDefault();
          setFindOpen(true);
          return;
        }
        // 焦点在网页内部时由主进程的 before-input-event 接管，这里是地址栏/工具栏的兜底
        const reloadKey =
          event.key === 'F5' || (event.ctrlKey && event.key.toLowerCase() === 'r');
        if (reloadKey) {
          event.preventDefault();
          try {
            if (event.shiftKey) viewRef.current?.reloadIgnoringCache();
            else viewRef.current?.reload();
          } catch {
            // guest not ready
          }
        }
      }}
    >
      <header className="pane-header browser-header">
        <span className="pane-dot" style={{ backgroundColor: group.color }} />
        <button
          type="button"
          className="browser-nav"
          title="后退"
          onClick={() => viewRef.current?.goBack()}
        >
          <ArrowLeft size={14} />
        </button>
        <button
          type="button"
          className="browser-nav"
          title="前进"
          onClick={() => viewRef.current?.goForward()}
        >
          <ArrowRight size={14} />
        </button>
        <button
          type="button"
          className="browser-nav"
          title="刷新"
          onClick={() => viewRef.current?.reload()}
        >
          <RotateCw size={13} className={loading ? 'is-spinning' : undefined} />
        </button>
        <form
          className="browser-address"
          onSubmit={(event) => {
            event.preventDefault();
            go(address);
          }}
        >
          <input
            value={address}
            placeholder="输入网址，回车打开"
            spellCheck={false}
            list="cmd-toolbox-bookmarks"
            onChange={(event) => setAddress(event.target.value)}
          />
          <datalist id="cmd-toolbox-bookmarks">
            {bookmarks.map((item) => (
              <option key={item.url} value={item.url}>
                {item.title}
              </option>
            ))}
          </datalist>
        </form>
        <button
          type="button"
          className="browser-nav"
          title={starred ? '取消收藏' : '收藏'}
          onClick={toggleBookmark}
        >
          <Star size={14} fill={starred ? 'currentColor' : 'none'} />
        </button>
        <button
          type="button"
          className={device ? 'browser-nav is-active' : 'browser-nav'}
          title={device ? `设备模拟：${deviceLabel(device)}` : '切换设备模拟'}
          aria-label={device ? `设备模拟：${deviceLabel(device)}` : '切换设备模拟'}
          onClick={openDeviceMenu}
        >
          <Smartphone size={14} />
        </button>
        <button
          type="button"
          className="browser-nav"
          title={device ? '模拟移动端时不可缩放，请先切回桌面' : '缩小'}
          disabled={Boolean(device)}
          onClick={() => applyZoom(zoom - 0.1)}
        >
          <Minus size={14} />
        </button>
        <span className="browser-zoom">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="browser-nav"
          title={device ? '模拟移动端时不可缩放，请先切回桌面' : '放大'}
          disabled={Boolean(device)}
          onClick={() => applyZoom(zoom + 0.1)}
        >
          <Plus size={14} />
        </button>
        <button
          type="button"
          className="browser-nav"
          title="查找"
          onClick={() => setFindOpen(true)}
        >
          <Search size={14} />
        </button>
        <button
          type="button"
          className="browser-nav"
          title="用系统浏览器打开"
          onClick={() => {
            if (!address || address === 'about:blank') {
              toastRef.current('还没有网址', 'error');
              return;
            }
            void window.api.shell.openExternal(address).catch((error) => {
              toastRef.current(toErrorMessage(error), 'error');
            });
          }}
        >
          <ExternalLink size={14} />
        </button>
        <button
          type="button"
          className="icon-btn"
          title="关闭浏览器"
          onClick={() => onClose(tab)}
        >
          <X size={14} />
        </button>
      </header>
      {findOpen ? (
        <div className="find-bar">
          <Search size={13} />
          <input
            ref={findInputRef}
            value={findQuery}
            placeholder="在页面中查找"
            onChange={(event) => {
              const value = event.target.value;
              setFindQuery(value);
              if (value) viewRef.current?.findInPage(value);
              else viewRef.current?.stopFindInPage('clearSelection');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (findQuery) viewRef.current?.findInPage(findQuery, { findNext: true });
              }
              if (event.key === 'Escape') {
                setFindOpen(false);
                viewRef.current?.stopFindInPage('clearSelection');
              }
            }}
          />
          <button
            type="button"
            className="icon-btn"
            title="关闭查找"
            onClick={() => {
              setFindOpen(false);
              viewRef.current?.stopFindInPage('clearSelection');
            }}
          >
            <X size={13} />
          </button>
        </div>
      ) : null}
      <div className={`browser-stage${device ? ' is-device' : ''}`}>
        <webview
          ref={(node) => {
            viewRef.current = node as HTMLWebViewElement | null;
          }}
          className="browser-view"
          src={initialSrc.current}
          partition={`persist:cmd-toolbox-browser:${tab.groupKey}`}
          webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
        />
      </div>
      {deviceMenu ? (
        <PopupMenu state={deviceMenu} onClose={() => setDeviceMenu(null)} />
      ) : null}
      {customOpen ? (
        <Modal
          title="自定义设备尺寸"
          subtitle="按 CSS 逻辑像素填写，超出可用范围会自动收敛"
          icon={<Smartphone size={16} />}
          onClose={() => setCustomOpen(false)}
          width={380}
        >
          <div className="modal-body">
            <label className="field">
              <span className="field-label">宽度</span>
              <input
                data-autofocus
                type="number"
                min={240}
                max={1920}
                value={customWidth}
                onChange={(event) => setCustomWidth(event.target.value)}
              />
            </label>
            <label className="field">
              <span className="field-label">高度</span>
              <input
                type="number"
                min={320}
                max={2400}
                value={customHeight}
                onChange={(event) => setCustomHeight(event.target.value)}
              />
            </label>
          </div>
          <div className="modal-actions">
            <button type="button" className="btn ghost" onClick={() => setCustomOpen(false)}>
              取消
            </button>
            <button type="button" className="btn primary" onClick={submitCustomDevice}>
              应用
            </button>
          </div>
        </Modal>
      ) : null}
    </section>
  );
}
