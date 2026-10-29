# cursor-zh-localizer Windows 特权写入助手（唯一需要管理员权限的部分，等价于 czl-apply.sh）。
# 只做一件事：按清单把“已准备好的文件”放进 Cursor 安装目录，并逐个校验 sha256。
# 自动提权时主程序把本脚本正文经 -EncodedCommand 传给 UAC 提权后的 powershell（授权后无法被替换）；
# 手动模式：在“管理员 PowerShell”里执行 powershell -NoProfile -ExecutionPolicy Bypass -File czl-apply.ps1 -Manifest <清单>
# 清单（制表符分隔，UTF-8）：第 1 行 CZL1<TAB><安装根>；其余行 <sha256><TAB><源文件绝对路径><TAB><相对安装根的目标路径，/ 分隔>
# 退出码：0 成功；2 清单/参数不合法；3 源文件校验失败；4 写入失败（已尽量还原）；5 写入后校验失败
# 兼容 Windows PowerShell 5.1（Windows 10/11 自带）和 PowerShell 7。
param([string]$Manifest, [string]$ResultFile)
$ErrorActionPreference = 'Stop'
$log = New-Object System.Collections.Generic.List[string]
function Finish([int]$code, [string]$msg) {
  if ($msg) { $log.Add("czl-apply: $msg") }
  if ($ResultFile) { [IO.File]::WriteAllLines($ResultFile, [string[]]($log.ToArray() + "EXIT $code"), (New-Object Text.UTF8Encoding($false))) }
  foreach ($l in $log) { if ($code -eq 0) { Write-Output $l } else { [Console]::Error.WriteLine($l) } }
  exit $code
}
function Sha256Hex([byte[]]$bytes) {
  $h = [Security.Cryptography.SHA256]::Create()
  try { return (($h.ComputeHash($bytes) | ForEach-Object { $_.ToString('x2') }) -join '') } finally { $h.Dispose() }
}
function IsReparse([string]$p) { return ([IO.File]::GetAttributes($p) -band [IO.FileAttributes]::ReparsePoint) -ne 0 }
$sep = [IO.Path]::DirectorySeparatorChar

try {
  if (-not $Manifest -or -not [IO.File]::Exists($Manifest)) { Finish 2 "清单不存在：$Manifest" }
  $lines = [IO.File]::ReadAllLines($Manifest, [Text.Encoding]::UTF8)
  if ($lines.Count -lt 2) { Finish 2 '清单为空' }
  $head = $lines[0].Split("`t")
  if ($head.Count -ne 2 -or $head[0] -ne 'CZL1') { Finish 2 '清单格式不对' }
  if (-not [IO.Path]::IsPathRooted($head[1])) { Finish 2 "安装根必须是绝对路径：$($head[1])" }
  $root = [IO.Path]::GetFullPath($head[1]).TrimEnd('\', '/')
  if (-not [IO.Directory]::Exists($root)) { Finish 2 "安装根不存在：$root" }
  $product = [IO.Path]::Combine($root, 'resources', 'app', 'product.json')
  if (-not [IO.File]::Exists($product)) { Finish 2 "不是 Cursor 安装目录：$root" }
  if ([IO.File]::ReadAllText($product) -notmatch '"nameShort":\s*"Cursor"') { Finish 2 "product.json 不是 Cursor：$product" }

  $items = @()
  for ($i = 1; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -eq '') { continue }
    $f = $lines[$i].Split("`t")
    if ($f.Count -ne 3) { Finish 2 "清单第 $($i + 1) 行格式不对" }
    $sha = $f[0]; $src = $f[1]; $rel = $f[2]
    if ($sha -cnotmatch '^[0-9a-f]{64}$') { Finish 2 "sha256 不合法：$sha" }
    # 只允许改 Cursor 应用代码目录里的 .js/.json
    if ($rel -notmatch '^resources/app/[^:*?"<>|]+\.(js|json)$' -or $rel -match '(^|/)\.\.(/|$)' -or $rel -match '\\') { Finish 2 "不允许修改：$rel" }
    $dst = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel.Replace('/', $sep)))
    if (-not $dst.StartsWith($root + $sep, [StringComparison]::OrdinalIgnoreCase)) { Finish 2 "目标逃出安装根：$dst" }
    if (-not [IO.File]::Exists($dst) -or (IsReparse $dst)) { Finish 2 "目标不是普通文件：$dst" }
    # 目标所在各级目录都不能是联接点/符号链接
    $d = [IO.Path]::GetDirectoryName($dst)
    while ($d.Length -gt $root.Length) { if (IsReparse $d) { Finish 2 "目标路径含链接：$d" }; $d = [IO.Path]::GetDirectoryName($d) }
    if (-not [IO.File]::Exists($src) -or (IsReparse $src)) { Finish 2 "源文件不存在：$src" }
    # 读进内存后校验并写出同一份字节，校验和写入之间源文件无法被替换
    $bytes = [IO.File]::ReadAllBytes($src)
    if ((Sha256Hex $bytes) -ne $sha) { Finish 3 "源文件校验失败：$src" }
    $items += ,@($sha, $bytes, $dst)
  }
  if ($items.Count -eq 0) { Finish 2 '清单里没有文件' }

  # 第一步：全部先写成同目录下的 .czl-new，任何一个失败就清理并退出，安装目录不变
  try { foreach ($it in $items) { [IO.File]::WriteAllBytes($it[2] + '.czl-new', $it[1]) } }
  catch {
    foreach ($it in $items) { Remove-Item -LiteralPath ($it[2] + '.czl-new') -Force -ErrorAction SilentlyContinue }
    Finish 4 "写入失败（安装目录未改动）：$($_.Exception.Message)"
  }
  # 第二步：逐个替换（文件被占用时重试几次）
  foreach ($it in $items) {
    $done = $false
    for ($t = 0; $t -lt 10 -and -not $done; $t++) {
      try { Move-Item -LiteralPath ($it[2] + '.czl-new') -Destination $it[2] -Force; $done = $true }
      catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $done) { Finish 4 "替换失败（文件被占用？）：$($it[2])" }
  }
  # 第三步：校验
  foreach ($it in $items) {
    if ((Sha256Hex ([IO.File]::ReadAllBytes($it[2]))) -ne $it[0]) { Finish 5 "写入后校验失败：$($it[2])" }
    $log.Add("OK $($it[2])")
  }
  Finish 0 ''
} catch {
  Finish 4 "意外错误：$($_.Exception.Message)"
}
