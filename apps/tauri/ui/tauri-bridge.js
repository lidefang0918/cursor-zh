// Tauri 版的 window.engine：接口与 Electron 版 preload.cjs 完全一致，renderer.js 两边共用。
// 引擎本身不在 WebView 里跑：Rust 外壳借用已安装 Cursor 的主程序（ELECTRON_RUN_AS_NODE=1）执行 scripts/engine-ipc.mjs，
// 把它输出的 JSON 行转成 'engine-log' 事件，最后的结果作为 invoke 的返回值。
(() => {
  const { invoke } = window.__TAURI__.core;
  const ua = navigator.userAgent;
  const platform = /Windows/i.test(ua) ? 'win32' : /Mac OS X|Macintosh/i.test(ua) ? 'darwin' : 'linux';
  const subs = [];
  const ready = window.__TAURI__.event.listen('engine-log', (e) => { for (const cb of subs) cb(e.payload); });
  const engine = async (op, opts = {}) => { await ready; return invoke('engine', { op, opts }); };
  let announced = false;
  window.engine = {
    platform,
    getStatus: async (o) => {
      const s = await engine('status', o);
      if (!announced && s && s.runtime) { announced = true; for (const cb of subs) cb(`· 引擎运行环境：${s.runtime}`); }
      return s;
    },
    localize: (o) => engine('localize', o),
    revert: (o) => engine('revert', o),
    extractAppImage: (p) => engine('extractAppImage', { appImagePath: p }),
    copy: (t) => invoke('copy_text', { text: String(t) }),
    showLog: () => invoke('show_log'),
    onLog: (cb) => subs.push(cb),
    pickRoot: () => invoke('pick_root'),
  };
})();
