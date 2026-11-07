# 一次性:启动工作台(独立 profile)并保留窗口,供逐页 PrintWindow 截图
Start-Process msedge -ArgumentList @(
  '--app=http://127.0.0.1:7396/workbench',
  '--remote-debugging-port=9222',
  ('--user-data-dir=' + (Join-Path $env:TEMP 'wblayout'))
)
Start-Sleep -Seconds 9
Write-Host 'launched'
