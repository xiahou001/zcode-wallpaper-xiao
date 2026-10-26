' ZCode launcher: starts the wallpaper server if needed, then opens ZCode.
' ELECTRON_RUN_AS_NODE must be stripped before spawning ZCode.exe. When it is
' inherited (e.g. from a DeepSeek Harness / node host session), ZCode.exe runs
' as a bare node interpreter, rejects every Chromium switch with 'bad option'
' and exits silently with code 0 or 9 -- the window never appears.
Dim fso, shell, env, root, nodeExe, zcodeExe, command, req, i
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set env = shell.Environment("PROCESS")
env.Remove "ELECTRON_RUN_AS_NODE"
env.Remove "ELECTRON_NO_ATTACH_CONSOLE"
env.Remove "NODE_OPTIONS"
env.Remove "NODE_ENV"
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
  shell.Run Q(zcodeExe) & " --remote-debugging-port=9333", 1, False
End If
