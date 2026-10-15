# Detect only the old Jinbao LoL overlay in this interactive Windows session.
# Never stop it or match arbitrary processes containing the word "overlay".
function Find-JinbaoLegacyOverlay {
    param([object[]]$Processes)
    $sessionId=(Get-Process -Id $PID).SessionId
    if(!$PSBoundParameters.ContainsKey('Processes')) {
        $Processes=@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe'" -ErrorAction Stop)
    }
    foreach($process in $Processes) {
        if($process.ProcessId -eq $PID -or $process.SessionId -ne $sessionId){continue}
        if($process.Name -notmatch '^(powershell|pwsh)\.exe$'){continue}
        $command=[string]$process.CommandLine
        if($command -notmatch '(?i)(?:^|\s)-File\s+(?:"(?<quoted>[^"\r\n]+)"|(?<plain>\S+))'){continue}
        $script=if($matches.quoted){$matches.quoted}else{$matches.plain}
        if($script -notmatch '(?i)[\\/]tools[\\/]lol-companion[\\/]overlay\.ps1$'){continue}
        [pscustomobject]@{pid=$process.ProcessId;script=$script}
    }
}
