# Agenda a coleta do Radar de Carteiras para rodar de hora em hora, sem abrir janela.
# Para remover: Unregister-ScheduledTask -TaskName "RadarCarteiras" -Confirm:$false
$python = "C:\Python314\pythonw.exe"
$script = "D:\Claude\radar-baleias\coletor\coleta_hora.py"
$proxima = (Get-Date).Date.AddHours((Get-Date).Hour + 1)

$acao = New-ScheduledTaskAction -Execute $python -Argument "`"$script`"" -WorkingDirectory (Split-Path $script)
$gatilho = New-ScheduledTaskTrigger -Once -At $proxima -RepetitionInterval (New-TimeSpan -Hours 1) -RepetitionDuration (New-TimeSpan -Days 3650)
# roda na bateria, recupera a hora perdida quando o PC volta da suspensão, no máximo 2 h por execução
$config = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName "RadarCarteiras" -Action $acao -Trigger $gatilho -Settings $config `
  -Description "Radar de Carteiras: foto das posições, alertas e Diário de sinais (Hyperliquid)" -Force | Out-Null
Get-ScheduledTask -TaskName "RadarCarteiras" | Get-ScheduledTaskInfo | Select-Object TaskName, NextRunTime

