param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [string]$Argument = '',

    [int]$TimeoutMs = 3000,

    [switch]$CreateIfMissing
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
} catch {
    # Output encoding is helpful but must never prevent the bridge from running.
}

$progId = 'CVI.Application'
$result = [ordered]@{
    ok = $false
    transport = 'activex'
    command = $Command
    argument = $Argument
    raw = ''
    error = ''
    progId = $progId
    connectionMode = ''
    method = ''
    attempts = @()
}

function Add-ConnectionAttempt {
    param(
        [string]$Mode,
        [bool]$Ok,
        [string]$ErrorMessage
    )

    $script:result.attempts += [ordered]@{
        mode = $Mode
        ok = $Ok
        error = $ErrorMessage
    }
}

function Invoke-CviState {
    param([object]$Application)

    [int]$projectCompiledAndLinked = 0
    [int]$projectExecutionState = 0
    [int]$interactiveWindowCompiledAndLinked = 0
    [int]$interactiveWindowExecutionState = 0
    [int]$waitingForUserResponse = 0

    # The automation method is exposed differently outside the generated CVI C wrapper:
    # the server return value is the PowerShell method result and the state fields remain
    # COM by-reference parameters.
    $status = $Application.GetCVIState(
        [ref]$projectCompiledAndLinked,
        [ref]$projectExecutionState,
        [ref]$interactiveWindowCompiledAndLinked,
        [ref]$interactiveWindowExecutionState,
        [ref]$waitingForUserResponse
    )

    return [ordered]@{
        status = [int]$status
        raw = ('{0} {1} {2} {3} {4} {5} 0' -f [int]$status, $projectCompiledAndLinked, $projectExecutionState, $interactiveWindowCompiledAndLinked, $interactiveWindowExecutionState, $waitingForUserResponse)
    }
}

$app = $null
try {
    try {
        $app = [System.Runtime.InteropServices.Marshal]::GetActiveObject($progId)
        $result.connectionMode = 'active-object'
        Add-ConnectionAttempt -Mode 'active-object' -Ok $true -ErrorMessage ''
    } catch {
        Add-ConnectionAttempt -Mode 'active-object' -Ok $false -ErrorMessage $_.Exception.Message
    }

    if ($null -eq $app -and $CreateIfMissing.IsPresent) {
        try {
            $app = New-Object -ComObject $progId
            $result.connectionMode = 'create-object'
            Add-ConnectionAttempt -Mode 'create-object' -Ok $true -ErrorMessage ''
        } catch {
            Add-ConnectionAttempt -Mode 'create-object' -Ok $false -ErrorMessage $_.Exception.Message
        }
    }

    if ($null -eq $app) {
        if ($CreateIfMissing.IsPresent) {
            throw "Unable to obtain the LabWindows/CVI ActiveX automation object '$progId'."
        }
        throw "No running LabWindows/CVI ActiveX automation object '$progId' was found."
    }

    switch ($Command) {
        'Get CVI State' {
            $result.method = 'GetCVIState'
            $state = Invoke-CviState -Application $app
            $result.raw = $state.raw
        }
        'Build Project' {
            $result.method = 'BuildProject'
            $result.raw = [string]([int]$app.BuildProject())
        }
        'Run Project' {
            $result.method = 'RunProject'
            # 0: do not display the optional save prompt before running.
            $result.raw = [string]([int]$app.RunProject(0))
        }
        'Suspend Execution' {
            $result.method = 'SuspendExecution'
            $result.raw = [string]([int]$app.SuspendExecution())
        }
        'Continue Execution' {
            $result.method = 'ContinueExecution'
            $result.raw = [string]([int]$app.ContinueExecution())
        }
        'Terminate Execution' {
            $result.method = 'TerminateExecution'
            # 0: do not execute functions registered through atexit during forced stop.
            $result.raw = [string]([int]$app.TerminateExecution(0))
        }
        default {
            throw "Unsupported LabWindows/CVI ActiveX command: $Command"
        }
    }

    $result.ok = $true
} catch {
    $result.error = $_.Exception.Message
} finally {
    if ($null -ne $app) {
        try {
            [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)
        } catch {
            # COM object release errors are non-fatal for a one-shot bridge process.
        }
    }
}

$result | ConvertTo-Json -Compress -Depth 8
