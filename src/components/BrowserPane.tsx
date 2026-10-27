import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Minus,
  Plus,
  RotateCw,
  Search,
  Star,
  X,
} from 'lucide-react';
import { normalizeHttpUrl, toErrorMessage } from '../lib';
import type { Group, Tab } from '../types';
import type { ToastKind } from './Toast';

type BrowserPaneProps = {
  tab: Tab;
  group: Group;
  active: boolean;
  onClose: (tab: Tab) => void;
  onToast: (message: string, kind?: ToastKind) => void;
  onUrlChange: (tabId: string, url: string) => void;
};

export function BrowserPane({
  tab,
  group,
  active,
  onClose,
  onToast,
  onUrlChange,
}: BrowserPaneProps) {
  const viewRef = useRef<HTMLWebViewElement | null>(null);
  const toastRef = useRef(onToast);
  const onUrlChangeRef = useRef(onUrlChange);
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

  toastRef.current = onToast;
  onUrlChangeRef.current = onUrlChange;

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
          className="browser-nav"
          title="缩小"
          onClick={() => applyZoom(zoom - 0.1)}
        >
          <Minus size={14} />
        </button>
        <span className="browser-zoom">{Math.round(zoom * 100)}%</span>
        <button
          type="button"
          className="browser-nav"
          title="放大"
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
      <webview
        ref={(node) => {
          viewRef.current = node as HTMLWebViewElement | null;
        }}
        className="browser-view"
        src={initialSrc.current}
        partition={`persist:cmd-toolbox-browser:${tab.groupKey}`}
        webpreferences="contextIsolation=yes, nodeIntegration=no, sandbox=yes"
      />
    </section>
  );
}
