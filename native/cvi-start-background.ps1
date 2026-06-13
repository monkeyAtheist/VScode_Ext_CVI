param(
    [Parameter(Mandatory = $true)]
    [string]$Executable,

    [Parameter(Mandatory = $true)]
    [string]$Target,

    [ValidateSet('Normal', 'Minimized')]
    [string]$WindowMode = 'Minimized'
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}
try { $OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

$workingDirectory = Split-Path -Parent $Target
if ([string]::IsNullOrWhiteSpace($workingDirectory)) {
    $workingDirectory = (Get-Location).Path
}

# Start-Process needs the target to stay quoted when its path contains spaces.
$escapedTarget = '"' + $Target.Replace('"', '\"') + '"'
$process = Start-Process -FilePath $Executable -ArgumentList @($escapedTarget) -WorkingDirectory $workingDirectory -WindowStyle $WindowMode -PassThru

[ordered]@{
    ok = $true
    pid = $process.Id
    executable = $Executable
    target = $Target
    windowMode = $WindowMode
} | ConvertTo-Json -Compress
