[CmdletBinding()]
param(
    [switch]$Detached
)

$ErrorActionPreference = 'Stop'

function Resolve-SteamRoot {
    try {
        $rawPath = (Get-ItemProperty -Path 'HKCU:\Software\Valve\Steam' -Name SteamPath -ErrorAction Stop).SteamPath
        if ($rawPath) {
            $candidate = [IO.Path]::GetFullPath($rawPath.Replace('/', '\'))
            if (Test-Path -LiteralPath (Join-Path $candidate 'steam.exe')) {
                return $candidate
            }
        }
    } catch {
        # Fall through to the path derived from this plugin directory.
    }

    $candidate = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..\..'))
    if (Test-Path -LiteralPath (Join-Path $candidate 'steam.exe')) {
        return $candidate
    }

    throw 'Steam installation could not be located.'
}

$steamRoot = Resolve-SteamRoot
$steamExe = Join-Path $steamRoot 'steam.exe'
$logPath = Join-Path $steamRoot 'logs\luatools_restart.log'

function Write-RestartLog([string]$Message) {
    $line = '[{0:yyyy-MM-dd HH:mm:ss.fff}] {1}' -f (Get-Date), $Message
    Add-Content -LiteralPath $logPath -Value $line -Encoding UTF8
}

try {
    if (-not $Detached) {
        $windowsPowerShell = Join-Path $PSHOME 'powershell.exe'
        $escapedScriptPath = $PSCommandPath.Replace("'", "''")
        $detachedCommand = "& '$escapedScriptPath' -Detached"
        $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($detachedCommand))
        $commandLine = '"{0}" -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand {1}' -f $windowsPowerShell, $encodedCommand
        $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
        if ([uint32]$created.ReturnValue -ne 0) {
            throw "Win32_Process.Create failed with code $($created.ReturnValue)."
        }
        Write-RestartLog "Detached restart helper created (PID $($created.ProcessId))."
        exit 0
    }

    Write-RestartLog 'Detached restart helper started.'
    Start-Sleep -Milliseconds 750

    try {
        Start-Process -FilePath $steamExe -ArgumentList '-shutdown' -WindowStyle Hidden
        Write-RestartLog 'Requested a clean Steam shutdown.'
    } catch {
        Write-RestartLog "Clean shutdown request failed: $($_.Exception.Message)"
    }

    $shutdownDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Process -Name steam -ErrorAction SilentlyContinue) -and (Get-Date) -lt $shutdownDeadline) {
        Start-Sleep -Milliseconds 500
    }

    $remainingSteam = Get-Process -Name steam -ErrorAction SilentlyContinue
    if ($remainingSteam) {
        Write-RestartLog 'ERROR: Steam did not exit after the graceful shutdown request; relaunch aborted.'
        exit 3
    }

    $childDeadline = (Get-Date).AddSeconds(15)
    do {
        $remainingChildren = Get-Process -Name steamwebhelper,millennium.luavm64 -ErrorAction SilentlyContinue
        if (-not $remainingChildren) { break }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $childDeadline)

    Start-Sleep -Milliseconds 750
    $newSteam = Start-Process -FilePath $steamExe -WorkingDirectory $steamRoot -PassThru
    Write-RestartLog "Steam relaunched successfully (PID $($newSteam.Id))."
    exit 0
} catch {
    Write-RestartLog "ERROR: $($_.Exception.Message)"
    exit 1
}
