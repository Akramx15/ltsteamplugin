#requires -Version 5.1
# Machine-bound activation check for Akram's LuaTools.
# Same scheme as the v9 installer: HWID = SHA256(lower(guid):lower(uuid):lower(drive)) -> first 16 hex,
# key = Crockford(HMAC-SHA256(SECRET, lower(hwid16))[0..10]).
param(
    [string]$Key = "",
    [switch]$PrintHwid
)

$ErrorActionPreference = "Stop"
# secret is XOR-obfuscated (b64) so it is not a plain grep target in the public repo
$SecretB64 = "GxEIbhcJdwlpGQhpDncRaQN3aGpobHcMYw=="
$Secret  = [Text.Encoding]::UTF8.GetString([byte[]]([Convert]::FromBase64String($SecretB64) | ForEach-Object { $_ -bxor 0x5A }))
$Crockf  = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

function Get-RawHwid {
    $guid = (Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name MachineGuid -ErrorAction SilentlyContinue).MachineGuid
    if (-not $guid) { $guid = "UNKNOWN_GUID" }
    try {
        $uuid = (Get-CimInstance -ClassName Win32_ComputerSystemProduct -ErrorAction Stop).UUID
        if (-not $uuid) { $uuid = "UNKNOWN_BIOS" }
        elseif ($uuid -eq "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF") { $uuid = "UNKNOWN_BIOS" }
    } catch { $uuid = "UNKNOWN_BIOS" }
    try {
        $drive = (Get-CimInstance -ClassName Win32_LogicalDisk -Filter "DeviceID='C:'" -ErrorAction Stop).VolumeSerialNumber
        if (-not $drive) { $drive = "UNKNOWN_DRIVE" }
    } catch { $drive = "UNKNOWN_DRIVE" }

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

# Only acts when called with a flag, so the file can also be dot-sourced by the installer.
if ($PrintHwid -or $Key -ne "") {
    $hwid = Format-Display (Get-RawHwid)
    if ($PrintHwid) { Write-Output "HWID=$hwid" }
    if ($Key -ne "") {
        $norm = ($Key -replace '-', '').Trim().ToUpper()
        $expected = (Get-KeyFor $hwid) -replace '-', ''
        if ($norm -eq $expected) { Write-Output "RESULT=OK" }
        else { Write-Output "RESULT=BAD" }
    }
}
