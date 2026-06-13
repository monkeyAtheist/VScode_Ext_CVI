param(
    [ValidateSet('Minimize')]
    [string]$Action = 'Minimize'
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

$affected = 0
Get-Process -Name 'cvi' -ErrorAction SilentlyContinue | ForEach-Object {
    if ($_.MainWindowHandle -ne [IntPtr]::Zero) {
        # SW_MINIMIZE = 6
        [void][CviNativeWindowControl]::ShowWindowAsync($_.MainWindowHandle, 6)
        $affected++
    }
}

[ordered]@{
    ok = $true
    action = $Action
    affectedWindows = $affected
} | ConvertTo-Json -Compress
