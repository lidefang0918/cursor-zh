# 更新日志

## v0.2.5 (2026-11-10)

### 新增适配
- 完整锚点文件新增 **Cursor 3.28.7** 和 **3.29.9**（离线试打通过）
- 兼容模式支持 Cursor 3.29.15（部分文案在此版本未匹配，详见 Issue #8）

### 签名流程调整
- macOS 重签名改用本地固定证书 **`cursor-zh-local`**（替代每次生成的 ad-hoc）
  - Device Requirement 在重签名后保持稳定，减少钥匙串访问授权重置
  - 首次重签名时需要管理员授权将证书加入**系统钥匙串信任**（System Keychain，一次性）；如拒绝授权，工具报错并**中止本次重签名**，不会回退到 ad-hoc
  - 曾尝试重签名后对主程序 copy+rename 换新 inode 以缓解 CS_KILLED，但该方案已撤销（会将 codesign 刚挂上的签名缓存一起克隆走）

### 版本变更保护
- revert 和汉化流程新增 version + commit 双重一致性检查，防止 Squirrel/ShipIt 自动更新与汉化并发时将旧版二进制写入新版 bundle（TOCTOU 竞态缓解）
- backup 期间若检测到安装目录已变更，立即中止，避免将新版文件覆盖为旧版备份
- live product.json 读取失败时 fail-closed（不静默继续，立即中止）
- 签名校验失败（`codesign --verify --deep --strict`）时不自动重开 Cursor，避免以不完整 bundle 启动

### 已知限制
- **CS_KILLED（Code Signature Invalid）**：尚未完全修复。将证书加入系统钥匙串信任是当前的缓解方向，但在特定 macOS 版本和进程时序下仍可能发生。遇到时点"一键还原"后重新下载 Cursor 再汉化

---

## v0.2.4

- 初始正式发布，支持 Cursor 3.27.14 / 3.27.22
- Windows / macOS / Linux 三平台发布（macOS Universal、Windows x64 安装包 + 便携版、Linux deb + AppImage）
