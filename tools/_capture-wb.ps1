# PrintWindow capture of the workbench app window (ASCII only - GBK safe)
# Usage: powershell -File _capture-wb.ps1 <tabname>
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class WCap2 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class WEnum2 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hwnd, StringBuilder sb, int max);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lp);
  public static List<IntPtr> FindByPid(int targetPid) {
    var list = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint p; GetWindowThreadProcessId(h, out p);
      if (p == (uint)targetPid && IsWindowVisible(h)) list.Add(h);
      return true;
    }, IntPtr.Zero);
    return list;
  }
}
"@
# Find the msedge process whose command line contains --app= (ASCII match)
$proc = Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -match '--app=' } | Select-Object -First 1
if (-not $proc) { Write-Host 'NO APP PROCESS'; exit 1 }
$wins = [WEnum2]::FindByPid([int]$proc.ProcessId)
if ($wins.Count -eq 0) { Write-Host 'NO WINDOW'; exit 1 }
# pick the largest window (the app frame, not tiny popups)
$best = $null; $bestArea = 0
foreach ($h in $wins) {
  $rect = New-Object WCap2+RECT
  [WinCap2]::GetWindowRect($h, [ref]$rect) | Out-Null
  $area = ($rect.Right - $rect.Left) * ($rect.Bottom - $rect.Top)
  if ($area -gt $bestArea) { $bestArea = $area; $best = $h }
}
$rect = New-Object WCap2+RECT
[WinCap2]::GetWindowRect($best, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left; $h = $rect.Bottom - $rect.Top
$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
[WinCap2]::PrintWindow($best, $hdc, 2) | Out-Null
$g.ReleaseHdc($hdc)
$out = 'D:\AI\zcode\wb-tab-' + $args[0] + '.png'
$bmp.Save($out)
$g.Dispose(); $bmp.Dispose()
Write-Host ('saved ' + $out + ' ' + $w + 'x' + $h)
