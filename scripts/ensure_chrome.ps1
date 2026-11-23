# Start a dedicated Chrome profile for local CDP price monitoring.
# This script never stops an existing Chrome process or reuses the default profile.
$ErrorActionPreference = 'Stop'
$Port = 9224
if ($env:CDP_PORT) { $Port = [int]$env:CDP_PORT }
if ($Port -lt 1024 -or $Port -gt 65535) { throw 'Invalid CDP_PORT' }

function Test-DebugPort {
    try {
        $client = New-Object Net.Sockets.TcpClient
        $client.Connect('127.0.0.1', $Port)
        $client.Close()
        return $true
    } catch { return $false }
}

if (Test-DebugPort) {
    Write-Output "CDP_ALREADY_UP (port $Port): confirm it belongs to your trusted Chrome session"
    exit 0
}

$chromeCandidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
)
$chrome = $chromeCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $chrome) { Write-Error 'CDP_FAILED: Chrome not found'; exit 1 }

$profile = if ($env:TRACKER_CHROME_PROFILE) { $env:TRACKER_CHROME_PROFILE } else { Join-Path $env:LOCALAPPDATA 'TaobaoPriceTracker\ChromeProfile' }
New-Item -ItemType Directory -Force -Path $profile | Out-Null
Write-Output "Launching dedicated Chrome profile at $profile"
Write-Output 'Sign in to Taobao in this Chrome window on first use.'
$argsChrome = "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$Port --user-data-dir=`"$profile`" --no-first-run"
# Create a standalone browser process without terminating user's existing windows.
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = ('"' + $chrome + '" ' + $argsChrome) }
if ($result.ReturnValue -ne 0) { Write-Error "CDP_FAILED: Chrome launch error $($result.ReturnValue)"; exit 1 }
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 1
    if (Test-DebugPort) { Write-Output "CDP_UP (port $Port)"; exit 0 }
}
Write-Error 'CDP_FAILED: debug port did not open'
exit 1
