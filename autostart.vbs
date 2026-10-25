' Wallpaper-only startup watchdog with auto-repair after ZCode updates.
' This script never launches ZCode or zcode-host.
' Login flow(修复「登录时卡顿」):
'   1) 壁纸服务器立即拉起 + 看护循环 —— 登录几秒内壁纸可用,不再等修复
'   2) tools/repair.js 异步跟随(状态自愈 + asar 注入 + 影子清理;ZCode 运行中自动跳过危险步骤)
'   3) tools/resync-injection.js 每 300s —— ZCode 更新后自动恢复注入
Dim fso, shell, projectDir, nodeExe, command, tick
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
Function Q(ByVal value)
  Q = Chr(34) & value & Chr(34)
End Function
Function ServerReady()
  On Error Resume Next
  Dim req
  Set req = CreateObject("WinHttp.WinHttpRequest.5.1")
  req.SetTimeouts 800, 800, 800, 800
  req.Open "GET", "http://127.0.0.1:7396/api/state", False
  req.Send
  ServerReady = (Err.Number = 0 And req.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function
Sub EnsureServer()
  If ServerReady() Then Exit Sub
  command = Q(nodeExe) & " " & Q(projectDir & "\server.mjs")
  shell.Run command, 0, False
  For i = 1 To 20
    If ServerReady() Then Exit For
    WScript.Sleep 500
  Next
End Sub
' 1) 服务器立即拉起 + 看护循环
tick = 0
EnsureServer()
' 1b) 可选:开机自动启动 ZCode(带 CDP 调试端口 = 壁纸注入的零改文件轨道)
'     仅当标记文件存在时执行,每次登录一次;开关由工作台「注入状态」管理
Dim zcodeLaunched, flagPath, zcodeExe
zcodeLaunched = False
flagPath = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.we-wallpaper\autostart-zcode.flag"
zcodeExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\ZCode\ZCode.exe"
If fso.FileExists(flagPath) And fso.FileExists(zcodeExe) Then
  shell.Run Q(zcodeExe) & " --remote-debugging-port=9333", 1, False
  zcodeLaunched = True
End If
' 2) 修复一次(异步,不阻塞;repair.js 内部对 ZCode 运行中有保守跳过)
shell.Run Q(nodeExe) & " " & Q(projectDir & "\tools\repair.js"), 0, False
' 3) 看护循环
Do
  WScript.Sleep 5000
  EnsureServer()
  tick = tick + 1
  If tick >= 60 Then
    tick = 0
    shell.Run Q(nodeExe) & " " & Q(projectDir & "\tools\resync-injection.js"), 0, False
  End If
Loop
