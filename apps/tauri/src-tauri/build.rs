// 构建时把 JS 引擎（引擎源码、词典、锚点、dom-runtime、engine-ipc.mjs、语言包 vsix）打成一个压缩块嵌进可执行文件。
// 运行时解到缓存目录再用借来的 Cursor（ELECTRON_RUN_AS_NODE=1）执行——这样 Windows 便携版也只有一个 exe。
// 格式：deflate( 重复 [u32 LE 路径长度][路径][u32 LE 内容长度][内容] )；CZL_ENGINE_HASH = 未压缩内容的 FNV-1a 64。
use std::{env, fs, path::{Path, PathBuf}};

const VSIX: &str = "ms-ceintl.vscode-language-pack-zh-hans-1.128.0.vsix";

fn walk(base: &Path, rel: &str, out: &mut Vec<(String, PathBuf)>) {
    let p = base.join(rel);
    println!("cargo:rerun-if-changed={}", p.display());
    if p.is_dir() {
        let mut names: Vec<_> = fs::read_dir(&p).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        for n in names {
            if n == "node_modules" || n.starts_with('.') { continue; }
            walk(base, &format!("{rel}/{n}"), out);
        }
    } else if p.is_file() {
        out.push((rel.to_string(), p));
    } else {
        panic!("缺少 {}", p.display());
    }
}

fn main() {
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let repo = manifest.join("../../..").canonicalize().unwrap();
    let mut files = Vec::new();
    for rel in ["anchors", "dicts", "packages/engine/src", "packages/engine/helper", "packages/engine/package.json", "packages/dom-runtime", "scripts/engine-ipc.mjs"] {
        walk(&repo, rel, &mut files);
    }
    let mut blob: Vec<u8> = Vec::new();
    let mut push = |name: &str, data: &[u8]| {
        blob.extend((name.len() as u32).to_le_bytes());
        blob.extend(name.as_bytes());
        blob.extend((data.len() as u32).to_le_bytes());
        blob.extend(data);
    };
    for (rel, p) in &files { push(rel, &fs::read(p).unwrap()); }
    let ver = env::var("CARGO_PKG_VERSION").unwrap();
    push("package.json", format!("{{\n  \"name\": \"cursor-zh\",\n  \"version\": \"{ver}\",\n  \"private\": true,\n  \"type\": \"module\"\n}}\n").as_bytes());

    // 语言包：随包带上，离线也能装；找不到就运行时由引擎下载（并缓存）
    let home = env::var("HOME").or_else(|_| env::var("USERPROFILE")).unwrap_or_default();
    let mut cands: Vec<PathBuf> = Vec::new();
    if let Ok(v) = env::var("CZL_VSIX") { cands.push(v.into()); }
    cands.push(repo.join("vendor").join(VSIX));
    cands.push(Path::new(&home).join(".config/cursor-zh-localizer/cache").join(VSIX));
    cands.push(Path::new(&home).join("Library/Application Support/cursor-zh-localizer/cache").join(VSIX));
    if let Ok(a) = env::var("APPDATA") { cands.push(Path::new(&a).join("cursor-zh-localizer/cache").join(VSIX)); }
    println!("cargo:rerun-if-env-changed=CZL_VSIX");
    match cands.iter().find(|p| p.is_file()) {
        Some(p) => { println!("cargo:rerun-if-changed={}", p.display()); push(&format!("vendor/{VSIX}"), &fs::read(p).unwrap()); }
        None => println!("cargo:warning=没找到 {VSIX}，产物不带离线语言包（运行时会联网下载）"),
    }

    let mut h: u64 = 0xcbf29ce484222325;
    for b in &blob { h ^= *b as u64; h = h.wrapping_mul(0x100000001b3); }
    let packed = miniz_oxide::deflate::compress_to_vec(&blob, 9);
    let out = PathBuf::from(env::var("OUT_DIR").unwrap());
    fs::write(out.join("engine.bin"), packed).unwrap();
    println!("cargo:rustc-env=CZL_ENGINE_HASH={h:016x}");
    println!("cargo:rustc-env=CZL_ENGINE_FILES={}", files.len() + 1);

    tauri_build::build()
}
