#requires -Version 5.1
# Machine-bound activation check for Akram's LuaTools.
# HWID = SHA256(lower(guid):lower(uuid):lower(drive serial)) -> first 16 hex (XXXX-XXXX-XXXX-XXXX)
# key  = Crockford(HMAC-SHA256(SECRET, lower(hwid16))[0..10])
# Safe to dot-source: it only acts when given -PrintHwid or -Key.
param(
    [string]$Key = "",
    [switch]$PrintHwid
)

$ErrorActionPreference = "Stop"
# secret is XOR-obfuscated (b64) so it is not a plain grep target in the public repo
$SecretB64 = "GxEIbhcJdwlpGQhpDncRaQN3aGpobHcMYw=="
$Secret  = [Text.Encoding]::UTF8.GetString([byte[]]([Convert]::FromBase64String($SecretB64) | ForEach-Object { $_ -bxor 0x5A }))
$Crockf  = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

# 64-bit registry view explicitly: a 32-bit PowerShell (Millennium's Lua host can be one) would
# otherwise read Wow6432Node\Microsoft\Cryptography, which has no MachineGuid -> different identity.
function Get-MachineGuid64 {
    try {
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
            [Microsoft.Win32.RegistryHive]::LocalMachine,
            [Microsoft.Win32.RegistryView]::Registry64)
        $k = $base.OpenSubKey("SOFTWARE\Microsoft\Cryptography")
        if ($k) { $v = $k.GetValue("MachineGuid"); $k.Close() }
        $base.Close()
        if ($v) { return [string]$v }
    } catch { }
    return $null
}

function Get-RawHwid {
    $missing = @()

    $guid = Get-MachineGuid64
    if (-not $guid) { $missing += "MachineGuid" }

    $uuid = $null
    try {
        $uuid = [string](Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID
        if (-not $uuid -or $uuid -eq "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") { $uuid = $null }
    } catch { }
    if (-not $uuid) {
        try { $uuid = [string](Get-WmiObject -Class Win32_ComputerSystemProduct -ErrorAction Stop).UUID } catch { }
        if (-not $uuid -or $uuid -eq "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") { $uuid = $null }
    }
    if (-not $uuid) { $missing += "BIOS-UUID" }

    $drive = $null
    try {
        $drive = [string](Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop).VolumeSerialNumber
    } catch { }
    if (-not $drive) {
        try { $drive = [string](Get-WmiObject -Class Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop).VolumeSerialNumber } catch { }
    }
    if (-not $drive) { $missing += "VolumeSerial" }

    # Fail closed: substituting UNKNOWN_* would give two broken machines the same identity.
    if ($missing.Count -gt 0) { throw ("HWID-COMPONENT-MISSING: " + ($missing -join ",")) }

    $combined = ($guid.Trim().ToLower() + ":" + $uuid.Trim().ToLower() + ":" + $drive.Trim().ToLower())
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($combined))
    return (($hash | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Format-Display([string]$raw) {
    $s = $raw.Substring(0, 16).ToUpper()
    return ($s -replace '(.{4})(?=.)', '$1-')
}

function Get-KeyFor([string]$displayHwid) {
    $msg = ($displayHwid -replace '-', '').ToLower()
    if ($msg.Length -gt 16) { $msg = $msg.Substring(0, 16) }
    $hmac = New-Object System.Security.Cryptography.HMACSHA256
    $hmac.Key = [System.Text.Encoding]::UTF8.GetBytes($Secret)
    $mac = $hmac.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($msg))
    [byte[]]$ten = $mac[0..9]

    $bits = ""
    foreach ($b in $ten) { $bits += [Convert]::ToString($b, 2).PadLeft(8, '0') }
    $out = ""
    for ($i = 0; $i -lt 16; $i++) { $out += $Crockf[[Convert]::ToInt32($bits.Substring($i * 5, 5), 2)] }
    return (($out -replace '(.{4})(?=.)', '$1-'))
}

if ($PrintHwid -or $Key -ne "") {
    try { $hwid = Format-Display (Get-RawHwid) } catch { $hwid = $null }
    if (-not $hwid) {
        Write-Output "RESULT=ERROR"
        if ($PrintHwid) { Write-Output "HWID=UNKNOWN" }
    } else {
        if ($PrintHwid) { Write-Output "HWID=$hwid" }
        if ($Key -ne "") {
            $norm = ($Key -replace '-', '').Trim().ToUpper()
            $expected = (Get-KeyFor $hwid) -replace '-', ''
            if ($norm -eq $expected) { Write-Output "RESULT=OK" } else { Write-Output "RESULT=BAD" }
        }
    }
}
