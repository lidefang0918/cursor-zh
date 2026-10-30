// 失败码 → 给普通用户看的“下一步怎么做”。GUI 和命令行共用，保证说法一致。
export const NEXT_STEP = {
  NOT_FOUND: '请先安装 Cursor（或确认装在默认位置），再重新运行本工具。',
  UNSUPPORTED: '这个目录里的 Cursor 结构和已知版本差别太大（找不到界面文件），本工具没有动它。请确认选的是 Cursor 安装目录，或到 GitHub 反馈你的 Cursor 版本。',
  CURSOR_RUNNING: '请允许本工具关闭 Cursor（命令行加 --close），完成后会自动重新打开。',
  CLOSE_FAILED: '请用系统菜单退出 Cursor（macOS 用 ⌘Q，不要强制结束），再重试。',
  MODIFIED_INSTALL: 'Cursor 的文件被其他工具改过。请重新安装 Cursor（覆盖安装即可，不会丢设置），再重试。',
  PATCHED_NO_STATE: '请重新安装 Cursor（覆盖安装即可，不会丢设置），再重试；或用“还原”并指定备份目录。',
  INSTALL_CHANGED: 'Cursor 可能刚好在关闭时装上了自动更新。直接再点一次“一键汉化”即可。',
  PATCH_FAILED: '安装文件没有被改动。请把日志文件发给开发者。',
  FINISH_FAILED: '已自动回滚。请把日志文件发给开发者。',
  HELPER_FAILED: '管理员写入没有成功，安装文件未改动。请重试；仍失败请把日志文件发给开发者。',
  READ_ONLY_FS: '安装位于只读位置（如正在运行的 AppImage）。请使用“解包后汉化”。',
  OTHER_INSTALL: '先切换到那个已汉化的 Cursor 并“一键还原”，再汉化这个。',
  BACKUP_INVALID: '备份已损坏，无法自动还原。请重新安装 Cursor（覆盖安装即可，不会丢设置）。',
  BACKUP_MISMATCH: '备份不属于当前版本。请重新安装 Cursor（覆盖安装即可，不会丢设置）。',
  NO_BACKUP: '找不到备份。请重新安装 Cursor（覆盖安装即可，不会丢设置）。',
  REVERT_FAILED: '请重试；仍失败请重新安装 Cursor（覆盖安装即可，不会丢设置）。',
  NOT_LOCALIZED: '当前没有汉化，无需还原。',
  NEED_DIRECT_WRITE: '请改用默认的签名模式（adhoc）。',
  BUSY: '请等上一个操作完成。',
  EXCEPTION: '请把日志文件发给开发者。',
};
export const nextStep = (code) => NEXT_STEP[code] ?? null;
