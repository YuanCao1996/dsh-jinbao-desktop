$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot '../confirmation-countdown.ps1')
$controls=@{ConfirmationTitle=[pscustomobject]@{Text=''};ConfirmationPanel=[pscustomobject]@{Visibility='Visible'}}
$quickConfirm=[pscustomobject]@{IsOpen=$true};$script:confirmationJob=$null
$script:displayMode='large';$script:collapsed=$false;$script:submitted=@()
function Start-Confirmation($payload){$script:submitted+=,$payload}
function Check($name,$ok){if(!$ok){throw "Countdown regression: $name"};Write-Output "PASS $name"}
function Prompt($id){return [pscustomobject]@{id=$id;title='选择确认';options=@([pscustomobject]@{name='A';label='A'},[pscustomobject]@{name='B';label='B'})}}
$script:snapshot=[pscustomobject]@{confirmation=(Prompt 'one')}
$script:confirmationTestNow=1000;Update-ConfirmationCountdown
Check 'starts at 10 seconds' ($controls.ConfirmationTitle.Text -match '10 秒后默认确认')
$script:confirmationTestNow=2000;Update-ConfirmationCountdown
Check 'refresh does not reset deadline' ($controls.ConfirmationTitle.Text -match '9 秒后默认确认')
$script:confirmationTestNow=11000;Update-ConfirmationCountdown;Update-ConfirmationCountdown
Check 'one default submission, first choice, distinct source' ($script:submitted.Count -eq 1 -and $script:submitted[0].name -eq 'A' -and $script:submitted[0].timeoutDefault)
Check 'hides both confirmation surfaces' ($controls.ConfirmationPanel.Visibility -eq 'Collapsed' -and !$quickConfirm.IsOpen)
$script:snapshot.confirmation=Prompt 'two';$script:confirmationTestNow=12000;Update-ConfirmationCountdown
$script:confirmationHandledId='two';$script:confirmationTestNow=23000;Update-ConfirmationCountdown
Check 'manual response cancels automatic action' ($script:submitted.Count -eq 1)
$script:snapshot.confirmation=Prompt 'three';$script:confirmationTestNow=24000;Update-ConfirmationCountdown
$script:displayMode='silent';$script:confirmationTestNow=35000;Update-ConfirmationCountdown
Check 'hidden silent mode never auto accepts' ($script:submitted.Count -eq 1)
$script:displayMode='large';$script:confirmationTestNow=36000;Update-ConfirmationCountdown
Check 'unhide preserves remaining time' ($controls.ConfirmationTitle.Text -match '10 秒后默认确认')
$script:snapshot.confirmation=$null;Update-ConfirmationCountdown
Check 'cleared task drops countdown' (!$script:confirmationClockId)
$button=[pscustomobject]@{Content='';Background='';Foreground='';BorderBrush='';BorderThickness=0}
Set-ConfirmationChoiceStyle $button ([pscustomobject]@{label='A'}) $true
Check 'default checkmark and visible border' ($button.Content -eq '✓ A · 默认' -and $button.BorderThickness -eq 2)
$script:snapshot.confirmation=Prompt 'four';$script:confirmationTestNow=40000;Update-ConfirmationCountdown
$script:confirmationTestNow=49000;Update-ConfirmationCountdown
$script:snapshot.confirmation.options=@([pscustomobject]@{name='B';label='B'},[pscustomobject]@{name='A';label='A'})
Update-ConfirmationCountdown
Check 'changed options reset visible default countdown' ($controls.ConfirmationTitle.Text -match '10 秒后默认确认')
$script:confirmationTestNow=59000;Update-ConfirmationCountdown
Check 'adopts the newly displayed first choice only' ($script:submitted[-1].name -eq 'B')
