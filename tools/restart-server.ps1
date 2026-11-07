# 一次性:重启壁纸服务器(长期保留)
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'server\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Milliseconds 800
Start-Process -FilePath 'C:\Program Files\nodejs\node.exe' -ArgumentList 'D:\AI\zcode\.zcode\workspace\default\we-wallpaper\server.mjs' -WorkingDirectory 'D:\AI\zcode\.zcode\workspace\default\we-wallpaper' -WindowStyle Hidden
Start-Sleep -Seconds 3
Write-Host 'restarted'
