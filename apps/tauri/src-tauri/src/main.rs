// Cursor 一键汉化 —— Tauri 2 外壳。
// 界面与 Electron 版共用（ui/ 由 scripts/sync-tauri-ui.mjs 从 apps/desktop 同步）。
// 不捆绑 Node：借用已安装 Cursor 的主程序（ELECTRON_RUN_AS_NODE=1，Cursor 自己的 CLI 也是这么跑的）执行嵌入的 JS 引擎，
// 引擎通过 stdout 输出 JSON 行（scripts/engine-ipc.mjs），这里逐行转成界面事件。
// 关闭/重新打开 Cursor、提权（Windows UAC / macOS osascript 管理员授权 / Linux pkexec）都由引擎完成，
// 只有“把准备好的文件放进安装目录”这一步以管理员身份运行，本界面始终是普通用户。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod runtime;

use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const ENGINE_BLOB: &[u8] = include_bytes!(concat!(env!("OUT_DIR"), "/engine.bin"));
const ENGINE_HASH: &str = env!("CZL_ENGINE_HASH");

#[derive(Default)]
struct Shared {
    busy: AtomicBool,
    engine_dir: Mutex<Option<PathBuf>>,
    rt: Mutex<runtime::Cache>,
    log_file: Mutex<Option<PathBuf>>,
}

/// 把嵌入的引擎解到 <缓存目录>/engine/<hash>/（已存在就直接用）
fn engine_dir(app: &AppHandle, sh: &Shared) -> Result<PathBuf, String> {
    if let Some(d) = sh.engine_dir.lock().unwrap().clone() { return Ok(d); }
    let base = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("engine");
    let dir = base.join(ENGINE_HASH);
    if !dir.join(".ok").is_file() {
        let blob = miniz_oxide::inflate::decompress_to_vec(ENGINE_BLOB).map_err(|e| format!("引擎数据损坏：{e:?}"))?;
        let tmp = base.join(format!("{ENGINE_HASH}.tmp{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let mut i = 0usize;
        let u32at = |b: &[u8], i: usize| u32::from_le_bytes([b[i], b[i + 1], b[i + 2], b[i + 3]]) as usize;
        while i < blob.len() {
            let n = u32at(&blob, i); i += 4;
            let name = std::str::from_utf8(&blob[i..i + n]).map_err(|e| e.to_string())?.to_string(); i += n;
            let m = u32at(&blob, i); i += 4;
            let p = tmp.join(&name);
            std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
            std::fs::write(&p, &blob[i..i + m]).map_err(|e| format!("写 {} 失败：{e}", p.display()))?;
            i += m;
        }
        std::fs::write(tmp.join(".ok"), ENGINE_HASH).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&tmp, &dir).map_err(|e| format!("解出引擎失败：{e}"))?;
        // 旧版本解出的引擎顺手清掉
        if let Ok(rd) = std::fs::read_dir(&base) {
            for e in rd.flatten() { if e.file_name() != ENGINE_HASH { let _ = std::fs::remove_dir_all(e.path()); } }
        }
    }
    *sh.engine_dir.lock().unwrap() = Some(dir.clone());
    Ok(dir)
}

fn fail(code: &str, error: String, next: &str) -> Value {
    json!({ "ok": false, "code": code, "error": error, "next": next })
}

fn run_engine(app: &AppHandle, sh: &Shared, op: &str, opts: &Value) -> Value {
    let dir = match engine_dir(app, sh) { Ok(d) => d, Err(e) => return fail("ENGINE_EXTRACT", e, "检查磁盘空间和用户目录权限后重试") };
    let install_root = opts.get("installRoot").and_then(|v| v.as_str()).map(PathBuf::from);
    let rt = { sh.rt.lock().unwrap().get(install_root.as_deref(), op != "status") };
    let rt = match rt {
        Ok(Some(rt)) => rt,
        Ok(None) => {
            return if op == "status" {
                json!({ "cursor": null, "installs": [], "appImages": [], "extracted": [], "supported": false, "noRuntime": true, "runtime": null })
            } else {
                fail("NO_RUNTIME", "没有找到可用的 Cursor（本工具借用 Cursor 自带的运行环境执行汉化）".into(), "先安装 Cursor，或点“手动选择 Cursor 安装位置…”")
            };
        }
        Err(e) => return fail("RUNTIME_PREPARE", e, "重试；仍失败请打开日志反馈"),
    };
    let mut cmd = Command::new(&rt.exe);
    cmd.arg(dir.join("scripts").join("engine-ipc.mjs")).arg(op)
        .env("CZL_IPC_OPTS", opts.to_string())
        .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if rt.electron { cmd.env("ELECTRON_RUN_AS_NODE", "1"); }
    runtime::clean_child_env(&mut cmd);
    runtime::hide(&mut cmd); // Windows：CREATE_NO_WINDOW，不闪黑框
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => return fail("ENGINE_SPAWN", format!("无法启动 {}：{e}", rt.exe.display()), "确认 Cursor 安装完整后重试"),
    };
    let mut stderr = child.stderr.take().unwrap();
    let err_thread = std::thread::spawn(move || { let mut s = String::new(); let _ = stderr.read_to_string(&mut s); s });
    let mut result: Option<Value> = None;
    for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
        let Ok(v) = serde_json::from_str::<Value>(&line) else { continue };
        match v.get("t").and_then(|t| t.as_str()) {
            Some("log") => { let _ = app.emit("engine-log", v.get("msg").cloned().unwrap_or(Value::Null)); }
            Some("result") => result = v.get("data").cloned(),
            _ => {}
        }
    }
    let status = child.wait();
    let errout = err_thread.join().unwrap_or_default();
    let mut r = result.unwrap_or_else(|| {
        let tail: String = errout.lines().rev().take(8).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
        fail("ENGINE_CRASH", format!("引擎异常退出（{:?}）：{}", status.map(|s| s.code()), tail.trim()), "重试；仍失败请打开日志反馈")
    });
    if let Some(lf) = r.get("logFile").and_then(|v| v.as_str()) { *sh.log_file.lock().unwrap() = Some(PathBuf::from(lf)); }
    if op == "status" { r["runtime"] = json!(rt.describe()); }
    r
}

#[tauri::command]
async fn engine(app: AppHandle, op: String, opts: Value) -> Value {
    if !matches!(op.as_str(), "status" | "localize" | "revert" | "extractAppImage") { return fail("USAGE", format!("未知操作 {op}"), ""); }
    let sh = app.state::<Shared>();
    let exclusive = op != "status";
    if exclusive && sh.busy.swap(true, Ordering::SeqCst) { return json!({ "ok": false, "code": "BUSY", "error": "已有操作在进行中" }); }
    let app2 = app.clone();
    let r = tauri::async_runtime::spawn_blocking(move || { let sh = app2.state::<Shared>(); run_engine(&app2, &sh, &op, &opts) })
        .await.unwrap_or_else(|e| fail("EXCEPTION", e.to_string(), "重试"));
    if exclusive { sh.busy.store(false, Ordering::SeqCst); }
    r
}

#[tauri::command]
fn show_log(app: AppHandle, sh: State<Shared>) -> Result<String, String> {
    use tauri_plugin_opener::OpenerExt;
    let lf = sh.log_file.lock().unwrap().clone().unwrap_or_else(runtime::default_log_file);
    if !lf.exists() {
        let _ = std::fs::create_dir_all(lf.parent().unwrap());
        let _ = std::fs::write(&lf, "");
    }
    app.opener().reveal_item_in_dir(&lf).map_err(|e| e.to_string())?;
    Ok(lf.display().to_string())
}

#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<bool, String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())?;
    Ok(true)
}

/// 手动选安装位置：Windows/Linux 选文件夹；macOS 选 Cursor.app（返回 .app/Contents，与引擎的安装根约定一致）
#[tauri::command]
async fn pick_root(app: AppHandle) -> Option<String> {
    use tauri_plugin_dialog::DialogExt;
    let d = app.dialog().file().set_title("选择 Cursor 安装位置");
    let picked = if cfg!(target_os = "macos") {
        d.add_filter("Cursor.app", &["app"]).set_directory("/Applications").blocking_pick_file()
    } else {
        d.blocking_pick_folder()
    }?;
    let p = picked.into_path().ok()?;
    Some(runtime::normalize_root(&p).display().to_string())
}

fn main() {
    runtime::cleanup_stale_clones();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(Shared::default())
        .invoke_handler(tauri::generate_handler![engine, show_log, copy_text, pick_root])
        .setup(|app| {
            // 自检（给测试/排错用，不开窗口）：cursor-zh --self-test <输出.json>
            // 解出引擎、选运行环境、跑一次“检测状态”，把结果写进文件后退出
            let args: Vec<String> = std::env::args().collect();
            if let Some(i) = args.iter().position(|a| a == "--self-test") {
                let out = args.get(i + 1).cloned().unwrap_or_else(|| "czl-self-test.json".into());
                let h = app.handle().clone();
                std::thread::spawn(move || {
                    let sh = h.state::<Shared>();
                    let r = run_engine(&h, &sh, "status", &json!({}));
                    let doc = json!({ "version": env!("CARGO_PKG_VERSION"), "engineHash": ENGINE_HASH, "engineDir": sh.engine_dir.lock().unwrap().clone(), "status": r });
                    let ok = r.get("cursor").is_some_and(|c| !c.is_null());
                    let _ = std::fs::write(&out, serde_json::to_string_pretty(&doc).unwrap());
                    h.exit(if ok { 0 } else { 1 });
                });
                return Ok(());
            }
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::App("index.html".into()))
                .title("Cursor 一键汉化")
                .inner_size(820.0, 860.0)
                .min_inner_size(640.0, 600.0)
                .build()?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("启动失败");
    app.run(|h, ev| {
        if let tauri::RunEvent::Exit = ev { h.state::<Shared>().rt.lock().unwrap().cleanup(); }
    });
}
