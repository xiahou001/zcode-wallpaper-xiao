# Catch spawner v2: WMI event subscription, capture ALL node.exe creations
# for 10 minutes (incl. very short-lived instances). One persistent PowerShell,
# no sampling gaps. NOTE: ASCII only - PowerShell 5.1 reads .ps1 as ANSI(GBK).
$log = "D:\AI\zcode\node-spawn-watch.log"
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
    Start-Sleep -Milliseconds 150
    $pcmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$($t.ParentProcessId)" -ErrorAction SilentlyContinue).CommandLine
    Add-Content $log "  parent-cmd: $pcmd" -Encoding utf8
    Remove-Event -EventIdentifier $e.EventIdentifier
  }
}
Unregister-Event -SourceIdentifier NodeSpawnWatch
"watch done $(Get-Date -Format HH:mm:ss)" | Add-Content $log -Encoding utf8
