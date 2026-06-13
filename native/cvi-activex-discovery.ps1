$ErrorActionPreference = 'Stop'
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
}
catch {
    # JSON emitted below remains ASCII-safe enough for diagnostics.
}

$result = [ordered]@{
    ok = $true
    transport = 'activex-discovery'
    candidates = @()
    scannedRoots = @()
    warnings = @()
    error = ''
}

$seen = @{}

function Read-RegistryDefaultValue([Microsoft.Win32.RegistryKey]$key) {
    if ($null -eq $key) { return '' }
    try { return [string]$key.GetValue('', '') } catch { return '' }
}

function Read-RegistrySubKeyDefaultValue([Microsoft.Win32.RegistryKey]$key, [string]$subKeyName) {
    if ($null -eq $key) { return '' }
    $child = $null
    try {
        $child = $key.OpenSubKey($subKeyName, $false)
        return Read-RegistryDefaultValue $child
    }
    catch { return '' }
    finally { if ($null -ne $child) { $child.Dispose() } }
}

function Add-RegistryCandidate(
    [string]$kind,
    [string]$viewName,
    [string]$registryPath,
    [string]$description,
    [string]$progId,
    [string]$versionIndependentProgId,
    [string]$clsid,
    [string]$localServer32,
    [string]$inprocServer32
) {
    $signature = "$kind|$viewName|$registryPath|$progId|$clsid|$localServer32|$inprocServer32"
    if ($seen.ContainsKey($signature)) { return }
    $seen[$signature] = $true
    $result.candidates += [ordered]@{
        kind = $kind
        registryView = $viewName
        clsid = $clsid
        description = $description
        progId = $progId
        versionIndependentProgId = $versionIndependentProgId
        localServer32 = $localServer32
        inprocServer32 = $inprocServer32
        registryPath = $registryPath
    }
}

function Scan-ClassesRoot([Microsoft.Win32.RegistryView]$view) {
    $base = $null
    try {
        $viewName = [string]$view
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::ClassesRoot, $view)
        $result.scannedRoots += "HKEY_CLASSES_ROOT ($viewName, targeted ProgID scan)"
        foreach ($name in $base.GetSubKeyNames()) {
            if ($name -notmatch '(?i)(^cvi($|[._ -])|labwindows|national.?instruments.*cvi|cvi.*automation)') { continue }
            $progKey = $null
            $clsidKey = $null
            try {
                $progKey = $base.OpenSubKey($name, $false)
                if ($null -eq $progKey) { continue }
                $clsid = Read-RegistrySubKeyDefaultValue $progKey 'CLSID'
                $description = Read-RegistryDefaultValue $progKey
                $versionIndependentProgId = Read-RegistrySubKeyDefaultValue $progKey 'VersionIndependentProgID'
                $localServer = ''
                $inprocServer = ''
                if (-not [string]::IsNullOrWhiteSpace($clsid)) {
                    $clsidKey = $base.OpenSubKey("CLSID\\$clsid", $false)
                    if ($null -ne $clsidKey) {
                        if ([string]::IsNullOrWhiteSpace($description)) { $description = Read-RegistryDefaultValue $clsidKey }
                        $localServer = Read-RegistrySubKeyDefaultValue $clsidKey 'LocalServer32'
                        $inprocServer = Read-RegistrySubKeyDefaultValue $clsidKey 'InprocServer32'
                    }
                }
                Add-RegistryCandidate 'progid' $viewName "HKEY_CLASSES_ROOT\\$name" $description $name $versionIndependentProgId $clsid $localServer $inprocServer
            }
            catch {
                $result.warnings += "HKEY_CLASSES_ROOT\\$name ($viewName): $($_.Exception.Message)"
            }
            finally {
                if ($null -ne $clsidKey) { $clsidKey.Dispose() }
                if ($null -ne $progKey) { $progKey.Dispose() }
            }
        }
    }
    catch {
        $result.warnings += "HKEY_CLASSES_ROOT ($view): $($_.Exception.Message)"
    }
    finally { if ($null -ne $base) { $base.Dispose() } }
}

function Scan-CviAppPath([Microsoft.Win32.RegistryHive]$hive, [Microsoft.Win32.RegistryView]$view) {
    $base = $null
    $key = $null
    try {
        $viewName = [string]$view
        $hiveName = [string]$hive
        $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, $view)
        $path = 'SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\cvi.exe'
        $result.scannedRoots += "$hiveName\\$path ($viewName)"
        $key = $base.OpenSubKey($path, $false)
        if ($null -eq $key) { return }
        $executable = Read-RegistryDefaultValue $key
        Add-RegistryCandidate 'app-path' $viewName "$hiveName\\$path" 'Registered LabWindows/CVI executable path' '' '' '' $executable ''
    }
    catch {
        $result.warnings += "$hive\\cvi.exe ($view): $($_.Exception.Message)"
    }
    finally {
        if ($null -ne $key) { $key.Dispose() }
        if ($null -ne $base) { $base.Dispose() }
    }
}

try {
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        Scan-ClassesRoot $view
        Scan-CviAppPath ([Microsoft.Win32.RegistryHive]::LocalMachine) $view
        Scan-CviAppPath ([Microsoft.Win32.RegistryHive]::CurrentUser) $view
    }
}
catch {
    $result.ok = $false
    $result.error = $_.Exception.Message
}

$result | ConvertTo-Json -Compress -Depth 8
