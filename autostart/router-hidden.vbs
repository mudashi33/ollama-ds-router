' Launches the router supervisor hidden and waits for it.
' Used as the scheduled task action so no console window ever flashes.
Option Explicit
Dim sh, fso, base, root, nodeExe, target, cmd
Set sh = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
base = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(base)
nodeExe = "D:\nodejs\node.exe"
target = root & "\tools\supervisor.mjs"
If fso.FileExists(nodeExe) And fso.FileExists(target) Then
  cmd = Chr(34) & nodeExe & Chr(34) & " " & Chr(34) & target & Chr(34)
Else
  cmd = Chr(34) & base & "\router-loop.cmd" & Chr(34)
End If
sh.Run cmd, 0, True
