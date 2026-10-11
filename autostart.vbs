' Wallpaper-only startup watchdog.
' This script never launches ZCode or zcode-host.
' 登录流程:① 注入再同步(asar 补丁 + 影子目录清理,ZCode 更新后自动恢复注入)
'          ② 壁纸服务器拉起 + 每 5 秒看护
Dim fso, shell, projectDir, nodeExe, command
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
' ① 注入再同步(ZCode 更新会替换 asar 使注入失效;此处自动重新补丁并清理影子目录)
shell.CurrentDirectory = projectDir
shell.Run Q(nodeExe) & " " & Q(projectDir & "\tools\resync-injection.js"), 0, True
' ② 服务器看护
shell.CurrentDirectory = projectDir
Sub EnsureServer()
  If ServerReady() Then Exit Sub
  command = Q(nodeExe) & " " & Q(projectDir & "\server.mjs")
  shell.Run command, 0, False
  For i = 1 To 20
    If ServerReady() Then Exit For
    WScript.Sleep 500
  Next
End Sub
EnsureServer()
Do
  WScript.Sleep 5000
  EnsureServer()
Loop
