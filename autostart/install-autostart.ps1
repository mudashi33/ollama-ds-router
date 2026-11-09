$ErrorActionPreference = 'Stop'
$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$vbs  = Join-Path $base 'router-hidden.vbs'
$name = 'Ollama-DS-Router'
$wscript = Join-Path $env:WINDIR 'System32\wscript.exe'

Write-Output ("vbs=" + $vbs)
Write-Output ("vbsExists=" + (Test-Path -LiteralPath $vbs))

$action   = New-ScheduledTaskAction -Execute $wscript -Argument ('"' + $vbs + '"')
$trigger  = New-ScheduledTaskTrigger -AtLogOn -User ($env:USERDOMAIN + '\' + $env:USERNAME)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew -StartWhenAvailable

Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Description 'Ollama DS router: keeps node server.mjs alive on 127.0.0.1:8788 so DSH has an upstream.' -Force | Out-Null
Write-Output ("registered=" + $name)

$t = Get-ScheduledTask -TaskName $name
Write-Output ("state=" + $t.State)
$p = $t.Principal
Write-Output ("principal=" + $p.UserId + " runLevel=" + $p.RunLevel)
Write-Output ("trigger=" + $t.Triggers[0].CimClass.CimClassName)
Write-Output ("execLimit=" + $t.Settings.ExecutionTimeLimit)
