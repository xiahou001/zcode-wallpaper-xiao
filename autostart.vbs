' Wallpaper-only startup watchdog with auto-repair after ZCode updates.
' Login flow:
'   1) Start the wallpaper server immediately + keepalive loop (wallpaper ready in seconds)
'   2) tools/repair.js async follow-up (state self-heal + asar patch + shadow cleanup)
'   3) tools/resync-injection.js every 60 ticks - restore injection after ZCode updates
'   1b) OPTIONAL: launch ZCode with --remote-debugging-port=9333 (CDP injection track)
'       ONLY when the flag file exists (workbench toggle manages it); once per login.
' Env hygiene: strip ELECTRON_RUN_AS_NODE / NODE_OPTIONS before spawning anything -
' when inherited from a node host session, ZCode.exe runs as a bare node interpreter
' (rejects every Chromium switch) and the window never appears.
' NOTE: keep this file ASCII-only - wscript reads .vbs with the ANSI codepage (GBK),
' UTF-8 Chinese comments get mojibake'd by editors (see git history).
Dim fso, shell, shellEnv, projectDir, nodeExe, command, tick
Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")
Set shellEnv = shell.Environment("PROCESS")
shellEnv.Remove "ELECTRON_RUN_AS_NODE"
shellEnv.Remove "ELECTRON_NO_ATTACH_CONSOLE"
shellEnv.Remove "NODE_OPTIONS"
shellEnv.Remove "NODE_ENV"
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
  ' 2000ms: 800ms was too tight - transient event-loop stalls (boot sweeps, GC,
  ' antivirus scans) made healthy servers fail the probe, so EnsureServer spawned
  ' a second instance that always lost the port race (leaking a poller each time).
  req.SetTimeouts 2000, 2000, 2000, 2000
  ' DIRECT (no proxy): a system VPN/proxy app can route 127.0.0.1 probes at the
  ' proxy, failing against a healthy server (spawning a doomed second instance).
  req.SetProxy 1
  req.Open "GET", "http://127.0.0.1:7396/api/state", False
  req.Send
  ServerReady = (Err.Number = 0 And req.Status = 200)
  Err.Clear
  On Error GoTo 0
End Function
Sub EnsureServer()
  If ServerReady() Then Exit Sub
  ' Double-check before spawning: transient VPN/Winsock blips fail a single probe
  ' against a healthy server, and the doomed second instance always loses the
  ' port race (leaking its poller). Re-probe once after 1.2s first.
  WScript.Sleep 1200
  If ServerReady() Then Exit Sub
  command = Q(nodeExe) & " " & Q(projectDir & "\server.mjs")
  shell.Run command, 0, False
  For i = 1 To 20
    If ServerReady() Then Exit For
    WScript.Sleep 500
  Next
End Sub
' 1) server immediately
tick = 0
EnsureServer()
' 1b) optional ZCode launch with CDP port (flag-gated, once per login)
Dim zcodeLaunched, flagPath, zcodeExe
zcodeLaunched = False
flagPath = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.we-wallpaper\autostart-zcode.flag"
zcodeExe = shell.ExpandEnvironmentStrings("%LOCALAPPDATA%") & "\Programs\ZCode\ZCode.exe"
If fso.FileExists(flagPath) And fso.FileExists(zcodeExe) Then
  shell.Run Q(zcodeExe) & " --remote-debugging-port=9333", 1, False
  zcodeLaunched = True
End If
' 2) repair once (async)
shell.Run Q(nodeExe) & " " & Q(projectDir & "\tools\repair.js"), 0, False
' 3) keepalive loop + periodic resync
Do
  WScript.Sleep 5000
  EnsureServer()
  tick = tick + 1
  If tick >= 60 Then
    tick = 0
    shell.Run Q(nodeExe) & " " & Q(projectDir & "\tools\resync-injection.js"), 0, False
  End If
Loop
