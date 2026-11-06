param(
    [ValidateSet('Minimize')]
    [string]$Action = 'Minimize',

    [int]$ProcessId = 0
)

$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch {}

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class CviNativeWindowControl
{
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
}
'@ -ErrorAction SilentlyContinue

if ($ProcessId -le 0) {
    [ordered]@{
        ok = $false
        action = $Action
        processId = $ProcessId
        affectedWindows = 0
        error = 'A specific LabWindows/CVI process ID is required. Refusing to modify every CVI window.'
    } | ConvertTo-Json -Compress
    exit 2
}

$affected = 0
$process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if ($null -ne $process -and $process.ProcessName -ieq 'cvi' -and $process.MainWindowHandle -ne [IntPtr]::Zero) {
    # SW_MINIMIZE = 6
    [void][CviNativeWindowControl]::ShowWindowAsync($process.MainWindowHandle, 6)
    $affected = 1
}

[ordered]@{
    ok = ($null -ne $process)
    action = $Action
    processId = $ProcessId
    affectedWindows = $affected
    error = if ($null -eq $process) { 'The requested LabWindows/CVI process is no longer running.' } else { '' }
} | ConvertTo-Json -Compress
