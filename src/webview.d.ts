import type { HTMLAttributes } from 'react';

type WebviewProps = HTMLAttributes<HTMLElement> & {
  src?: string;
  partition?: string;
  allowpopups?: string;
  webpreferences?: string;
};

declare global {
  namespace JSX {
    interface IntrinsicElements {
      webview: WebviewProps;
    }
  }

  interface HTMLWebViewElement extends HTMLElement {
    src: string;
    partition: string;
    loadURL: (url: string) => void;
    reload: () => void;
    reloadIgnoringCache: () => void;
    setUserAgent: (userAgent: string) => void;
    goBack: () => void;
    goForward: () => void;
    canGoBack: () => boolean;
    canGoForward: () => boolean;
    getURL: () => string;
    getWebContentsId: () => number;
    stop: () => void;
    setZoomFactor: (factor: number) => void;
    getZoomFactor: () => number;
    findInPage: (text: string, options?: { findNext?: boolean; forward?: boolean }) => void;
    stopFindInPage: (action: 'clearSelection' | 'keepSelection' | 'activateSelection') => void;
  }
}

export {};
