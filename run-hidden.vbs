' Silent launcher for the time router (no console window).
' All output goes to router.log; check that file if the router does not come up.
Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
sh.CurrentDirectory = dir

logFile = dir & "\router.log"
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 2000000 Then fso.DeleteFile logFile, True
End If

' Prefer node on PATH; fall back to the usual install location.
nodeExe = "node"
defaultNode = sh.ExpandEnvironmentStrings("%ProgramFiles%\nodejs\node.exe")
If fso.FileExists(defaultNode) Then nodeExe = """" & defaultNode & """"

sh.Run "cmd /c " & nodeExe & " --env-file=.env router.mjs >> ""router.log"" 2>&1", 0, False
