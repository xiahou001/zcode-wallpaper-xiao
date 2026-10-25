' Launch ZCode with the wallpaper server silently.
Dim fso, shell, root, nodeExe, zcodeExe, command, req
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
root = fso.GetParentFolderName(WScript.ScriptFullName)
nodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\nodejs\node.exe"
If Not fso.FileExists(nodeExe) Then nodeExe = "node"
zcodeExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\ZCode\ZCode.exe"
If Not fso.FileExists(zcodeExe) Then zcodeExe = shell.ExpandEnvironmentStrings("%ProgramFiles%") & "\ZCode\ZCode.exe"
shell.CurrentDirectory = root
Function Q(ByVal value)
  Q = Chr(34) & value & Chr(34)
End Function
Function ServerReady()
  On Error Resume Next
  Set req = CreateObject("WinHttp.WinHttpRequest.5.1")
  req.SetTimeouts 500, 500, 500, 500
  req.Open "GET", "http://127.0.0.1:7396/api/state", False
  req.Send
  ServerReady = (Err.Number = 0 And req.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function
If Not ServerReady() Then
  command = Q(nodeExe) & " " & Q(root & "\server.mjs")
  shell.Run command, 0, False
  For i = 1 To 20
    WScript.Sleep 250
    If ServerReady() Then Exit For
  Next
End If
If fso.FileExists(zcodeExe) Then
  ' --remote-debugging-port:壁纸注入的 CDP 轨道(只绑 127.0.0.1,零改安装文件);
  ' 壁纸服务器检测到该端口即自动挂入壁纸层。不带此参数启动时回落 asar 补丁轨道。
  shell.Run Q(zcodeExe) & " --remote-debugging-port=9333", 1, False
End If
