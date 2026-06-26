#include "pythonExec.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

#if defined(_WIN32)
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/select.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#endif

namespace jc_python {

namespace {

#if defined(_WIN32)
std::string quoteArgWin(const std::string& arg)
{
    if (arg.empty()) return "\"\"";

    bool needQuotes = false;
    for (char c : arg) {
        if (c == ' ' || c == '\t' || c == '"') {
            needQuotes = true;
            break;
        }
    }
    if (!needQuotes) return arg;

    std::string out = "\"";
    int backslashes = 0;
    for (char c : arg) {
        if (c == '\\') {
            ++backslashes;
            continue;
        }
        if (c == '"') {
            out.append(backslashes * 2 + 1, '\\');
            out.push_back('"');
            backslashes = 0;
            continue;
        }
        out.append(backslashes, '\\');
        backslashes = 0;
        out.push_back(c);
    }
    out.append(backslashes * 2, '\\');
    out.push_back('"');
    return out;
}
#endif

} // namespace

PythonSession::PythonSession(const PythonConfig& cfg)
{
    start(cfg);
}

PythonSession::~PythonSession()
{
    close(false);
}

PythonSession::PythonSession(PythonSession&& other) noexcept
{
    moveFrom_(other);
}

PythonSession& PythonSession::operator=(PythonSession&& other) noexcept
{
    if (this != &other) {
        close(false);
        moveFrom_(other);
    }
    return *this;
}

void PythonSession::moveFrom_(PythonSession& other) noexcept
{
    cfg_ = other.cfg_;
    rxBuffer_ = std::move(other.rxBuffer_);
#if defined(_WIN32)
    processHandle_ = other.processHandle_;
    threadHandle_ = other.threadHandle_;
    other.processHandle_ = kInvalidHandle;
    other.threadHandle_ = kInvalidHandle;
#else
    pid_ = other.pid_;
    other.pid_ = -1;
#endif
    stdinWrite_ = other.stdinWrite_;
    stdoutRead_ = other.stdoutRead_;
    other.stdinWrite_ = kInvalidHandle;
    other.stdoutRead_ = kInvalidHandle;
    other.finished_ = false;
    other.cachedExitCode_ = -1;
}

bool PythonSession::start(const PythonConfig& cfg, const std::vector<std::string>& args)
{
    close(false);
    cfg_ = cfg;
    rxBuffer_.clear();
    finished_ = false;
    cachedExitCode_ = -1;
    finished_ = false;
    cachedExitCode_ = -1;

    if (cfg_.scriptPath.empty()) {
        return false;
    }

#if defined(_WIN32)
    SECURITY_ATTRIBUTES sa{};
    sa.nLength = sizeof(sa);
    sa.lpSecurityDescriptor = nullptr;
    sa.bInheritHandle = TRUE;

    HANDLE childStdoutRead = nullptr;
    HANDLE childStdoutWrite = nullptr;
    HANDLE childStdinRead = nullptr;
    HANDLE childStdinWrite = nullptr;

    if (!CreatePipe(&childStdoutRead, &childStdoutWrite, &sa, 0)) return false;
    if (!SetHandleInformation(childStdoutRead, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(childStdoutRead); CloseHandle(childStdoutWrite);
        return false;
    }

    if (!CreatePipe(&childStdinRead, &childStdinWrite, &sa, 0)) {
        CloseHandle(childStdoutRead); CloseHandle(childStdoutWrite);
        return false;
    }
    if (!SetHandleInformation(childStdinWrite, HANDLE_FLAG_INHERIT, 0)) {
        CloseHandle(childStdoutRead); CloseHandle(childStdoutWrite);
        CloseHandle(childStdinRead); CloseHandle(childStdinWrite);
        return false;
    }

    STARTUPINFOA si{};
    si.cb = sizeof(si);
    si.dwFlags |= STARTF_USESTDHANDLES;
    si.hStdInput = childStdinRead;
    si.hStdOutput = childStdoutWrite;
    si.hStdError = cfg_.mergeStdErrToStdOut ? childStdoutWrite : GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION pi{};

    std::vector<std::string> cmdParts;
    cmdParts.push_back(cfg_.pythonExe);
    if (cfg_.unbuffered) cmdParts.push_back("-u");
    cmdParts.push_back(cfg_.scriptPath);
    for (const auto& a : args) cmdParts.push_back(a);

    std::string commandLine;
    for (size_t i = 0; i < cmdParts.size(); ++i) {
        if (i) commandLine.push_back(' ');
        commandLine += quoteArgWin(cmdParts[i]);
    }

    std::vector<char> mutableCmd(commandLine.begin(), commandLine.end());
    mutableCmd.push_back('\0');

    BOOL ok = CreateProcessA(
        nullptr,
        mutableCmd.data(),
        nullptr,
        nullptr,
        TRUE,
        0,
        nullptr,
        cfg_.workingDirectory.empty() ? nullptr : cfg_.workingDirectory.c_str(),
        &si,
        &pi);

    CloseHandle(childStdoutWrite);
    CloseHandle(childStdinRead);

    if (!ok) {
        CloseHandle(childStdoutRead);
        CloseHandle(childStdinWrite);
        return false;
    }

    stdoutRead_ = childStdoutRead;
    stdinWrite_ = childStdinWrite;
    processHandle_ = pi.hProcess;
    threadHandle_ = pi.hThread;
    return true;

#else
    int stdinPipe[2] = { -1, -1 };
    int stdoutPipe[2] = { -1, -1 };

    if (pipe(stdinPipe) != 0) return false;
    if (pipe(stdoutPipe) != 0) {
        ::close(stdinPipe[0]);
        ::close(stdinPipe[1]);
        return false;
    }

    int childPid = fork();
    if (childPid < 0) {
        ::close(stdinPipe[0]); ::close(stdinPipe[1]);
        ::close(stdoutPipe[0]); ::close(stdoutPipe[1]);
        return false;
    }

    if (childPid == 0) {
        ::dup2(stdinPipe[0], STDIN_FILENO);
        ::dup2(stdoutPipe[1], STDOUT_FILENO);
        if (cfg_.mergeStdErrToStdOut) {
            ::dup2(stdoutPipe[1], STDERR_FILENO);
        }

        ::close(stdinPipe[0]); ::close(stdinPipe[1]);
        ::close(stdoutPipe[0]); ::close(stdoutPipe[1]);

        if (!cfg_.workingDirectory.empty()) {
            ::chdir(cfg_.workingDirectory.c_str());
        }

        std::vector<std::string> argvStore;
        argvStore.push_back(cfg_.pythonExe);
        if (cfg_.unbuffered) argvStore.push_back("-u");
        argvStore.push_back(cfg_.scriptPath);
        for (const auto& a : args) argvStore.push_back(a);

        std::vector<char*> argv;
        argv.reserve(argvStore.size() + 1);
        for (auto& s : argvStore) argv.push_back(s.data());
        argv.push_back(nullptr);

        ::execvp(cfg_.pythonExe.c_str(), argv.data());
        _exit(127);
    }

    ::close(stdinPipe[0]);
    ::close(stdoutPipe[1]);

    stdinWrite_ = stdinPipe[1];
    stdoutRead_ = stdoutPipe[0];
    pid_ = childPid;

    int flags = fcntl(stdoutRead_, F_GETFL, 0);
    if (flags >= 0) {
        fcntl(stdoutRead_, F_SETFL, flags | O_NONBLOCK);
    }
    return true;
#endif
}

void PythonSession::close(bool forceKill)
{
#if defined(_WIN32)
    if (processHandle_ != kInvalidHandle && forceKill && isRunning()) {
        TerminateProcess(static_cast<HANDLE>(processHandle_), 1);
        WaitForSingleObject(static_cast<HANDLE>(processHandle_), 1000);
    }
#else
    if (pid_ > 0 && forceKill && isRunning()) {
        ::kill(pid_, SIGTERM);
        for (int i = 0; i < 20 && isRunning(); ++i) {
            std::this_thread::sleep_for(std::chrono::milliseconds(50));
        }
        if (isRunning()) {
            ::kill(pid_, SIGKILL);
        }
        wait(1000);
    }
#endif

    closeInput();
    closeHandle_(stdoutRead_);

#if defined(_WIN32)
    closeHandle_(threadHandle_);
    closeHandle_(processHandle_);
#else
    if (pid_ > 0) {
        if (!finished_) {
            int status = 0;
            pid_t rc = ::waitpid(pid_, &status, WNOHANG);
            if (rc == pid_) {
                finished_ = true;
                if (WIFEXITED(status)) cachedExitCode_ = WEXITSTATUS(status);
                else if (WIFSIGNALED(status)) cachedExitCode_ = 128 + WTERMSIG(status);
            }
        }
        pid_ = -1;
    }
#endif

    rxBuffer_.clear();
}

void PythonSession::closeInput()
{
    closeHandle_(stdinWrite_);
}

bool PythonSession::isRunning() const
{
    if (finished_) return false;
#if defined(_WIN32)
    if (processHandle_ == kInvalidHandle) return false;
    DWORD exitCode = 0;
    if (!GetExitCodeProcess(static_cast<HANDLE>(processHandle_), &exitCode)) return false;
    if (exitCode == STILL_ACTIVE) return true;
    const_cast<PythonSession*>(this)->finished_ = true;
    const_cast<PythonSession*>(this)->cachedExitCode_ = static_cast<int>(exitCode);
    return false;
#else
    if (pid_ <= 0) return false;
    int status = 0;
    pid_t rc = ::waitpid(pid_, &status, WNOHANG);
    if (rc == 0) return true;
    if (rc == pid_) {
        const_cast<PythonSession*>(this)->finished_ = true;
        if (WIFEXITED(status)) const_cast<PythonSession*>(this)->cachedExitCode_ = WEXITSTATUS(status);
        else if (WIFSIGNALED(status)) const_cast<PythonSession*>(this)->cachedExitCode_ = 128 + WTERMSIG(status);
        else const_cast<PythonSession*>(this)->cachedExitCode_ = -1;
        return false;
    }
    return false;
#endif
}

int PythonSession::wait(int timeoutMs)
{
    if (finished_) return cachedExitCode_;
#if defined(_WIN32)
    if (processHandle_ == kInvalidHandle) return -1;
    DWORD ms = (timeoutMs < 0) ? INFINITE : static_cast<DWORD>(timeoutMs);
    DWORD wr = WaitForSingleObject(static_cast<HANDLE>(processHandle_), ms);
    if (wr != WAIT_OBJECT_0) return -1;

    DWORD exitCode = 0;
    if (!GetExitCodeProcess(static_cast<HANDLE>(processHandle_), &exitCode)) return -1;
    finished_ = true;
    cachedExitCode_ = static_cast<int>(exitCode);
    return cachedExitCode_;
#else
    if (pid_ <= 0) return finished_ ? cachedExitCode_ : -1;

    auto start = std::chrono::steady_clock::now();
    while (true) {
        int status = 0;
        pid_t rc = ::waitpid(pid_, &status, WNOHANG);
        if (rc == pid_) {
            finished_ = true;
            if (WIFEXITED(status)) cachedExitCode_ = WEXITSTATUS(status);
            else if (WIFSIGNALED(status)) cachedExitCode_ = 128 + WTERMSIG(status);
            else cachedExitCode_ = -1;
            return cachedExitCode_;
        }
        if (rc < 0) return finished_ ? cachedExitCode_ : -1;
        if (timeoutMs >= 0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= timeoutMs) return -1;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
#endif
}

int PythonSession::writeBytes(const uint8_t* data, size_t size)
{
    if (!data || size == 0) return 0;
    std::lock_guard<std::mutex> lock(ioMutex_);

#if defined(_WIN32)
    if (stdinWrite_ == kInvalidHandle) return -1;
    DWORD written = 0;
    if (!WriteFile(static_cast<HANDLE>(stdinWrite_), data, static_cast<DWORD>(size), &written, nullptr)) {
        return -1;
    }
    return static_cast<int>(written);
#else
    if (stdinWrite_ == kInvalidHandle) return -1;
    ssize_t rc = ::write(stdinWrite_, data, size);
    return (rc < 0) ? -1 : static_cast<int>(rc);
#endif
}

int PythonSession::writeString(const std::string& s)
{
    return writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
}

bool PythonSession::sendLine(const std::string& line)
{
    std::string s = line;
    if (s.empty() || s.back() != '\n') s.push_back('\n');
    return writeString(s) == static_cast<int>(s.size());
}

bool PythonSession::sendJson(const std::string& jsonLine)
{
    return sendLine(jsonLine);
}

int PythonSession::waitReadable_(int timeoutMs) const
{
#if defined(_WIN32)
    if (stdoutRead_ == kInvalidHandle) return -1;
    auto start = std::chrono::steady_clock::now();
    while (true) {
        DWORD avail = 0;
        if (!PeekNamedPipe(static_cast<HANDLE>(stdoutRead_), nullptr, 0, nullptr, &avail, nullptr)) {
            return -1;
        }
        if (avail > 0) return 1;
        if (!isRunning()) return 1; // permet de drainer après fin processus
        if (timeoutMs == 0) return 0;
        if (timeoutMs > 0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= timeoutMs) return 0;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
#else
    if (stdoutRead_ == kInvalidHandle) return -1;
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(stdoutRead_, &rfds);

    if (timeoutMs < 0) {
        int rc = ::select(stdoutRead_ + 1, &rfds, nullptr, nullptr, nullptr);
        return (rc > 0) ? 1 : rc;
    }

    timeval tv{};
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    int rc = ::select(stdoutRead_ + 1, &rfds, nullptr, nullptr, &tv);
    return (rc > 0) ? 1 : rc;
#endif
}

int PythonSession::readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs)
{
    if (!buffer || maxSize == 0) return 0;
    std::lock_guard<std::mutex> lock(ioMutex_);

    if (!rxBuffer_.empty()) 
    {
        size_t n = (maxSize < rxBuffer_.size()) ? maxSize : rxBuffer_.size();
        std::memcpy(buffer, rxBuffer_.data(), n);
        rxBuffer_.erase(rxBuffer_.begin(), rxBuffer_.begin() + static_cast<long>(n));
        return static_cast<int>(n);
    }

    int tm = (timeoutMs < 0) ? cfg_.readTimeoutMs : timeoutMs;
    int wr = waitReadable_(tm);
    if (wr <= 0) return wr;

#if defined(_WIN32)
    if (stdoutRead_ == kInvalidHandle) return -1;
    DWORD nread = 0;
    if (!ReadFile(static_cast<HANDLE>(stdoutRead_), buffer, static_cast<DWORD>(maxSize), &nread, nullptr)) {
        return 0;
    }
    return static_cast<int>(nread);
#else
    if (stdoutRead_ == kInvalidHandle) return -1;
    ssize_t rc = ::read(stdoutRead_, buffer, maxSize);
    if (rc < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) return 0;
        return -1;
    }
    return static_cast<int>(rc);
#endif
}

bool PythonSession::readLine(std::string& outLine, int timeoutMs, size_t maxLen)
{
    outLine.clear();
    auto start = std::chrono::steady_clock::now();

    while (outLine.size() < maxLen) {
        auto it = std::find(rxBuffer_.begin(), rxBuffer_.end(), static_cast<uint8_t>('\n'));
        if (it != rxBuffer_.end()) {
            size_t n = static_cast<size_t>(std::distance(rxBuffer_.begin(), it));
            outLine.assign(rxBuffer_.begin(), it);
            rxBuffer_.erase(rxBuffer_.begin(), it + 1);
            if (!outLine.empty() && outLine.back() == '\r') outLine.pop_back();
            return true;
        }

        uint8_t tmp[256];
        int perTry = 20;
        if (timeoutMs == 0) perTry = 0;
        int n = readBytes(tmp, sizeof(tmp), perTry);
        if (n > 0) {
            rxBuffer_.insert(rxBuffer_.end(), tmp, tmp + n);
            continue;
        }
        if (n < 0) return false;

        if (timeoutMs == 0) return false;
        if (timeoutMs > 0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= timeoutMs) return false;
        }
        if (!isRunning() && rxBuffer_.empty()) return false;
    }

    return false;
}

bool PythonSession::receiveJson(std::string& jsonLine, int timeoutMs)
{
    return readLine(jsonLine, timeoutMs);
}

void PythonSession::closeHandle_(handle_t& h)
{
#if defined(_WIN32)
    if (h != kInvalidHandle) {
        CloseHandle(static_cast<HANDLE>(h));
        h = kInvalidHandle;
    }
#else
    if (h != kInvalidHandle) {
        ::close(h);
        h = kInvalidHandle;
    }
#endif
}

PythonExecResult PythonRunner::runScript(const PythonConfig& cfg,
                                         const std::vector<std::string>& args,
                                         int timeoutMs)
{
    PythonExecResult result{};
    PythonSession session;
    if (!session.start(cfg, args)) {
        return result;
    }

    result.launched = true;
    session.closeInput();

    auto start = std::chrono::steady_clock::now();
    while (true) {
        uint8_t tmp[512];
        int n = session.readBytes(tmp, sizeof(tmp), 50);
        if (n > 0) {
            result.output.append(reinterpret_cast<const char*>(tmp), n);
        }

        if (!session.isRunning()) {
            while ((n = session.readBytes(tmp, sizeof(tmp), 20)) > 0) {
                result.output.append(reinterpret_cast<const char*>(tmp), n);
            }
            result.exitCode = session.wait(200);
            result.finished = true;
            session.close(false);
            return result;
        }

        if (timeoutMs >= 0) {
            auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
                std::chrono::steady_clock::now() - start).count();
            if (elapsed >= timeoutMs) {
                result.timedOut = true;
                session.close(true);
                return result;
            }
        }
    }
}

} // namespace jc_python
