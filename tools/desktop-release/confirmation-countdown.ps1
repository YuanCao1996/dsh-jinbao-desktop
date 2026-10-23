# One countdown shared by large panel and narrow popup. Snapshot refreshes never restart it.
$script:confirmationClockId='';$script:confirmationClockKey='';$script:confirmationDeadline=0.0;$script:confirmationHandledId=''
$script:confirmationLastTick=0.0;$script:confirmationPaused=$false
function Get-ConfirmationNow {
 if($null -ne $script:confirmationTestNow){return [double]$script:confirmationTestNow}
 return [Diagnostics.Stopwatch]::GetTimestamp()*1000.0/[Diagnostics.Stopwatch]::Frequency
}
function Get-ConfirmationChoiceKey($prompt){
 if(!$prompt){return ''}
 return ([string]$prompt.id)+':'+(ConvertTo-Json -Compress -InputObject @($prompt.options|ForEach-Object {@([string]$_.name,[string]$_.label)}))
}
function Set-ConfirmationChoiceStyle($button,$option,[bool]$isDefault){
 $button.Content=$(if($isDefault){'✓ '+[string]$option.label+' · 默认'}else{[string]$option.label})
 if($isDefault){$button.Background='#344E47';$button.Foreground='#D6F4DF';$button.BorderBrush='#8CC5A3';$button.BorderThickness=2}
}
function Update-ConfirmationCountdown {
 $prompt=$script:snapshot.confirmation
 if(!$prompt){$script:confirmationClockId='';$script:confirmationClockKey='';$script:confirmationHandledId='';return}
 $id=[string]$prompt.id;$now=Get-ConfirmationNow
 $key=Get-ConfirmationChoiceKey $prompt
 if($id -ne $script:confirmationClockId -or $key -ne $script:confirmationClockKey){
  $script:confirmationClockKey=$key
  $script:confirmationClockId=$id;$script:confirmationDeadline=$now+10000.0
  $script:confirmationHandledId='';$script:confirmationLastTick=$now;$script:confirmationPaused=$false
 }
 # A hidden silent ball must not silently adopt an unseen option.
 $hidden=$script:displayMode -eq 'silent' -or $script:collapsed
 if($hidden -or $script:confirmationPaused){$script:confirmationDeadline+=[Math]::Max(0,$now-$script:confirmationLastTick)}
 $script:confirmationPaused=$hidden;$script:confirmationLastTick=$now
 if($script:confirmationHandledId -eq $id){return}
 $seconds=[int][Math]::Max(0,[Math]::Min(10,[Math]::Ceiling(($script:confirmationDeadline-$now)/1000.0)))
 $text=[string]$prompt.title+' · '+$seconds+' 秒后默认确认'
 $controls.ConfirmationTitle.Text=$text
 if($script:quickConfirmationTitle){$script:quickConfirmationTitle.Text=$text}
 if(!$hidden -and $seconds -eq 0 -and !$script:confirmationJob){
  $options=@($prompt.options)
  if($options.Count -gt 0){
   $script:confirmationHandledId=$id
   Start-Confirmation @{id=$id;name=[string]$options[0].name;timeoutDefault=$true}
   $controls.ConfirmationPanel.Visibility='Collapsed';$quickConfirm.IsOpen=$false
  }
 }
}
