# 抓现行 v2:WMI 事件订阅,捕获 10 分钟内所有 node.exe 创建事件(含瞬命实例),
# 记录 PID/父 PID/命令行到文件。单个常驻 PowerShell,无采样间隙。
$log = "$env:TEMP\node-spawn-watch.log"
"watch start $(Get-Date -Format HH:mm:ss)" | Out-File $log -Encoding utf8
$q = "SELECT * FROM __InstanceCreationEvent WITHIN 1 WHERE TargetInstance ISA 'Win32_Process' AND TargetInstance.Name='node.exe'"
Register-CimIndicationEvent -Query $q -SourceIdentifier NodeSpawnWatch | Out-Null
$deadline = (Get-Date).AddMinutes(10)
while ((Get-Date) -lt $deadline) {
  $e = Wait-Event -SourceIdentifier NodeSpawnWatch -Timeout 2
  if ($e) {
    $t = $e.SourceEventArgs.NewEvent.TargetInstance
    $line = "{0} PID={1} PARENT={2} CMD={3}" -f (Get-Date -Format HH:mm:ss), $t.ProcessId, $t.ParentProcessId, $t.CommandLine
    Add-Content $log $line -Encoding utf8
    # 趁父进程活着查它的命令行
    Start-Sleep -Milliseconds 150
    $pcmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($t.ParentProcessId)" -ErrorAction SilentlyContinue).CommandLine
    Add-Content $log "  parent-cmd: $pcmd" -Encoding utf8
    Remove-Event -EventIdentifier $e.EventIdentifier
  }
}
Unregister-Event -SourceIdentifier NodeSpawnWatch
"watch done $(Get-Date -Format HH:mm:ss)" | Add-Content $log -Encoding utf8
