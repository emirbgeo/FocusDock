/*
 * Windows AppBar support.
 *
 * An AppBar is what the Windows taskbar is: a window that reserves a strip of
 * a monitor so maximised windows stop at its edge instead of covering it.
 * That is the only reliable way to keep a panel "always visible" without it
 * hiding your work or your work hiding it.
 *
 * Uses the documented Shell API SHAppBarMessage through koffi (a prebuilt
 * FFI module, no compiler needed). Everything here is a no-op off Windows or
 * if koffi fails to load; main.js then falls back to a plain window.
 */
'use strict';

const ABM_NEW = 0x0;
const ABM_REMOVE = 0x1;
const ABM_QUERYPOS = 0x2;
const ABM_SETPOS = 0x3;

const ABE_LEFT = 0;
const ABE_RIGHT = 2;

const ABN_POSCHANGED = 0x1;
const ABN_FULLSCREENAPP = 0x2;

let api = null;
let loadError = null;

function load() {
  if (api || loadError) return api;
  if (process.platform !== 'win32') {
    loadError = new Error('AppBar is only available on Windows');
    return null;
  }
  try {
    const koffi = require('koffi');
    const shell32 = koffi.load('shell32.dll');
    const user32 = koffi.load('user32.dll');

    const RECT = koffi.struct('FD_RECT', {
      left: 'int32',
      top: 'int32',
      right: 'int32',
      bottom: 'int32',
    });
    // typedef struct _AppBarData { DWORD cbSize; HWND hWnd; UINT uCallbackMessage;
    //   UINT uEdge; RECT rc; LPARAM lParam; } APPBARDATA;
    const APPBARDATA = koffi.struct('FD_APPBARDATA', {
      cbSize: 'uint32',
      hWnd: 'intptr',
      uCallbackMessage: 'uint32',
      uEdge: 'uint32',
      rc: RECT,
      lParam: 'intptr',
    });

    api = {
      size: koffi.sizeof(APPBARDATA),
      SHAppBarMessage: shell32.func(
        'uintptr_t __stdcall SHAppBarMessage(uint32_t dwMessage, _Inout_ FD_APPBARDATA *pData)'
      ),
      RegisterWindowMessageW: user32.func('uint32_t __stdcall RegisterWindowMessageW(str16 lpString)'),
    };
  } catch (err) {
    loadError = err;
    api = null;
  }
  return api;
}

function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
}

class AppBar {
  /**
   * @param {Electron.BrowserWindow} win
   * @param {{ onPosChanged: Function, onFullscreen: Function, log: Function }} hooks
   */
  constructor(win, hooks) {
    this.win = win;
    this.hooks = hooks || {};
    this.registered = false;
    this.callbackMsg = 0;
    this.hwnd = 0;
  }

  static available() {
    return !!load();
  }

  static error() {
    load();
    return loadError;
  }

  _data(extra) {
    return Object.assign(
      {
        cbSize: api.size,
        hWnd: this.hwnd,
        uCallbackMessage: this.callbackMsg,
        uEdge: 0,
        rc: { left: 0, top: 0, right: 0, bottom: 0 },
        lParam: 0,
      },
      extra || {}
    );
  }

  register() {
    if (!load()) return false;
    if (this.registered) return true;
    this.hwnd = hwndOf(this.win);
    if (!this.callbackMsg) {
      this.callbackMsg = api.RegisterWindowMessageW('FocusDockAppBarMessage');
      if (this.callbackMsg && !this._hooked) {
        this._hooked = true;
        this.win.hookWindowMessage(this.callbackMsg, (wParam, lParam) => {
          const code = Number(wParam.readBigUInt64LE ? wParam.readBigUInt64LE(0) : wParam.readUInt32LE(0));
          const lp = Number(lParam.readBigUInt64LE ? lParam.readBigUInt64LE(0) : lParam.readUInt32LE(0));
          if (code === ABN_POSCHANGED && this.hooks.onPosChanged) this.hooks.onPosChanged();
          if (code === ABN_FULLSCREENAPP && this.hooks.onFullscreen) this.hooks.onFullscreen(lp !== 0);
        });
      }
    }
    const ok = api.SHAppBarMessage(ABM_NEW, this._data());
    this.registered = Number(ok) !== 0;
    return this.registered;
  }

  /**
   * Reserve a strip on one edge of a monitor.
   * @param {'left'|'right'} edge
   * @param {{left,top,right,bottom}} monitor  monitor rect in physical pixels
   * @param {number} widthPx  strip width in physical pixels
   * @returns {{left,top,right,bottom}|null} the rect Windows granted
   */
  dock(edge, monitor, widthPx) {
    if (!this.registered && !this.register()) return null;
    const uEdge = edge === 'right' ? ABE_RIGHT : ABE_LEFT;
    const rc = { left: monitor.left, top: monitor.top, right: monitor.right, bottom: monitor.bottom };
    if (uEdge === ABE_LEFT) rc.right = rc.left + widthPx;
    else rc.left = rc.right - widthPx;

    const data = this._data({ uEdge, rc });
    // Ask Windows where we may go (it moves us past the taskbar or other bars)...
    api.SHAppBarMessage(ABM_QUERYPOS, data);
    // ...then restore our width from whichever side Windows kept.
    if (uEdge === ABE_LEFT) data.rc.right = data.rc.left + widthPx;
    else data.rc.left = data.rc.right - widthPx;
    api.SHAppBarMessage(ABM_SETPOS, data);
    return { left: data.rc.left, top: data.rc.top, right: data.rc.right, bottom: data.rc.bottom };
  }

  remove() {
    if (!api || !this.registered) return;
    try {
      api.SHAppBarMessage(ABM_REMOVE, this._data());
    } catch (err) {
      if (this.hooks.log) this.hooks.log('ABM_REMOVE failed: ' + err.message);
    }
    this.registered = false;
  }
}

module.exports = { AppBar };
