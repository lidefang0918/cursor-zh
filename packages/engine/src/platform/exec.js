import { execFile } from 'node:child_process';

// 统一的外部命令执行：永不抛错，返回 {code, stdout, stderr, spawnError}；测试里整个替换成假 runner
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 16 << 20, windowsHide: true, ...opts }, (err, stdout, stderr) => {
      resolve({
        code: err ? (typeof err.code === 'number' ? err.code : 127) : 0,
        stdout: String(stdout ?? ''), stderr: String(stderr ?? ''),
        spawnError: err && typeof err.code === 'string' ? err.code : null,
      });
    });
  });
}
