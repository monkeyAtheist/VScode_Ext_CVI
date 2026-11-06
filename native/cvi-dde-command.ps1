param(
    [Parameter(Mandatory = $true)]
    [string]$Command,

    [string]$Argument = "",

    [int]$TimeoutMs = 3000,

    [int]$TargetProcessId = 0,

    [switch]$Session
)

$ErrorActionPreference = 'Stop'
# Keep diagnostics operational even when the host does not permit changing its console encoding.
try {
    $utf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::OutputEncoding = $utf8NoBom
    $OutputEncoding = $utf8NoBom
}
catch {
    # JSON emitted by this script remains ASCII-safe for bridge diagnostics.
}

$source = @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace CviDdeBridge
{
    public enum DdeTextMode
    {
        Ansi,
        Unicode
    }

    public sealed class DdeBridgeException : InvalidOperationException
    {
        public uint DdeError { get; private set; }
        public string Stage { get; private set; }

        public DdeBridgeException(string stage, uint error, string message)
            : base(message)
        {
            Stage = stage;
            DdeError = error;
            Data["DdeError"] = error;
            Data["DdeErrorName"] = CviDdeClient.DescribeError(error);
            Data["Stage"] = stage;
        }
    }

    public sealed class CviDdeClient : IDisposable
    {
        private const int CP_WINANSI = 1004;
        private const int CP_WINUNICODE = 1200;
        private const int CF_TEXT = 1;
        private const int APPCMD_CLIENTONLY = 0x00000010;
        private const int XTYP_ADVDATA = 0x4010;
        private const int XTYP_ADVSTART = 0x1030;
        private const int XTYP_ADVSTOP = 0x8040;
        private const int XTYP_EXECUTE = 0x4050;
        private const int DDE_FACK = 0x8000;
        private const uint PM_REMOVE = 0x0001;
        private const uint QID_SYNC = 0xFFFFFFFF;

        [StructLayout(LayoutKind.Sequential)]
        private struct SECURITY_QUALITY_OF_SERVICE
        {
            public uint Length;
            public int ImpersonationLevel;
            public byte ContextTrackingMode;
            public byte EffectiveOnly;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CONVCONTEXT
        {
            public uint cb;
            public uint wFlags;
            public uint wCountryID;
            public int iCodePage;
            public uint dwLangID;
            public uint dwSecurity;
            public SECURITY_QUALITY_OF_SERVICE qos;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct CONVINFO
        {
            public uint cb;
            public UIntPtr hUser;
            public IntPtr hConvPartner;
            public IntPtr hszSvcPartner;
            public IntPtr hszServiceReq;
            public IntPtr hszTopic;
            public IntPtr hszItem;
            public uint wFmt;
            public uint wType;
            public uint wStatus;
            public uint wConvst;
            public uint wLastError;
            public IntPtr hConvList;
            public CONVCONTEXT ConvCtxt;
            public IntPtr hwnd;
            public IntPtr hwndPartner;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct POINT
        {
            public int x;
            public int y;
        }

        [StructLayout(LayoutKind.Sequential)]
        private struct MSG
        {
            public IntPtr hwnd;
            public uint message;
            public UIntPtr wParam;
            public IntPtr lParam;
            public uint time;
            public POINT pt;
        }

        [UnmanagedFunctionPointer(CallingConvention.Winapi)]
        private delegate IntPtr DdeCallback(
            uint uType,
            uint uFmt,
            IntPtr hconv,
            IntPtr hsz1,
            IntPtr hsz2,
            IntPtr hdata,
            UIntPtr dwData1,
            UIntPtr dwData2);

        [DllImport("user32.dll", CharSet = CharSet.Ansi, EntryPoint = "DdeInitializeA")]
        private static extern uint DdeInitializeAnsi(ref uint pidInst, DdeCallback pfnCallback, uint afCmd, uint ulRes);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "DdeInitializeW")]
        private static extern uint DdeInitializeUnicode(ref uint pidInst, DdeCallback pfnCallback, uint afCmd, uint ulRes);

        [DllImport("user32.dll", CharSet = CharSet.Ansi, EntryPoint = "DdeCreateStringHandleA")]
        private static extern IntPtr DdeCreateStringHandleAnsi(uint idInst, string psz, int iCodePage);

        [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "DdeCreateStringHandleW")]
        private static extern IntPtr DdeCreateStringHandleUnicode(uint idInst, string psz, int iCodePage);

        [DllImport("user32.dll")]
        private static extern bool DdeFreeStringHandle(uint idInst, IntPtr hsz);

        [DllImport("user32.dll")]
        private static extern IntPtr DdeConnect(uint idInst, IntPtr hszService, IntPtr hszTopic, IntPtr pCC);

        [DllImport("user32.dll")]
        private static extern IntPtr DdeConnectList(uint idInst, IntPtr hszService, IntPtr hszTopic, IntPtr hConvList, IntPtr pCC);

        [DllImport("user32.dll")]
        private static extern IntPtr DdeQueryNextServer(IntPtr hConvList, IntPtr hConvPrev);

        [DllImport("user32.dll")]
        private static extern uint DdeQueryConvInfo(IntPtr hConv, uint idTransaction, ref CONVINFO pConvInfo);

        [DllImport("user32.dll")]
        private static extern bool DdeDisconnect(IntPtr hConv);

        [DllImport("user32.dll")]
        private static extern bool DdeDisconnectList(IntPtr hConvList);

        [DllImport("user32.dll")]
        private static extern bool DdeUninitialize(uint idInst);

        [DllImport("user32.dll")]
        private static extern uint DdeGetLastError(uint idInst);

        [DllImport("user32.dll")]
        private static extern IntPtr DdeClientTransaction(
            byte[] pData,
            uint cbData,
            IntPtr hConv,
            IntPtr hszItem,
            uint wFmt,
            uint wType,
            uint dwTimeout,
            out uint pdwResult);

        [DllImport("user32.dll")]
        private static extern IntPtr DdeAccessData(IntPtr hData, ref uint pcbDataSize);

        [DllImport("user32.dll")]
        private static extern bool DdeUnaccessData(IntPtr hData);

        [DllImport("user32.dll")]
        private static extern bool PeekMessage(out MSG lpMsg, IntPtr hWnd, uint wMsgFilterMin, uint wMsgFilterMax, uint wRemoveMsg);

        [DllImport("user32.dll")]
        private static extern bool TranslateMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern IntPtr DispatchMessage(ref MSG lpMsg);

        [DllImport("user32.dll")]
        private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        private static extern int GetWindowTextW(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

        [DllImport("user32.dll")]
        private static extern int GetWindowTextLengthW(IntPtr hWnd);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool IsWindowVisible(IntPtr hWnd);

        private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        private readonly DdeCallback callback;
        private readonly DdeTextMode textMode;
        private readonly string serviceName;
        private readonly string topicName;
        private readonly string statusName;
        private readonly int targetProcessId;
        private uint instanceId;
        private IntPtr serviceHandle;
        private IntPtr topicHandle;
        private IntPtr statusHandle;
        private IntPtr conversationList;
        private IntPtr conversation;
        private string response;
        private bool disposed;
        private readonly List<int> candidateProcessIds = new List<int>();

        public CviDdeClient(DdeTextMode textMode, string serviceName, string topicName, string statusName, int targetProcessId)
        {
            this.textMode = textMode;
            this.serviceName = serviceName;
            this.topicName = topicName;
            this.statusName = statusName;
            this.targetProcessId = targetProcessId;
            callback = OnDdeCallback;
        }

        public string ModeName { get { return textMode == DdeTextMode.Ansi ? "ansi" : "unicode"; } }
        public uint LastError { get { return instanceId == 0 ? 0 : DdeGetLastError(instanceId); } }
        public int ServerProcessId { get; private set; }
        public string ServerWindowTitle { get; private set; }
        public int[] CandidateProcessIds { get { return candidateProcessIds.ToArray(); } }

        public void Connect()
        {
            uint initializationResult = textMode == DdeTextMode.Ansi
                ? DdeInitializeAnsi(ref instanceId, callback, APPCMD_CLIENTONLY, 0)
                : DdeInitializeUnicode(ref instanceId, callback, APPCMD_CLIENTONLY, 0);
            if (initializationResult != 0)
            {
                Throw("initialize", initializationResult, "DdeInitialize failed");
            }

            serviceHandle = CreateStringHandle(serviceName);
            topicHandle = CreateStringHandle(topicName);
            statusHandle = CreateStringHandle(statusName);
            if (serviceHandle == IntPtr.Zero || topicHandle == IntPtr.Zero || statusHandle == IntPtr.Zero)
            {
                Throw("create-string-handles", LastError, "Unable to allocate DDE string handles");
            }

            for (int attempt = 0; attempt < 3 && conversation == IntPtr.Zero; attempt++)
            {
                PumpMessages();
                if (conversationList != IntPtr.Zero)
                {
                    DdeDisconnectList(conversationList);
                    conversationList = IntPtr.Zero;
                }
                conversationList = DdeConnectList(instanceId, serviceHandle, topicHandle, IntPtr.Zero, IntPtr.Zero);
                if (conversationList != IntPtr.Zero)
                {
                    SelectConversationFromList();
                }
                if (conversation == IntPtr.Zero)
                {
                    Thread.Sleep(75);
                }
            }
            if (conversation == IntPtr.Zero)
            {
                string suffix = candidateProcessIds.Count > 0 ? " Candidate CVI process IDs: " + string.Join(", ", candidateProcessIds.ToArray()) + "." : "";
                Throw("connect", LastError, "Unable to connect to the requested LabWindows/CVI DDE command server." + suffix);
            }

            uint transactionResult;
            IntPtr adviceResult = DdeClientTransaction(null, 0, conversation, statusHandle, CF_TEXT, XTYP_ADVSTART, 2000, out transactionResult);
            if (adviceResult == IntPtr.Zero)
            {
                Throw("subscribe-status", LastError, "Unable to subscribe to the LabWindows/CVI DDE status item");
            }
        }


        private void SelectConversationFromList()
        {
            candidateProcessIds.Clear();
            IntPtr current = IntPtr.Zero;
            IntPtr selected = IntPtr.Zero;
            int selectedPid = 0;
            while ((current = DdeQueryNextServer(conversationList, current)) != IntPtr.Zero)
            {
                CONVINFO info = new CONVINFO();
                info.cb = (uint)Marshal.SizeOf(typeof(CONVINFO));
                if (DdeQueryConvInfo(current, QID_SYNC, ref info) == 0)
                {
                    continue;
                }
                uint pid = 0;
                if (info.hwndPartner != IntPtr.Zero)
                {
                    GetWindowThreadProcessId(info.hwndPartner, out pid);
                }
                int candidatePid = unchecked((int)pid);
                if (candidatePid > 0 && !candidateProcessIds.Contains(candidatePid))
                {
                    candidateProcessIds.Add(candidatePid);
                }
                if (targetProcessId > 0)
                {
                    if (candidatePid == targetProcessId)
                    {
                        selected = current;
                        selectedPid = candidatePid;
                        break;
                    }
                }
                else if (selected == IntPtr.Zero)
                {
                    selected = current;
                    selectedPid = candidatePid;
                }
            }

            if (targetProcessId <= 0 && candidateProcessIds.Count > 1)
            {
                throw new DdeBridgeException("select-server", 0, "Multiple LabWindows/CVI DDE servers are available. Refusing an ambiguous connection. Candidate CVI process IDs: " + string.Join(", ", candidateProcessIds.ToArray()) + ".");
            }
            if (targetProcessId > 0 && selected == IntPtr.Zero)
            {
                return;
            }
            if (selected == IntPtr.Zero)
            {
                return;
            }

            conversation = selected;
            ServerProcessId = selectedPid;
            ServerWindowTitle = FindTopLevelWindowTitle(selectedPid);
        }

        private static string FindTopLevelWindowTitle(int processId)
        {
            if (processId <= 0) return "";
            string best = "";
            EnumWindows(delegate(IntPtr hWnd, IntPtr lParam)
            {
                if (!IsWindowVisible(hWnd)) return true;
                uint pid;
                GetWindowThreadProcessId(hWnd, out pid);
                if (pid != (uint)processId) return true;
                int length = GetWindowTextLengthW(hWnd);
                if (length <= 0) return true;
                StringBuilder builder = new StringBuilder(length + 1);
                GetWindowTextW(hWnd, builder, builder.Capacity);
                string title = builder.ToString().Trim();
                if (title.Length > best.Length) best = title;
                return true;
            }, IntPtr.Zero);
            return best;
        }

        public string Execute(string command, int timeoutMs)
        {
            if (conversation == IntPtr.Zero)
            {
                throw new InvalidOperationException("The DDE conversation is not connected.");
            }

            response = null;
            byte[] payload = Encoding.Default.GetBytes(command + "\0");
            uint transactionResult;
            IntPtr executeResult = DdeClientTransaction(payload, (uint)payload.Length, conversation, IntPtr.Zero, 0, XTYP_EXECUTE, (uint)Math.Max(500, timeoutMs), out transactionResult);
            if (executeResult == IntPtr.Zero)
            {
                Throw("execute", LastError, "The LabWindows/CVI DDE command was rejected");
            }

            DateTime deadline = DateTime.UtcNow.AddMilliseconds(Math.Max(500, timeoutMs));
            while (response == null && DateTime.UtcNow < deadline)
            {
                PumpMessages();
                Thread.Sleep(10);
            }

            if (response == null)
            {
                throw new TimeoutException("LabWindows/CVI did not publish a DDE status response before the timeout expired.");
            }
            return response;
        }

        private IntPtr CreateStringHandle(string value)
        {
            return textMode == DdeTextMode.Ansi
                ? DdeCreateStringHandleAnsi(instanceId, value, CP_WINANSI)
                : DdeCreateStringHandleUnicode(instanceId, value, CP_WINUNICODE);
        }

        private void Throw(string stage, uint error, string message)
        {
            string name = DescribeError(error);
            throw new DdeBridgeException(stage, error, message + ". DDEML error " + error + " (" + name + ").");
        }

        public static string DescribeError(uint error)
        {
            switch (error)
            {
                case 0x0000: return "DMLERR_NO_ERROR";
                case 0x4000: return "DMLERR_ADVACKTIMEOUT";
                case 0x4001: return "DMLERR_BUSY";
                case 0x4002: return "DMLERR_DATAACKTIMEOUT";
                case 0x4003: return "DMLERR_DLL_NOT_INITIALIZED";
                case 0x4004: return "DMLERR_DLL_USAGE";
                case 0x4005: return "DMLERR_EXECACKTIMEOUT";
                case 0x4006: return "DMLERR_INVALIDPARAMETER";
                case 0x4007: return "DMLERR_LOW_MEMORY";
                case 0x4008: return "DMLERR_MEMORY_ERROR";
                case 0x4009: return "DMLERR_NOTPROCESSED";
                case 0x400A: return "DMLERR_NO_CONV_ESTABLISHED";
                case 0x400B: return "DMLERR_POKEACKTIMEOUT";
                case 0x400C: return "DMLERR_POSTMSG_FAILED";
                case 0x400D: return "DMLERR_REENTRANCY";
                case 0x400E: return "DMLERR_SERVER_DIED";
                case 0x400F: return "DMLERR_SYS_ERROR";
                case 0x4010: return "DMLERR_UNADVACKTIMEOUT";
                case 0x4011: return "DMLERR_UNFOUND_QUEUE_ID";
                default: return "DMLERR_UNKNOWN";
            }
        }

        private IntPtr OnDdeCallback(uint uType, uint uFmt, IntPtr hconv, IntPtr hsz1, IntPtr hsz2, IntPtr hdata, UIntPtr dwData1, UIntPtr dwData2)
        {
            if (uType == XTYP_ADVDATA && hdata != IntPtr.Zero)
            {
                uint size = 0;
                IntPtr data = DdeAccessData(hdata, ref size);
                if (data != IntPtr.Zero)
                {
                    try
                    {
                        response = Marshal.PtrToStringAnsi(data, (int)size).TrimEnd('\0', '\r', '\n');
                    }
                    finally
                    {
                        DdeUnaccessData(hdata);
                    }
                }
                return new IntPtr(DDE_FACK);
            }
            return IntPtr.Zero;
        }

        private static void PumpMessages()
        {
            MSG message;
            while (PeekMessage(out message, IntPtr.Zero, 0, 0, PM_REMOVE))
            {
                TranslateMessage(ref message);
                DispatchMessage(ref message);
            }
        }

        public void Dispose()
        {
            if (disposed)
            {
                return;
            }
            disposed = true;

            if (conversation != IntPtr.Zero && statusHandle != IntPtr.Zero)
            {
                uint ignored;
                DdeClientTransaction(null, 0, conversation, statusHandle, CF_TEXT, XTYP_ADVSTOP, 1000, out ignored);
            }
            if (conversationList != IntPtr.Zero)
            {
                DdeDisconnectList(conversationList);
                conversationList = IntPtr.Zero;
                conversation = IntPtr.Zero;
            }
            else if (conversation != IntPtr.Zero)
            {
                DdeDisconnect(conversation);
                conversation = IntPtr.Zero;
            }
            if (instanceId != 0)
            {
                if (serviceHandle != IntPtr.Zero) DdeFreeStringHandle(instanceId, serviceHandle);
                if (topicHandle != IntPtr.Zero) DdeFreeStringHandle(instanceId, topicHandle);
                if (statusHandle != IntPtr.Zero) DdeFreeStringHandle(instanceId, statusHandle);
                DdeUninitialize(instanceId);
                instanceId = 0;
            }
        }
    }
}
'@

function Get-DeepestException([System.Exception]$exception) {
    $current = $exception
    while ($null -ne $current.InnerException) {
        $current = $current.InnerException
    }
    return $current
}

function Get-DdeErrorCode([System.Exception]$exception) {
    $current = $exception
    while ($null -ne $current) {
        if ($current.Data.Contains('DdeError')) {
            return [uint32]$current.Data['DdeError']
        }
        $current = $current.InnerException
    }
    if ($exception.Message -match 'DDEML error\s+(\d+)') {
        return [uint32]$Matches[1]
    }
    return [uint32]0
}

function Get-DdeStage([System.Exception]$exception) {
    $current = $exception
    while ($null -ne $current) {
        if ($current.Data.Contains('Stage')) {
            return [string]$current.Data['Stage']
        }
        $current = $current.InnerException
    }
    return ''
}

function Import-CviDdeBridgeType {
    param([string]$typeSource)

    $cacheRoot = [Environment]::GetFolderPath('LocalApplicationData')
    if ([string]::IsNullOrWhiteSpace($cacheRoot)) {
        $cacheRoot = [System.IO.Path]::GetTempPath()
    }
    $cacheDirectory = Join-Path $cacheRoot 'LabWindowsCviProjectManager\NativeBridge'
    $assemblyPath = Join-Path $cacheDirectory 'CviDdeBridge.0.7.37.dll'
    $script:bridgeBootstrap.assemblyPath = $assemblyPath

    if ('CviDdeBridge.CviDdeClient' -as [type]) {
        $script:bridgeBootstrap.loadedFromCache = $true
        return
    }

    if (Test-Path -LiteralPath $assemblyPath) {
        try {
            Add-Type -LiteralPath $assemblyPath -ErrorAction Stop
            $script:bridgeBootstrap.loadedFromCache = $true
            return
        }
        catch {
            $script:bridgeBootstrap.warnings += "Cached helper load failed: $($_.Exception.Message)"
            try { Remove-Item -LiteralPath $assemblyPath -Force -ErrorAction SilentlyContinue } catch {}
        }
    }

    New-Item -ItemType Directory -Path $cacheDirectory -Force | Out-Null
    Add-Type -TypeDefinition $typeSource -Language CSharp -OutputAssembly $assemblyPath -OutputType Library -PassThru -ErrorAction Stop | Out-Null
    if (-not (Test-Path -LiteralPath $assemblyPath)) {
        throw 'The C# compiler did not create the cached DDE helper assembly.'
    }
    if (-not ('CviDdeBridge.CviDdeClient' -as [type])) {
        Add-Type -LiteralPath $assemblyPath -ErrorAction Stop
    }
    $script:bridgeBootstrap.compiled = $true
}

$bridgeBootstrap = [ordered]@{
    assemblyPath = ''
    loadedFromCache = $false
    compiled = $false
    warnings = @()
}

function Write-JsonLine($payload) {
    $json = $payload | ConvertTo-Json -Compress -Depth 8
    [Console]::Out.WriteLine($json)
    [Console]::Out.Flush()
}

function New-ConnectedDdeClient {
    param([System.Collections.ArrayList]$attempts, [int]$targetProcessId)

    foreach ($mode in @('Ansi', 'Unicode')) {
        $candidate = $null
        try {
            $enumMode = [CviDdeBridge.DdeTextMode]::$mode
            $candidate = New-Object -TypeName 'CviDdeBridge.CviDdeClient' -ArgumentList @($enumMode, 'cvi', 'system', 'status', $targetProcessId)
            $candidate.Connect()
            [void]$attempts.Add([ordered]@{
                mode = $mode.ToLowerInvariant()
                service = 'cvi'
                topic = 'system'
                item = 'status'
                ok = $true
                stage = 'complete'
                ddeError = 0
                ddeErrorName = 'DMLERR_NO_ERROR'
                error = ''
            })
            return $candidate
        }
        catch {
            $deepest = Get-DeepestException $_.Exception
            $ddeError = Get-DdeErrorCode $_.Exception
            $ddeErrorName = [CviDdeBridge.CviDdeClient]::DescribeError($ddeError)
            $stage = Get-DdeStage $_.Exception
            [void]$attempts.Add([ordered]@{
                mode = $mode.ToLowerInvariant()
                service = 'cvi'
                topic = 'system'
                item = 'status'
                ok = $false
                stage = $stage
                ddeError = $ddeError
                ddeErrorName = $ddeErrorName
                error = $deepest.Message
            })
            if ($null -ne $candidate) {
                $candidate.Dispose()
                $candidate = $null
            }
        }
    }
    return $null
}

if ($Session) {
    $sessionClient = $null
    $sessionAttempts = New-Object System.Collections.ArrayList
    try {
        Import-CviDdeBridgeType $source
        $sessionClient = New-ConnectedDdeClient $sessionAttempts $TargetProcessId
        if ($null -eq $sessionClient) {
            $lastError = if ($sessionAttempts.Count -gt 0) { [string]$sessionAttempts[$sessionAttempts.Count - 1].error } else { 'Unable to connect to the LabWindows/CVI DDE command server.' }
            Write-JsonLine ([ordered]@{
                ok = $false
                transport = 'dde-session'
                event = 'ready'
                command = ''
                argument = ''
                raw = ''
                error = $lastError
                mode = ''
                attempts = @($sessionAttempts)
                bootstrap = $bridgeBootstrap
            })
            exit 2
        }

        $connectedAttempt = @($sessionAttempts | Where-Object { $_.ok }) | Select-Object -First 1
        Write-JsonLine ([ordered]@{
            ok = $true
            transport = 'dde-session'
            event = 'ready'
            command = ''
            argument = ''
            raw = ''
            error = ''
            mode = if ($null -ne $connectedAttempt) { [string]$connectedAttempt.mode } else { '' }
            attempts = @($sessionAttempts)
            bootstrap = $bridgeBootstrap
            serverProcessId = $sessionClient.ServerProcessId
            serverWindowTitle = $sessionClient.ServerWindowTitle
            candidateProcessIds = @($sessionClient.CandidateProcessIds)
        })

        while ($null -ne ($line = [Console]::In.ReadLine())) {
            if ([string]::IsNullOrWhiteSpace($line)) {
                continue
            }
            $requestId = ''
            try {
                $request = $line | ConvertFrom-Json -ErrorAction Stop
                $requestId = [string]$request.id
                $requestCommand = [string]$request.command
                $requestArgument = if ($null -eq $request.argument) { '' } else { [string]$request.argument }
                $requestTimeout = if ($null -eq $request.timeoutMs) { $TimeoutMs } else { [int]$request.timeoutMs }
                if ($requestCommand -eq '__close__') {
                    Write-JsonLine ([ordered]@{
                        ok = $true
                        transport = 'dde-session'
                        event = 'response'
                        id = $requestId
                        command = $requestCommand
                        argument = ''
                        raw = '0'
                        error = ''
                        mode = if ($null -ne $connectedAttempt) { [string]$connectedAttempt.mode } else { '' }
                        serverProcessId = $sessionClient.ServerProcessId
                        serverWindowTitle = $sessionClient.ServerWindowTitle
                        candidateProcessIds = @($sessionClient.CandidateProcessIds)
                    })
                    break
                }
                $wireCommand = if ([string]::IsNullOrWhiteSpace($requestArgument)) { $requestCommand } else { "$requestCommand,$requestArgument" }
                $raw = $sessionClient.Execute($wireCommand, $requestTimeout)
                Write-JsonLine ([ordered]@{
                    ok = $true
                    transport = 'dde-session'
                    event = 'response'
                    id = $requestId
                    command = $requestCommand
                    argument = $requestArgument
                    raw = $raw
                    error = ''
                    mode = if ($null -ne $connectedAttempt) { [string]$connectedAttempt.mode } else { '' }
                    serverProcessId = $sessionClient.ServerProcessId
                    serverWindowTitle = $sessionClient.ServerWindowTitle
                    candidateProcessIds = @($sessionClient.CandidateProcessIds)
                })
            }
            catch {
                $deepest = Get-DeepestException $_.Exception
                $ddeError = Get-DdeErrorCode $_.Exception
                Write-JsonLine ([ordered]@{
                    ok = $false
                    transport = 'dde-session'
                    event = 'response'
                    id = $requestId
                    command = if ($null -eq $requestCommand) { '' } else { $requestCommand }
                    argument = if ($null -eq $requestArgument) { '' } else { $requestArgument }
                    raw = ''
                    error = $deepest.Message
                    mode = if ($null -ne $connectedAttempt) { [string]$connectedAttempt.mode } else { '' }
                    attempts = @([ordered]@{
                        mode = if ($null -ne $connectedAttempt) { [string]$connectedAttempt.mode } else { 'session' }
                        service = 'cvi'
                        topic = 'system'
                        item = 'status'
                        ok = $false
                        stage = Get-DdeStage $_.Exception
                        ddeError = $ddeError
                        ddeErrorName = [CviDdeBridge.CviDdeClient]::DescribeError($ddeError)
                        error = $deepest.Message
                    })
                })
            }
        }
    }
    catch {
        $deepest = Get-DeepestException $_.Exception
        Write-JsonLine ([ordered]@{
            ok = $false
            transport = 'dde-session'
            event = 'ready'
            command = ''
            argument = ''
            raw = ''
            error = $deepest.Message
            mode = ''
            attempts = @($sessionAttempts)
            bootstrap = $bridgeBootstrap
        })
        exit 3
    }
    finally {
        if ($null -ne $sessionClient) {
            $sessionClient.Dispose()
        }
    }
    exit 0
}

$result = [ordered]@{
    ok = $false
    transport = 'dde'
    command = $Command
    argument = $Argument
    raw = ''
    error = ''
    mode = ''
    attempts = @()
    bootstrap = $bridgeBootstrap
    serverProcessId = 0
    serverWindowTitle = ''
    candidateProcessIds = @()
}

try {
    Import-CviDdeBridgeType $source

    $wireCommand = if ([string]::IsNullOrWhiteSpace($Argument)) { $Command } else { "$Command,$Argument" }
    foreach ($mode in @('Ansi', 'Unicode')) {
        $client = $null
        try {
            $enumMode = [CviDdeBridge.DdeTextMode]::$mode
            $client = New-Object -TypeName 'CviDdeBridge.CviDdeClient' -ArgumentList @($enumMode, 'cvi', 'system', 'status', $TargetProcessId)
            $client.Connect()
            $result.raw = $client.Execute($wireCommand, $TimeoutMs)
            $result.ok = $true
            $result.mode = $mode.ToLowerInvariant()
            $result.serverProcessId = $client.ServerProcessId
            $result.serverWindowTitle = $client.ServerWindowTitle
            $result.candidateProcessIds = @($client.CandidateProcessIds)
            $result.attempts += [ordered]@{
                mode = $mode.ToLowerInvariant()
                service = 'cvi'
                topic = 'system'
                item = 'status'
                ok = $true
                stage = 'complete'
                ddeError = 0
                ddeErrorName = 'DMLERR_NO_ERROR'
                error = ''
            }
            break
        }
        catch {
            $deepest = Get-DeepestException $_.Exception
            $ddeError = Get-DdeErrorCode $_.Exception
            $ddeErrorName = [CviDdeBridge.CviDdeClient]::DescribeError($ddeError)
            $stage = Get-DdeStage $_.Exception
            $attempt = [ordered]@{
                mode = $mode.ToLowerInvariant()
                service = 'cvi'
                topic = 'system'
                item = 'status'
                ok = $false
                stage = $stage
                ddeError = $ddeError
                ddeErrorName = $ddeErrorName
                error = $deepest.Message
            }
            $result.attempts += $attempt
            $result.error = $deepest.Message
            if ($null -ne $client) {
                $result.candidateProcessIds = @($client.CandidateProcessIds)
                if ($client.ServerProcessId -gt 0) { $result.serverProcessId = $client.ServerProcessId }
                if (-not [string]::IsNullOrWhiteSpace($client.ServerWindowTitle)) { $result.serverWindowTitle = $client.ServerWindowTitle }
            }
        }
        finally {
            if ($null -ne $client) {
                $client.Dispose()
            }
        }
    }

    if (-not $result.ok -and [string]::IsNullOrWhiteSpace($result.error)) {
        $result.error = 'Unable to connect to the LabWindows/CVI DDE command server.'
    }
}
catch {
    $deepest = Get-DeepestException $_.Exception
    $result.error = $deepest.Message
}

$result | ConvertTo-Json -Compress -Depth 8
