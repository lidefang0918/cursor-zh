// 找一个能跑 JS 引擎的运行环境：优先借用已安装 Cursor 的主程序（ELECTRON_RUN_AS_NODE=1），找不到再用系统 Node（≥18）。
//   Windows：直接运行 <安装根>\Cursor.exe。引擎从不修改 Cursor.exe（只改 resources\app 下的文件），
//            运行期间 Cursor.exe 被系统占用（不可删除/覆盖）也不影响——我们不写它。
//   macOS ：汉化会对 Cursor.app 做 ad-hoc 重签名；任何仍映射原版 Contents/MacOS/Cursor 的进程都会被
//            内核以 Code Signature Invalid SIGKILL，系统弹出「意外退出」。所以：有系统 Node 就优先用 Node；
//            否则无论 status 还是写入都 APFS 克隆后再跑引擎，原包不被占用。写入/重签名前还要等原包上
//            的 GUI 与 engine-ipc 进程都消失（含并发 status）。
//   Linux ：只改 resources/app 下的文件，直接运行 <安装根>/cursor。
use std::path::{Path, PathBuf};
use std::process::Command;

pub struct Runtime {
    pub exe: PathBuf,
    pub electron: bool,
    source: Option<PathBuf>,
}

impl Runtime {
    pub fn describe(&self) -> String {
        match (&self.source, self.electron) {
            (Some(src), _) => format!("借用 Cursor（临时克隆 {}，原程序 {} 不会被占用或改写）", self.exe.display(), src.display()),
            (None, true) => format!("借用 Cursor 主程序 {}（ELECTRON_RUN_AS_NODE=1，不修改它）", self.exe.display()),
            (None, false) => format!("系统 Node {}", self.exe.display()),
        }
    }
}

#[derive(Default)]
pub struct Cache {
    /// macOS：(原 .app, 克隆目录)
    clone: Option<(PathBuf, PathBuf)>,
}

fn home() -> PathBuf {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from).unwrap_or_default()
}

/// 安装根里的 Cursor 主程序
pub fn exe_in_root(root: &Path) -> PathBuf {
    if cfg!(windows) { root.join("Cursor.exe") }
    else if cfg!(target_os = "macos") { normalize_root(root).join("MacOS").join("Cursor") }
    else { root.join("cursor") }
}

/// 界面里选的路径 → 引擎的安装根（macOS 统一为 Cursor.app/Contents）
pub fn normalize_root(p: &Path) -> PathBuf {
    if cfg!(target_os = "macos") && p.extension().is_some_and(|e| e == "app") { p.join("Contents") } else { p.to_path_buf() }
}

fn default_roots() -> Vec<PathBuf> {
    let h = home();
    let mut v = Vec::new();
    if cfg!(windows) {
        if let Some(l) = std::env::var_os("LOCALAPPDATA") { v.push(PathBuf::from(l).join("Programs").join("cursor")); }
        for k in ["ProgramFiles", "ProgramW6432"] { if let Some(p) = std::env::var_os(k) { v.push(PathBuf::from(p).join("cursor")); } }
    } else if cfg!(target_os = "macos") {
        v.push("/Applications/Cursor.app/Contents".into());
        v.push(h.join("Applications/Cursor.app/Contents"));
    } else {
        for p in ["/usr/share/cursor", "/opt/cursor", "/opt/Cursor"] { v.push(p.into()); }
        v.push(h.join(".local/share/cursor"));
        if let Ok(rd) = std::fs::read_dir(h.join(".local/share/cursor-zh-localizer/cursor-appimage")) {
            for e in rd.flatten() { v.push(e.path().join("usr/share/cursor")); }
        }
    }
    // PATH 里的 cursor 命令（Windows：<根>\resources\app\bin\cursor.cmd；Linux：/usr/bin/cursor → <根>/bin/cursor）
    if let Some(path) = std::env::var_os("PATH") {
        for d in std::env::split_paths(&path) {
            let f = d.join(if cfg!(windows) { "cursor.cmd" } else { "cursor" });
            if !f.is_file() || cfg!(target_os = "macos") { continue; }
            let Ok(real) = std::fs::canonicalize(&f) else { continue };
            let up = if cfg!(windows) { 4 } else { 2 };
            if let Some(r) = real.ancestors().nth(up) { v.push(r.to_path_buf()); }
        }
    }
    v
}

fn appimages() -> Vec<PathBuf> {
    if cfg!(any(windows, target_os = "macos")) { return vec![]; }
    let h = home();
    let mut v = Vec::new();
    for d in ["Applications", "Downloads", ".local/bin", "Desktop"] {
        let Ok(rd) = std::fs::read_dir(h.join(d)) else { continue };
        for e in rd.flatten() {
            let n = e.file_name().to_string_lossy().to_lowercase();
            if n.starts_with("cursor") && n.ends_with(".appimage") { v.push(e.path()); }
        }
    }
    v.sort();
    v
}

fn system_node() -> Option<PathBuf> {
    let name = if cfg!(windows) { "node.exe" } else { "node" };
    let mut cands: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).map(|d| d.join(name)).collect()).unwrap_or_default();
    if cfg!(target_os = "macos") { cands.push("/opt/homebrew/bin/node".into()); cands.push("/usr/local/bin/node".into()); }
    for c in cands {
        if !c.is_file() { continue; }
        let mut cmd = Command::new(&c);
        cmd.arg("-v");
        hide(&mut cmd);
        let Ok(o) = cmd.output() else { continue };
        let v = String::from_utf8_lossy(&o.stdout);
        let major: u32 = v.trim().trim_start_matches('v').split('.').next().and_then(|m| m.parse().ok()).unwrap_or(0);
        if major >= 18 { return Some(c); }
    }
    None
}

pub fn hide(_cmd: &mut Command) {
    #[cfg(windows)]
    { use std::os::windows::process::CommandExt; _cmd.creation_flags(0x0800_0000); }
}

impl Cache {
    /// install_root：界面里选中的安装（优先借用它自己的主程序）；write：本次操作会改安装文件
    /// macOS：优先系统 Node；否则无论 status 还是写入都用 APFS 克隆里的主程序。
    /// 绝不能在「正在改签名的原版 Cursor.app」上跑 ELECTRON_RUN_AS_NODE，否则内核 SIGKILL（Code Signature Invalid）会弹出「意外退出」。
    pub fn get(&mut self, install_root: Option<&Path>, write: bool) -> Result<Option<Runtime>, String> {
        let _ = write; // macOS 一律克隆，不再区分
        if let Some(n) = std::env::var_os("CZL_NODE") { return Ok(Some(Runtime { exe: n.into(), electron: false, source: None })); }
        // macOS 有 Node 就用 Node：引擎完全不碰 Cursor 主程序，重签名时最安全
        if cfg!(target_os = "macos") {
            if let Some(n) = system_node() { return Ok(Some(Runtime { exe: n, electron: false, source: None })); }
        }
        let mut roots: Vec<PathBuf> = install_root.map(|r| vec![r.to_path_buf()]).unwrap_or_default();
        roots.extend(default_roots());
        let exe = roots.iter().map(|r| exe_in_root(r)).find(|e| e.is_file());
        if let Some(exe) = exe {
            if cfg!(target_os = "macos") {
                match self.mac_clone(&exe) {
                    Ok(c) => return Ok(Some(Runtime { exe: c, electron: true, source: Some(exe) })),
                    Err(e) => return Err(format!("准备运行环境失败（克隆 Cursor.app 到临时目录）：{e}")),
                }
            }
            return Ok(Some(Runtime { exe, electron: true, source: None }));
        }
        if let Some(n) = system_node() { return Ok(Some(Runtime { exe: n, electron: false, source: None })); }
        // 只有 AppImage：AppRun 会把环境变量和参数原样交给里面的 Electron
        if let Some(a) = appimages().into_iter().next() { return Ok(Some(Runtime { exe: a, electron: true, source: None })); }
        Ok(None)
    }

    fn mac_clone(&mut self, exe: &Path) -> Result<PathBuf, String> {
        let app = exe.ancestors().nth(3).ok_or("路径不对")?.to_path_buf(); // …/Cursor.app/Contents/MacOS/Cursor
        let inner = |dir: &Path| dir.join("Cursor.app/Contents/MacOS/Cursor");
        if let Some((src, dir)) = &self.clone {
            if src == &app && inner(dir).is_file() { return Ok(inner(dir)); }
        }
        self.cleanup();
        let dir = std::env::temp_dir().join(format!("czl-runtime-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let dst = dir.join("Cursor.app");
        let ok = Command::new("/bin/cp").arg("-Rc").arg(&app).arg(&dst).status().is_ok_and(|s| s.success())
            || { let _ = std::fs::remove_dir_all(&dst); Command::new("/usr/bin/ditto").arg(&app).arg(&dst).status().is_ok_and(|s| s.success()) };
        if !ok { let _ = std::fs::remove_dir_all(&dir); return Err(format!("无法复制 {}", app.display())); }
        let _ = Command::new("/usr/bin/xattr").args(["-dr", "com.apple.quarantine"]).arg(&dst).status();
        self.clone = Some((app, dir.clone()));
        Ok(inner(&dir))
    }

    pub fn cleanup(&mut self) {
        if let Some((_, dir)) = self.clone.take() { let _ = std::fs::remove_dir_all(dir); }
    }
}

/// 上次没正常退出留下的克隆（超过 1 小时的）清掉
pub fn cleanup_stale_clones() {
    if !cfg!(target_os = "macos") { return; }
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in rd.flatten() {
        if !e.file_name().to_string_lossy().starts_with("czl-runtime-") { continue; }
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|d| d.as_secs() > 3600);
        if old { let _ = std::fs::remove_dir_all(e.path()); }
    }
}

/// 我们自己是 AppImage 时，AppRun 给本进程加的库路径等不能漏给 Cursor（否则 Cursor 可能加载到错误的 GTK/glib）
pub fn clean_child_env(cmd: &mut Command) {
    if std::env::var_os("APPIMAGE").is_none() && std::env::var_os("APPDIR").is_none() { return; }
    for k in ["LD_LIBRARY_PATH", "LD_PRELOAD", "APPDIR", "APPIMAGE", "ARGV0", "OWD", "GDK_PIXBUF_MODULE_FILE", "GDK_PIXBUF_MODULEDIR",
              "GIO_EXTRA_MODULES", "GIO_MODULE_DIR", "GSETTINGS_SCHEMA_DIR", "GTK_PATH", "GTK_DATA_PREFIX", "GTK_EXE_PREFIX", "GTK_IM_MODULE_FILE",
              "PYTHONHOME", "PYTHONPATH", "PERLLIB", "QT_PLUGIN_PATH", "WEBKIT_EXEC_PATH", "WEBKIT_INJECTED_BUNDLE_PATH"] {
        cmd.env_remove(k);
    }
}

/// 引擎还没跑过时的日志位置（与引擎 dataDir 一致）
pub fn default_log_file() -> PathBuf {
    let base = if cfg!(windows) {
        std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_else(|| home().join("AppData/Roaming"))
    } else if cfg!(target_os = "macos") {
        home().join("Library/Application Support")
    } else {
        home().join(".config")
    };
    // 日志与引擎共用旧数据目录名 cursor-zh-localizer（兼容已汉化用户的备份），不随项目改名
    base.join("cursor-zh-localizer").join("gui.log")
}
