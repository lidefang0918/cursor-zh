#!/usr/bin/env python3
"""Offscreen WebKitGTK layout probe for official desktop UI fixtures.

Loads a file:// HTML page, waits briefly for the renderer refresh, then
prints getBoundingClientRect / computed style JSON for key nodes.
Uses Gtk.OffscreenWindow so nothing is mapped onto the desktop.
"""
import argparse
import json
import os
import sys

os.environ.setdefault("DISPLAY", os.environ.get("DISPLAY") or ":5")

import gi
gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import Gtk, WebKit2, GLib

MEASURE_JS = r"""
(() => {
  const ids = ['toggle-details', 'toggle-log', 'details', 'revert', 'localize'];
  const out = { ids: {} };
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) { out.ids[id] = null; continue; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    out.ids[id] = {
      hiddenAttr: el.hasAttribute('hidden'),
      hiddenProp: !!el.hidden,
      display: cs.display,
      visibility: cs.visibility,
      offsetHeight: el.offsetHeight,
      offsetWidth: el.offsetWidth,
      rectH: r.height,
      rectW: r.width,
    };
  }
  out.statusTitle = (document.getElementById('status-title') || {}).textContent || '';
  return JSON.stringify(out);
})()
"""

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--html", required=True, help="file path or file:// URI")
    p.add_argument("--wait-ms", type=int, default=400)
    args = p.parse_args()
    uri = args.html if args.html.startswith("file:") else "file://" + os.path.abspath(args.html)

    win = Gtk.OffscreenWindow()
    view = WebKit2.WebView()
    settings = view.get_settings()
    settings.set_enable_javascript(True)
    win.add(view)
    win.set_default_size(820, 720)
    win.show_all()

    result = {"error": "timeout"}

    def finish_eval(view, task):
        nonlocal result
        try:
            jsres = view.run_javascript_finish(task)
            result = json.loads(jsres.get_js_value().to_string())
        except Exception as e:
            result = {"error": str(e)}
        Gtk.main_quit()

    def start_eval():
        deadline = {"t": GLib.get_monotonic_time() + 3_000_000}  # 3s in µs

        def on_partial(view, task):
            nonlocal result
            try:
                jsres = view.run_javascript_finish(task)
                parsed = json.loads(jsres.get_js_value().to_string())
            except Exception as e:
                result = {"error": str(e)}
                Gtk.main_quit()
                return
            title = (parsed or {}).get("statusTitle") or ""
            if (title and title != "检测中…") or GLib.get_monotonic_time() > deadline["t"]:
                result = parsed
                Gtk.main_quit()
                return
            GLib.timeout_add(50, lambda: view.run_javascript(MEASURE_JS, None, on_partial) or False)

        view.run_javascript(MEASURE_JS, None, on_partial)
        return False

    def on_load(view, ev):
        if ev == WebKit2.LoadEvent.FINISHED:
            GLib.timeout_add(args.wait_ms, start_eval)

    view.connect("load-changed", on_load)
    GLib.timeout_add(10000, Gtk.main_quit)
    view.load_uri(uri)
    Gtk.main()
    if isinstance(result, dict) and result.get("error") == "timeout":
        print(json.dumps(result), file=sys.stderr)
        return 2
    if isinstance(result, dict) and "error" in result and "ids" not in result:
        print(json.dumps(result), file=sys.stderr)
        return 3
    print(json.dumps(result, ensure_ascii=False))
    return 0

if __name__ == "__main__":
    sys.exit(main())
