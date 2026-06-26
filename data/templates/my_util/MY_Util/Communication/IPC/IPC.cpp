#include "IPC.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <thread>

#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <poll.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/un.h>
#include <unistd.h>
#endif

namespace jc_ipc {

    namespace {
        using clock_t = std::chrono::steady_clock;

        int normalizedTimeout(int requested, int fallback)
        {
            return (requested < 0) ? fallback : std::max(0, requested);
        }

#if defined(_WIN32)
        std::string toWinPipePath(const std::string& name)
        {
            if (name.rfind(R"(\\.\pipe\)", 0) == 0)
                return name;
            return std::string(R"(\\.\pipe\)") + name;
        }
#else
        std::string defaultUnixSocketPath(const std::string& name)
        {
            if (!name.empty() && name.front() == '/')
                return name;
            return "/tmp/" + name;
        }

        bool setBlockingMode(int fd, bool blocking)
        {
            int flags = fcntl(fd, F_GETFL, 0);
            if (flags < 0) return false;
            if (blocking)
                flags &= ~O_NONBLOCK;
            else
                flags |= O_NONBLOCK;
            return fcntl(fd, F_SETFL, flags) == 0;
        }

        int openWithRetry(const std::string& path, int flags, int timeoutMs)
        {
            auto start = clock_t::now();
            const int effectiveTimeout = std::max(0, timeoutMs);

            while (true) {
                int fd = ::open(path.c_str(), flags | O_NONBLOCK);
                if (fd >= 0)
                    return fd;

                if (errno != ENXIO && errno != ENOENT)
                    return -1;

                const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(clock_t::now() - start).count();
                if (elapsed >= effectiveTimeout)
                    return -1;

                std::this_thread::sleep_for(std::chrono::milliseconds(20));
            }
        }
#endif
    }

    IpcPipe::IpcPipe(const IpcConfig& cfg)
    {
        open(cfg);
    }

    IpcPipe::~IpcPipe()
    {
        close();
    }

    IpcPipe::IpcPipe(IpcPipe&& other) noexcept
    {
        *this = std::move(other);
    }

    IpcPipe& IpcPipe::operator=(IpcPipe&& other) noexcept
    {
        if (this == &other)
            return *this;

        close();

        std::scoped_lock lock(other.ioMutex_);
        cfg_ = other.cfg_;
        rxBuffer_ = std::move(other.rxBuffer_);
        controlHandle_ = other.controlHandle_;
        readHandle_ = other.readHandle_;
        writeHandle_ = other.writeHandle_;
        opened_ = other.opened_;
        peerConnected_ = other.peerConnected_;
        ownsEndpoint_ = other.ownsEndpoint_;
        endpointNameResolved_ = std::move(other.endpointNameResolved_);

        other.controlHandle_ = kInvalidHandle;
        other.readHandle_ = kInvalidHandle;
        other.writeHandle_ = kInvalidHandle;
        other.opened_ = false;
        other.peerConnected_ = false;
        other.ownsEndpoint_ = false;
        other.endpointNameResolved_.clear();

        return *this;
    }

    bool IpcPipe::open(const IpcConfig& cfg)
    {
        close();
        cfg_ = cfg;
        rxBuffer_.clear();

        switch (cfg_.type) {
        case PipeType::NamedPipe:
            return openNamedPipe_();
        case PipeType::Fifo:
            return openFifo_();
        case PipeType::Anonymous:
            return openAnonymous_();
        default:
            return false;
        }
    }

    void IpcPipe::close()
    {
        std::scoped_lock lock(ioMutex_);

        closeHandle_(readHandle_);
        if (writeHandle_ != readHandle_)
            closeHandle_(writeHandle_);
        else
            writeHandle_ = kInvalidHandle;
        closeHandle_(controlHandle_);

#if !defined(_WIN32)
        if (ownsEndpoint_ && cfg_.removeEndpointOnClose && cfg_.type == PipeType::NamedPipe && !endpointNameResolved_.empty()) {
            ::unlink(endpointNameResolved_.c_str());
        }
        if (ownsEndpoint_ && cfg_.removeEndpointOnClose && cfg_.type == PipeType::Fifo && !endpointNameResolved_.empty()) {
            ::unlink((endpointNameResolved_ + "_c2s").c_str());
            ::unlink((endpointNameResolved_ + "_s2c").c_str());
        }
#endif

        opened_ = false;
        peerConnected_ = false;
        ownsEndpoint_ = false;
        endpointNameResolved_.clear();
        rxBuffer_.clear();
    }

    bool IpcPipe::isOpen() const
    {
        return opened_;
    }

    bool IpcPipe::hasPeer() const
    {
        return opened_ && peerConnected_;
    }

    bool IpcPipe::waitPeer(int timeoutMs)
    {
        if (!opened_) return false;

        switch (cfg_.type) {
        case PipeType::NamedPipe:
            return waitPeerNamedPipe_(timeoutMs);
        case PipeType::Fifo:
        case PipeType::Anonymous:
            return isOpen();
        default:
            return false;
        }
    }

    bool IpcPipe::setTimeouts(int readMs, int writeMs)
    {
        cfg_.readTimeoutMs = std::max(0, readMs);
        cfg_.writeTimeoutMs = std::max(0, writeMs);
        return true;
    }

    void IpcPipe::closeHandle_(handle_t& h)
    {
        if (h == kInvalidHandle)
            return;

#if defined(_WIN32)
        CloseHandle(static_cast<HANDLE>(h));
#else
        ::close(h);
#endif
        h = kInvalidHandle;
    }

    bool IpcPipe::openAnonymous_()
    {
        // Un pipe anonyme nécessite une paire ; utiliser createAnonymousPair().
        opened_ = false;
        peerConnected_ = false;
        return false;
    }

    bool IpcPipe::createAnonymousPair(IpcPipe& reader, IpcPipe& writer, int readTimeoutMs, int writeTimeoutMs)
    {
        reader.close();
        writer.close();

#if defined(_WIN32)
        HANDLE hRead = nullptr;
        HANDLE hWrite = nullptr;
        SECURITY_ATTRIBUTES sa{};
        sa.nLength = sizeof(sa);
        sa.bInheritHandle = FALSE;
        sa.lpSecurityDescriptor = nullptr;

        if (!CreatePipe(&hRead, &hWrite, &sa, 0))
            return false;

        reader.cfg_.type = PipeType::Anonymous;
        reader.cfg_.access = PipeAccess::ReadOnly;
        reader.cfg_.readTimeoutMs = std::max(0, readTimeoutMs);
        reader.cfg_.writeTimeoutMs = 0;
        reader.readHandle_ = hRead;
        reader.writeHandle_ = kInvalidHandle;
        reader.opened_ = true;
        reader.peerConnected_ = true;

        writer.cfg_.type = PipeType::Anonymous;
        writer.cfg_.access = PipeAccess::WriteOnly;
        writer.cfg_.readTimeoutMs = 0;
        writer.cfg_.writeTimeoutMs = std::max(0, writeTimeoutMs);
        writer.readHandle_ = kInvalidHandle;
        writer.writeHandle_ = hWrite;
        writer.opened_ = true;
        writer.peerConnected_ = true;
        return true;
#else
        int fds[2] = { -1, -1 };
        if (::pipe(fds) != 0)
            return false;

        reader.cfg_.type = PipeType::Anonymous;
        reader.cfg_.access = PipeAccess::ReadOnly;
        reader.cfg_.readTimeoutMs = std::max(0, readTimeoutMs);
        reader.readHandle_ = fds[0];
        reader.writeHandle_ = kInvalidHandle;
        reader.opened_ = true;
        reader.peerConnected_ = true;

        writer.cfg_.type = PipeType::Anonymous;
        writer.cfg_.access = PipeAccess::WriteOnly;
        writer.cfg_.writeTimeoutMs = std::max(0, writeTimeoutMs);
        writer.readHandle_ = kInvalidHandle;
        writer.writeHandle_ = fds[1];
        writer.opened_ = true;
        writer.peerConnected_ = true;
        return true;
#endif
    }

    bool IpcPipe::openNamedPipe_()
    {
#if defined(_WIN32)
        endpointNameResolved_ = toWinPipePath(cfg_.name);

        if (cfg_.role == PipeRole::Server) {
            DWORD openMode = PIPE_ACCESS_DUPLEX;
            DWORD pipeMode = cfg_.messageMode ? (PIPE_TYPE_MESSAGE | PIPE_READMODE_MESSAGE) : (PIPE_TYPE_BYTE | PIPE_READMODE_BYTE);
            pipeMode |= PIPE_WAIT;

            HANDLE h = CreateNamedPipeA(
                endpointNameResolved_.c_str(),
                openMode,
                pipeMode,
                1,
                4096,
                4096,
                0,
                nullptr);

            if (h == INVALID_HANDLE_VALUE)
                return false;

            controlHandle_ = h;
            readHandle_ = h;
            writeHandle_ = h;
            opened_ = true;
            peerConnected_ = false;
            ownsEndpoint_ = true;
            return true;
        }

        auto start = clock_t::now();
        const int timeoutMs = std::max(0, cfg_.connectTimeoutMs);
        while (true) {
            if (WaitNamedPipeA(endpointNameResolved_.c_str(), timeoutMs)) {
                HANDLE h = CreateFileA(
                    endpointNameResolved_.c_str(),
                    GENERIC_READ | GENERIC_WRITE,
                    0,
                    nullptr,
                    OPEN_EXISTING,
                    0,
                    nullptr);

                if (h != INVALID_HANDLE_VALUE) {
                    readHandle_ = h;
                    writeHandle_ = h;
                    opened_ = true;
                    peerConnected_ = true;
                    return true;
                }
            }

            const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(clock_t::now() - start).count();
            if (elapsed >= timeoutMs)
                return false;
            std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
#else
        endpointNameResolved_ = defaultUnixSocketPath(cfg_.name);

        if (cfg_.role == PipeRole::Server) {
            int s = ::socket(AF_UNIX, SOCK_STREAM, 0);
            if (s < 0)
                return false;

            sockaddr_un addr{};
            addr.sun_family = AF_UNIX;
            std::strncpy(addr.sun_path, endpointNameResolved_.c_str(), sizeof(addr.sun_path) - 1);

            if (cfg_.createIfMissing) {
                ::unlink(endpointNameResolved_.c_str());
            }

            if (::bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
                ::close(s);
                return false;
            }
            if (::listen(s, 1) != 0) {
                ::close(s);
                ::unlink(endpointNameResolved_.c_str());
                return false;
            }

            controlHandle_ = s;
            opened_ = true;
            peerConnected_ = false;
            ownsEndpoint_ = true;
            return true;
        }

        int s = ::socket(AF_UNIX, SOCK_STREAM, 0);
        if (s < 0)
            return false;

        if (!setBlockingMode(s, false)) {
            ::close(s);
            return false;
        }

        sockaddr_un addr{};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, endpointNameResolved_.c_str(), sizeof(addr.sun_path) - 1);

        int ret = ::connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
        if (ret != 0 && errno != EINPROGRESS) {
            ::close(s);
            return false;
        }

        if (ret != 0) {
            fd_set wfds;
            FD_ZERO(&wfds);
            FD_SET(s, &wfds);
            timeval tv{};
            const int timeoutMs = std::max(0, cfg_.connectTimeoutMs);
            tv.tv_sec = timeoutMs / 1000;
            tv.tv_usec = (timeoutMs % 1000) * 1000;
            ret = ::select(s + 1, nullptr, &wfds, nullptr, &tv);
            if (ret <= 0) {
                ::close(s);
                return false;
            }

            int soErr = 0;
            socklen_t len = sizeof(soErr);
            if (getsockopt(s, SOL_SOCKET, SO_ERROR, &soErr, &len) != 0 || soErr != 0) {
                ::close(s);
                return false;
            }
        }

        setBlockingMode(s, true);
        readHandle_ = s;
        writeHandle_ = s;
        opened_ = true;
        peerConnected_ = true;
        return true;
#endif
    }

    bool IpcPipe::waitPeerNamedPipe_(int timeoutMs)
    {
        if (!opened_) return false;
        if (peerConnected_) return true;
        if (cfg_.role != PipeRole::Server) return isOpen();

#if defined(_WIN32)
        if (controlHandle_ == kInvalidHandle)
            return false;

        BOOL ok = ConnectNamedPipe(static_cast<HANDLE>(controlHandle_), nullptr)
            ? TRUE
            : (GetLastError() == ERROR_PIPE_CONNECTED);

        if (!ok)
            return false;

        readHandle_ = controlHandle_;
        writeHandle_ = controlHandle_;
        peerConnected_ = true;
        return true;
#else
        if (controlHandle_ == kInvalidHandle)
            return false;

        const int effectiveTimeout = (timeoutMs < 0) ? cfg_.connectTimeoutMs : timeoutMs;
        if (!setBlockingMode(controlHandle_, false))
            return false;

        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(controlHandle_, &rfds);
        timeval tv{};
        tv.tv_sec = std::max(0, effectiveTimeout) / 1000;
        tv.tv_usec = (std::max(0, effectiveTimeout) % 1000) * 1000;
        int ret = ::select(controlHandle_ + 1, &rfds, nullptr, nullptr, &tv);
        if (ret <= 0) {
            setBlockingMode(controlHandle_, true);
            return false;
        }

        int client = ::accept(controlHandle_, nullptr, nullptr);
        setBlockingMode(controlHandle_, true);
        if (client < 0)
            return false;

        readHandle_ = client;
        writeHandle_ = client;
        peerConnected_ = true;
        return true;
#endif
    }

    bool IpcPipe::openFifo_()
    {
#if defined(_WIN32)
        // Pas d'équivalent FIFO POSIX générique côté Windows dans ce proto.
        opened_ = false;
        peerConnected_ = false;
        return false;
#else
        endpointNameResolved_ = defaultUnixSocketPath(cfg_.name);
        const std::string c2s = endpointNameResolved_ + "_c2s";
        const std::string s2c = endpointNameResolved_ + "_s2c";

        if (cfg_.createIfMissing && cfg_.role == PipeRole::Server) {
            ::mkfifo(c2s.c_str(), 0666);
            ::mkfifo(s2c.c_str(), 0666);
            ownsEndpoint_ = true;
        }

        std::string readPath;
        std::string writePath;
        switch (cfg_.role) {
        case PipeRole::Server:
            readPath = c2s;
            writePath = s2c;
            break;
        case PipeRole::Client:
            readPath = s2c;
            writePath = c2s;
            break;
        }

        const int timeoutMs = std::max(0, cfg_.connectTimeoutMs);

        if (cfg_.access == PipeAccess::ReadOnly || cfg_.access == PipeAccess::ReadWrite) {
            readHandle_ = openWithRetry(readPath, O_RDONLY, timeoutMs);
            if (readHandle_ < 0) {
                close();
                return false;
            }
            setBlockingMode(readHandle_, true);
        }

        if (cfg_.access == PipeAccess::WriteOnly || cfg_.access == PipeAccess::ReadWrite) {
            writeHandle_ = openWithRetry(writePath, O_WRONLY, timeoutMs);
            if (writeHandle_ < 0) {
                close();
                return false;
            }
            setBlockingMode(writeHandle_, true);
        }

        opened_ = true;
        peerConnected_ = true;
        return true;
#endif
    }

    int IpcPipe::waitReadable_(handle_t h, int timeoutMs) const
    {
        if (h == kInvalidHandle)
            return -1;

        const int effectiveTimeout = normalizedTimeout(timeoutMs, cfg_.readTimeoutMs);

#if defined(_WIN32)
        const auto start = clock_t::now();
        while (true) {
            DWORD avail = 0;
            BOOL ok = PeekNamedPipe(static_cast<HANDLE>(h), nullptr, 0, nullptr, &avail, nullptr);
            if (!ok)
                return -1;
            if (avail > 0)
                return 1;

            const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(clock_t::now() - start).count();
            if (elapsed >= effectiveTimeout)
                return 0;
            std::this_thread::sleep_for(std::chrono::milliseconds(5));
        }
#else
        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(h, &rfds);
        timeval tv{};
        tv.tv_sec = effectiveTimeout / 1000;
        tv.tv_usec = (effectiveTimeout % 1000) * 1000;
        return ::select(h + 1, &rfds, nullptr, nullptr, &tv);
#endif
    }

    int IpcPipe::waitWritable_(handle_t h, int timeoutMs) const
    {
        if (h == kInvalidHandle)
            return -1;

        const int effectiveTimeout = normalizedTimeout(timeoutMs, cfg_.writeTimeoutMs);

#if defined(_WIN32)
        (void)effectiveTimeout;
        (void)h;
        return 1;
#else
        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(h, &wfds);
        timeval tv{};
        tv.tv_sec = effectiveTimeout / 1000;
        tv.tv_usec = (effectiveTimeout % 1000) * 1000;
        return ::select(h + 1, nullptr, &wfds, nullptr, &tv);
#endif
    }

    int IpcPipe::writeBytes(const uint8_t* data, size_t size)
    {
        if (!opened_ || writeHandle_ == kInvalidHandle || !data || size == 0)
            return -1;

        std::scoped_lock lock(ioMutex_);
        if (waitWritable_(writeHandle_, cfg_.writeTimeoutMs) <= 0)
            return -1;

#if defined(_WIN32)
        DWORD written = 0;
        if (!WriteFile(static_cast<HANDLE>(writeHandle_), data, static_cast<DWORD>(size), &written, nullptr))
            return -1;
        return static_cast<int>(written);
#else
        ssize_t ret = ::write(writeHandle_, data, size);
        if (ret < 0)
            return -1;
        return static_cast<int>(ret);
#endif
    }

    int IpcPipe::writeString(const std::string& s)
    {
        return writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }

    int IpcPipe::readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs)
    {
        if (!opened_ || readHandle_ == kInvalidHandle || !buffer || maxSize == 0)
            return -1;

        if (waitReadable_(readHandle_, timeoutMs) <= 0)
            return 0;

        std::scoped_lock lock(ioMutex_);
#if defined(_WIN32)
        DWORD read = 0;
        if (!ReadFile(static_cast<HANDLE>(readHandle_), buffer, static_cast<DWORD>(maxSize), &read, nullptr))
            return -1;
        return static_cast<int>(read);
#else
        ssize_t ret = ::read(readHandle_, buffer, maxSize);
        if (ret < 0)
            return -1;
        return static_cast<int>(ret);
#endif
    }

    int IpcPipe::readOne_(uint8_t& b, int timeoutMs)
    {
        return readBytes(&b, 1, timeoutMs);
    }

    bool IpcPipe::readLine(std::string& outLine, char eol, int timeoutMs, size_t maxLen)
    {
        outLine.clear();
        auto start = clock_t::now();

        while (outLine.size() < maxLen) {
            uint8_t b = 0;
            const int chunkTimeout = (timeoutMs < 0)
                ? cfg_.readTimeoutMs
                : std::max(0, timeoutMs - static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(clock_t::now() - start).count()));

            int n = readOne_(b, chunkTimeout);
            if (n < 0)
                return false;
            if (n == 0) {
                if (!outLine.empty())
                    return true;
                if (timeoutMs >= 0 && std::chrono::duration_cast<std::chrono::milliseconds>(clock_t::now() - start).count() >= timeoutMs)
                    return false;
                continue;
            }

            if (static_cast<char>(b) == eol)
                return true;

            if (b != '\r')
                outLine.push_back(static_cast<char>(b));
        }

        return !outLine.empty();
    }

    uint8_t IpcPipe::checksum8(const uint8_t* data, size_t size)
    {
        uint8_t sum = 0;
        for (size_t i = 0; i < size; ++i)
            sum ^= data[i];
        return sum;
    }

    bool IpcPipe::sendPacket(uint8_t type, const std::vector<uint8_t>& payload)
    {
        std::vector<uint8_t> frame;
        frame.reserve(payload.size() + 6);
        frame.push_back(0xAA);
        frame.push_back(0x55);
        frame.push_back(type);
        frame.push_back(static_cast<uint8_t>(payload.size() & 0xFF));
        frame.push_back(static_cast<uint8_t>((payload.size() >> 8) & 0xFF));
        frame.insert(frame.end(), payload.begin(), payload.end());
        frame.push_back(checksum8(frame.data() + 2, frame.size() - 2));

        return writeBytes(frame.data(), frame.size()) == static_cast<int>(frame.size());
    }

    bool IpcPipe::receivePacket(Packet& packet, int timeoutMs)
    {
        auto start = clock_t::now();
        auto timeLeft = [&]() -> int {
            if (timeoutMs < 0)
                return cfg_.readTimeoutMs;
            const int elapsed = static_cast<int>(std::chrono::duration_cast<std::chrono::milliseconds>(clock_t::now() - start).count());
            return std::max(0, timeoutMs - elapsed);
            };

        auto readExact = [&](uint8_t* dst, size_t n) -> bool {
            size_t got = 0;
            while (got < n) {
                int r = readBytes(dst + got, n - got, timeLeft());
                if (r <= 0)
                    return false;
                got += static_cast<size_t>(r);
            }
            return true;
            };

        uint8_t b = 0;
        while (true) {
            if (!readExact(&b, 1))
                return false;
            if (b != 0xAA)
                continue;
            if (!readExact(&b, 1))
                return false;
            if (b == 0x55)
                break;
        }

        uint8_t header[3]{};
        if (!readExact(header, sizeof(header)))
            return false;

        const uint8_t type = header[0];
        const uint16_t len = static_cast<uint16_t>(header[1]) | (static_cast<uint16_t>(header[2]) << 8);

        std::vector<uint8_t> payload(len);
        if (len > 0 && !readExact(payload.data(), payload.size()))
            return false;

        uint8_t rxChk = 0;
        if (!readExact(&rxChk, 1))
            return false;

        std::vector<uint8_t> chkBuf;
        chkBuf.reserve(3 + payload.size());
        chkBuf.push_back(type);
        chkBuf.push_back(header[1]);
        chkBuf.push_back(header[2]);
        chkBuf.insert(chkBuf.end(), payload.begin(), payload.end());

        if (checksum8(chkBuf.data(), chkBuf.size()) != rxChk)
            return false;

        packet.type = type;
        packet.payload = std::move(payload);
        return true;
    }

} // namespace jc_ipc

