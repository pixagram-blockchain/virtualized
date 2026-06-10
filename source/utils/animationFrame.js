/** @flow */

type Callback = (timestamp: number) => void;
type CancelAnimationFrame = (requestId: number) => void;
type RequestAnimationFrame = (callback: Callback) => number;

// Properly handle server-side rendering, web workers, and modern runtimes.
let win;
if (typeof window !== 'undefined') {
  win = window;
} else if (typeof self !== 'undefined') {
  win = self;
} else if (typeof globalThis !== 'undefined') {
  win = globalThis;
} else {
  win = {};
}

// All supported browsers have shipped unprefixed requestAnimationFrame for
// years; the legacy vendor-prefix probing (webkit/moz/o/ms) only added
// startup property lookups. Bind to `win` so the natives are safe to call
// as bare functions.
const request: RequestAnimationFrame = win.requestAnimationFrame
  ? win.requestAnimationFrame.bind(win)
  : function(callback: Callback): number {
      return (win: any).setTimeout(callback, 1000 / 60);
    };

const cancel: CancelAnimationFrame = win.cancelAnimationFrame
  ? win.cancelAnimationFrame.bind(win)
  : function(id: number) {
      (win: any).clearTimeout(id);
    };

export const raf: RequestAnimationFrame = request;
export const caf: CancelAnimationFrame = cancel;
