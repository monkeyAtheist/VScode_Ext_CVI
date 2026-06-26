#include "ethernet.h"

#include <algorithm>
#include <cstring>
#include <utility>

#if defined(_WIN32)
#define NOMINMAX
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "Ws2_32.lib")
#else
#include <arpa/inet.h>
#include <cerrno>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#endif

namespace jc_ethernet {

    namespace {
#if defined(_WIN32)
        using socklen_type = int;
        constexpr int kSocketError = SOCKET_ERROR;
#else
        using socklen_type = socklen_t;
        constexpr int kSocketError = -1;
#endif

        int normalizeTimeout(int requested, int fallback)
        {
            return (requested >= 0) ? requested : fallback;
        }

        bool setNonBlockingSocket(jc_ethernet::EthernetLink::socket_handle_t s, bool enabled)
        {
#if defined(_WIN32)
            u_long mode = enabled ? 1UL : 0UL;
            return ::ioctlsocket(static_cast<SOCKET>(s), FIONBIO, &mode) == 0;
#else
            const int flags = ::fcntl(s, F_GETFL, 0);
            if (flags < 0)
                return false;
            const int newFlags = enabled ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
            return ::fcntl(s, F_SETFL, newFlags) == 0;
#endif
        }

        void closeNativeSocket(jc_ethernet::EthernetLink::socket_handle_t s)
        {
#if defined(_WIN32)
            ::closesocket(static_cast<SOCKET>(s));
#else
            ::close(s);
#endif
        }
    }

    EthernetLink::EthernetLink(const EthernetConfig& cfg)
    {
        open(cfg);
    }

    EthernetLink::~EthernetLink()
    {
        close();
    }

    EthernetLink::EthernetLink(EthernetLink&& other) noexcept
    {
        *this = std::move(other);
    }

    EthernetLink& EthernetLink::operator=(EthernetLink&& other) noexcept
    {
        if (this == &other)
            return *this;

        close();

        std::scoped_lock lock(other.ioMutex_);
        cfg_ = other.cfg_;
        rxBuffer_ = std::move(other.rxBuffer_);
        socket_ = other.socket_;
        peerSocket_ = other.peerSocket_;
        opened_ = other.opened_;

        other.socket_ = kInvalidSocket;
        other.peerSocket_ = kInvalidSocket;
        other.opened_ = false;

        return *this;
    }

    bool EthernetLink::initSockets_()
    {
#if defined(_WIN32)
        static bool initialized = false;
        static bool ok = false;
        if (!initialized) {
            WSADATA wsaData{};
            ok = (::WSAStartup(MAKEWORD(2, 2), &wsaData) == 0);
            initialized = true;
        }
        return ok;
#else
        return true;
#endif
    }

    void EthernetLink::cleanupSockets_()
    {
        // Rien ici : volontairement on ne fait pas de WSACleanup global.
    }

    void EthernetLink::closeSocket_(socket_handle_t& s)
    {
        if (s == kInvalidSocket)
            return;
        closeNativeSocket(s);
        s = kInvalidSocket;
    }

    bool EthernetLink::configureSocket_(socket_handle_t s)
    {
        if (s == kInvalidSocket)
            return false;

        if (cfg_.reuseAddress) {
            const int yes = 1;
            (void)::setsockopt(s, SOL_SOCKET, SO_REUSEADDR,
                reinterpret_cast<const char*>(&yes), sizeof(yes));
        }

        if (cfg_.protocol == EthernetProtocol::TCP && cfg_.tcpNoDelay) {
            const int yes = 1;
            (void)::setsockopt(s, IPPROTO_TCP, TCP_NODELAY,
                reinterpret_cast<const char*>(&yes), sizeof(yes));
        }

        return true;
    }

    bool EthernetLink::sockaddrFromEndpoint_(const Endpoint& ep, void* outSa, size_t& ioLen) const
    {
        if (!outSa)
            return false;

        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = (cfg_.protocol == EthernetProtocol::TCP) ? SOCK_STREAM : SOCK_DGRAM;
        hints.ai_protocol = (cfg_.protocol == EthernetProtocol::TCP) ? IPPROTO_TCP : IPPROTO_UDP;

        addrinfo* result = nullptr;
        const std::string portStr = std::to_string(ep.port);
        const int rc = ::getaddrinfo(ep.address.c_str(), portStr.c_str(), &hints, &result);
        if (rc != 0 || !result)
            return false;

        const size_t copyLen = std::min(ioLen, static_cast<size_t>(result->ai_addrlen));
        std::memcpy(outSa, result->ai_addr, copyLen);
        ioLen = static_cast<size_t>(result->ai_addrlen);
        ::freeaddrinfo(result);
        return true;
    }

    Endpoint EthernetLink::endpointFromSockaddr_(const void* sa, size_t salen) const
    {
        Endpoint ep;
        if (!sa || salen == 0)
            return ep;

        char host[NI_MAXHOST]{};
        char serv[NI_MAXSERV]{};
        const sockaddr* sockAddr = reinterpret_cast<const sockaddr*>(sa);
        if (::getnameinfo(sockAddr, static_cast<socklen_type>(salen),
            host, sizeof(host), serv, sizeof(serv),
            NI_NUMERICHOST | NI_NUMERICSERV) == 0) {
            ep.address = host;
            ep.port = static_cast<uint16_t>(std::strtoul(serv, nullptr, 10));
        }
        return ep;
    }

    bool EthernetLink::connectTcpClient_()
    {
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;

        addrinfo* result = nullptr;
        const std::string portStr = std::to_string(cfg_.port);
        if (::getaddrinfo(cfg_.host.c_str(), portStr.c_str(), &hints, &result) != 0 || !result)
            return false;

        bool ok = false;
        for (addrinfo* ai = result; ai != nullptr; ai = ai->ai_next) {
            socket_handle_t s = static_cast<socket_handle_t>(
                ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol));
            if (s == kInvalidSocket)
                continue;

            configureSocket_(s);

            if (!setNonBlockingSocket(s, true)) {
                closeNativeSocket(s);
                continue;
            }

            const int rc = ::connect(s, ai->ai_addr, static_cast<socklen_type>(ai->ai_addrlen));
#if defined(_WIN32)
            const int lastErr = ::WSAGetLastError();
            const bool inProgress = (rc == kSocketError &&
                (lastErr == WSAEWOULDBLOCK || lastErr == WSAEINPROGRESS || lastErr == WSAEINVAL));
#else
            const bool inProgress = (rc == kSocketError && errno == EINPROGRESS);
#endif
            if (rc == 0 || inProgress) {
                if (waitWritable_(s, cfg_.connectTimeoutMs) > 0) {
                    int soError = 0;
                    socklen_type optLen = sizeof(soError);
                    if (::getsockopt(s, SOL_SOCKET, SO_ERROR,
                        reinterpret_cast<char*>(&soError), &optLen) == 0 && soError == 0) {
                        (void)setNonBlockingSocket(s, false);
                        socket_ = s;
                        ok = true;
                        break;
                    }
                }
            }

            closeNativeSocket(s);
        }

        ::freeaddrinfo(result);
        return ok;
    }

    bool EthernetLink::openTcpServer_()
    {
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_STREAM;
        hints.ai_protocol = IPPROTO_TCP;
        hints.ai_flags = AI_PASSIVE;

        addrinfo* result = nullptr;
        const std::string portStr = std::to_string(cfg_.port);
        const char* bindHost = cfg_.bindAddress.empty() ? nullptr : cfg_.bindAddress.c_str();
        if (::getaddrinfo(bindHost, portStr.c_str(), &hints, &result) != 0 || !result)
            return false;

        bool ok = false;
        for (addrinfo* ai = result; ai != nullptr; ai = ai->ai_next) {
            socket_handle_t s = static_cast<socket_handle_t>(
                ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol));
            if (s == kInvalidSocket)
                continue;

            configureSocket_(s);

            if (::bind(s, ai->ai_addr, static_cast<socklen_type>(ai->ai_addrlen)) == 0 &&
                ::listen(s, std::max(1, cfg_.listenBacklog)) == 0) {
                socket_ = s;
                ok = true;
                break;
            }

            closeNativeSocket(s);
        }

        ::freeaddrinfo(result);
        return ok;
    }

    bool EthernetLink::openUdp_()
    {
        addrinfo hints{};
        hints.ai_family = AF_UNSPEC;
        hints.ai_socktype = SOCK_DGRAM;
        hints.ai_protocol = IPPROTO_UDP;

        addrinfo* result = nullptr;
        std::string portStr = std::to_string(cfg_.port);
        const bool doBind = (cfg_.mode == EthernetMode::Server) || !cfg_.bindAddress.empty();
        if (doBind)
            hints.ai_flags = AI_PASSIVE;

        const char* host = nullptr;
        if (doBind)
            host = cfg_.bindAddress.empty() ? nullptr : cfg_.bindAddress.c_str();
        else
            host = nullptr;

        if (::getaddrinfo(host, portStr.c_str(), &hints, &result) != 0 || !result)
            return false;

        bool ok = false;
        for (addrinfo* ai = result; ai != nullptr; ai = ai->ai_next) {
            socket_handle_t s = static_cast<socket_handle_t>(
                ::socket(ai->ai_family, ai->ai_socktype, ai->ai_protocol));
            if (s == kInvalidSocket)
                continue;

            configureSocket_(s);

            if (doBind) {
                if (::bind(s, ai->ai_addr, static_cast<socklen_type>(ai->ai_addrlen)) != 0) {
                    closeNativeSocket(s);
                    continue;
                }
            }

            socket_ = s;
            ok = true;
            break;
        }

        ::freeaddrinfo(result);
        return ok;
    }

    bool EthernetLink::open(const EthernetConfig& cfg)
    {
        close();
        cfg_ = cfg;

        if (!initSockets_())
            return false;

        bool ok = false;
        if (cfg_.protocol == EthernetProtocol::TCP) {
            ok = (cfg_.mode == EthernetMode::Server) ? openTcpServer_() : connectTcpClient_();
        }
        else {
            ok = openUdp_();
        }

        opened_ = ok;
        if (!ok)
            close();
        return ok;
    }

    void EthernetLink::close()
    {
        std::scoped_lock lock(ioMutex_);
        disconnectPeer();
        closeSocket_(socket_);
        rxBuffer_.clear();
        opened_ = false;
        cleanupSockets_();
    }

    bool EthernetLink::isOpen() const
    {
        return opened_ && socket_ != kInvalidSocket;
    }

    bool EthernetLink::hasPeer() const
    {
        if (!isOpen())
            return false;

        if (cfg_.protocol == EthernetProtocol::UDP)
            return true;

        if (cfg_.mode == EthernetMode::Client)
            return socket_ != kInvalidSocket;

        return peerSocket_ != kInvalidSocket;
    }

    bool EthernetLink::setTimeouts(int readMs, int writeMs)
    {
        cfg_.readTimeoutMs = std::max(0, readMs);
        cfg_.writeTimeoutMs = std::max(0, writeMs);
        return true;
    }

    EthernetLink::socket_handle_t EthernetLink::activeSocket_() const
    {
        if (cfg_.protocol == EthernetProtocol::UDP)
            return socket_;
        if (cfg_.mode == EthernetMode::Server)
            return peerSocket_;
        return socket_;
    }

    int EthernetLink::waitReadable_(socket_handle_t s, int timeoutMs) const
    {
        if (s == kInvalidSocket)
            return -1;

        fd_set readSet;
        FD_ZERO(&readSet);
        FD_SET(s, &readSet);

        timeval tv{};
        timeval* ptv = nullptr;
        if (timeoutMs >= 0) {
            tv.tv_sec = timeoutMs / 1000;
            tv.tv_usec = (timeoutMs % 1000) * 1000;
            ptv = &tv;
        }

#if defined(_WIN32)
        return ::select(0, &readSet, nullptr, nullptr, ptv);
#else
        return ::select(s + 1, &readSet, nullptr, nullptr, ptv);
#endif
    }

    int EthernetLink::waitWritable_(socket_handle_t s, int timeoutMs) const
    {
        if (s == kInvalidSocket)
            return -1;

        fd_set writeSet;
        FD_ZERO(&writeSet);
        FD_SET(s, &writeSet);

        timeval tv{};
        timeval* ptv = nullptr;
        if (timeoutMs >= 0) {
            tv.tv_sec = timeoutMs / 1000;
            tv.tv_usec = (timeoutMs % 1000) * 1000;
            ptv = &tv;
        }

#if defined(_WIN32)
        return ::select(0, nullptr, &writeSet, nullptr, ptv);
#else
        return ::select(s + 1, nullptr, &writeSet, nullptr, ptv);
#endif
    }

    bool EthernetLink::acceptClient(int timeoutMs)
    {
        if (!isOpen())
            return false;

        if (cfg_.protocol == EthernetProtocol::UDP || cfg_.mode == EthernetMode::Client)
            return true;

        if (peerSocket_ != kInvalidSocket)
            return true;

        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);
        if (waitReadable_(socket_, effectiveTimeout) <= 0)
            return false;

        sockaddr_storage clientAddr{};
        socklen_type addrLen = sizeof(clientAddr);
        socket_handle_t s = static_cast<socket_handle_t>(
            ::accept(socket_, reinterpret_cast<sockaddr*>(&clientAddr), &addrLen));
        if (s == kInvalidSocket)
            return false;

        configureSocket_(s);
        peerSocket_ = s;
        rxBuffer_.clear();
        return true;
    }

    void EthernetLink::disconnectPeer()
    {
        if (cfg_.protocol == EthernetProtocol::TCP && cfg_.mode == EthernetMode::Server)
            closeSocket_(peerSocket_);
        rxBuffer_.clear();
    }

    int EthernetLink::writeBytes(const uint8_t* data, size_t size)
    {
        if (!data || size == 0 || !isOpen())
            return -1;

        if (cfg_.protocol == EthernetProtocol::UDP) {
            Endpoint ep{ cfg_.host, cfg_.port };
            return sendTo(ep, data, size);
        }

        std::scoped_lock lock(ioMutex_);
        socket_handle_t s = activeSocket_();
        if (s == kInvalidSocket)
            return -1;

        if (waitWritable_(s, cfg_.writeTimeoutMs) <= 0)
            return -1;

        const int sent = ::send(s,
            reinterpret_cast<const char*>(data),
            static_cast<int>(size),
            0);
        return (sent == kSocketError) ? -1 : sent;
    }

    int EthernetLink::sendTo(const Endpoint& endpoint, const uint8_t* data, size_t size)
    {
        if (!data || size == 0 || !isOpen() || cfg_.protocol != EthernetProtocol::UDP)
            return -1;

        sockaddr_storage dst{};
        size_t dstLen = sizeof(dst);
        if (!sockaddrFromEndpoint_(endpoint, &dst, dstLen))
            return -1;

        std::scoped_lock lock(ioMutex_);
        if (waitWritable_(socket_, cfg_.writeTimeoutMs) <= 0)
            return -1;

        const int sent = ::sendto(socket_,
            reinterpret_cast<const char*>(data),
            static_cast<int>(size),
            0,
            reinterpret_cast<const sockaddr*>(&dst),
            static_cast<socklen_type>(dstLen));
        return (sent == kSocketError) ? -1 : sent;
    }

    int EthernetLink::readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs)
    {
        if (!buffer || maxSize == 0 || !isOpen())
            return -1;

        std::scoped_lock lock(ioMutex_);
        socket_handle_t s = activeSocket_();
        if (s == kInvalidSocket)
            return -1;

        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);
        if (waitReadable_(s, effectiveTimeout) <= 0)
            return 0;

        int ret = -1;
        if (cfg_.protocol == EthernetProtocol::UDP) {
            sockaddr_storage src{};
            socklen_type srcLen = sizeof(src);
            ret = ::recvfrom(socket_,
                reinterpret_cast<char*>(buffer),
                static_cast<int>(maxSize),
                0,
                reinterpret_cast<sockaddr*>(&src),
                &srcLen);
        }
        else {
            ret = ::recv(s,
                reinterpret_cast<char*>(buffer),
                static_cast<int>(maxSize),
                0);
        }

        if (ret == 0 && cfg_.protocol == EthernetProtocol::TCP) {
            if (cfg_.mode == EthernetMode::Server)
                closeSocket_(peerSocket_);
            else
                closeSocket_(socket_);
            return -1;
        }

        return (ret == kSocketError) ? -1 : ret;
    }

    int EthernetLink::receiveFrom(Endpoint& endpoint, uint8_t* buffer, size_t maxSize, int timeoutMs)
    {
        endpoint = {};
        if (!buffer || maxSize == 0 || !isOpen() || cfg_.protocol != EthernetProtocol::UDP)
            return -1;

        std::scoped_lock lock(ioMutex_);
        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);
        if (waitReadable_(socket_, effectiveTimeout) <= 0)
            return 0;

        sockaddr_storage src{};
        socklen_type srcLen = sizeof(src);
        const int ret = ::recvfrom(socket_,
            reinterpret_cast<char*>(buffer),
            static_cast<int>(maxSize),
            0,
            reinterpret_cast<sockaddr*>(&src),
            &srcLen);
        if (ret == kSocketError)
            return -1;

        endpoint = endpointFromSockaddr_(&src, static_cast<size_t>(srcLen));
        return ret;
    }

    int EthernetLink::writeString(const std::string& s)
    {
        return writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }

    int EthernetLink::readOne_(uint8_t& b, int timeoutMs)
    {
        return readBytes(&b, 1, timeoutMs);
    }

    bool EthernetLink::readLine(std::string& outLine, char eol, int timeoutMs, size_t maxLen)
    {
        outLine.clear();
        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);

        uint8_t c = 0;
        while (outLine.size() < maxLen) {
            const int n = readOne_(c, effectiveTimeout);
            if (n <= 0)
                return false;
            if (static_cast<char>(c) == eol)
                return true;
            outLine.push_back(static_cast<char>(c));
        }
        return false;
    }

    uint8_t EthernetLink::checksum8(const uint8_t* data, size_t size)
    {
        uint8_t chk = 0;
        for (size_t i = 0; i < size; ++i)
            chk ^= data[i];
        return chk;
    }

    bool EthernetLink::sendPacket(uint8_t type, const std::vector<uint8_t>& payload)
    {
        if (payload.size() > 65535u)
            return false;

        std::vector<uint8_t> frame;
        frame.reserve(payload.size() + 6);
        frame.push_back(0xAA);
        frame.push_back(0x55);
        frame.push_back(type);
        frame.push_back(static_cast<uint8_t>(payload.size() & 0xFFu));
        frame.push_back(static_cast<uint8_t>((payload.size() >> 8) & 0xFFu));
        frame.insert(frame.end(), payload.begin(), payload.end());

        const uint8_t chk = checksum8(frame.data() + 2, frame.size() - 2);
        frame.push_back(chk);

        if (cfg_.protocol == EthernetProtocol::UDP)
            return writeBytes(frame.data(), frame.size()) == static_cast<int>(frame.size());

        return writeBytes(frame.data(), frame.size()) == static_cast<int>(frame.size());
    }

    bool EthernetLink::receivePacket(Packet& packet, int timeoutMs)
    {
        packet = {};
        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);

        uint8_t b = 0;
        for (;;) {
            const int n = readOne_(b, effectiveTimeout);
            if (n <= 0)
                return false;

            rxBuffer_.push_back(b);
            while (rxBuffer_.size() >= 2 && rxBuffer_[0] != 0xAA)
                rxBuffer_.erase(rxBuffer_.begin());
            if (rxBuffer_.size() >= 2 && rxBuffer_[0] == 0xAA && rxBuffer_[1] != 0x55)
                rxBuffer_.erase(rxBuffer_.begin());

            if (rxBuffer_.size() < 5)
                continue;

            const uint16_t len = static_cast<uint16_t>(rxBuffer_[3]) |
                (static_cast<uint16_t>(rxBuffer_[4]) << 8);
            const size_t totalSize = 2u + 1u + 2u + len + 1u;
            if (rxBuffer_.size() < totalSize)
                continue;

            const uint8_t chk = checksum8(rxBuffer_.data() + 2, 3u + len);
            const uint8_t rxChk = rxBuffer_[totalSize - 1];

            if (chk != rxChk) {
                rxBuffer_.erase(rxBuffer_.begin());
                continue;
            }

            packet.type = rxBuffer_[2];
            packet.payload.assign(rxBuffer_.begin() + 5, rxBuffer_.begin() + 5 + len);
            rxBuffer_.erase(rxBuffer_.begin(), rxBuffer_.begin() + totalSize);
            return true;
        }
    }

    Endpoint EthernetLink::localEndpoint() const
    {
        Endpoint ep;
        if (!isOpen())
            return ep;

        sockaddr_storage sa{};
        socklen_type len = sizeof(sa);
        if (::getsockname(socket_, reinterpret_cast<sockaddr*>(&sa), &len) == 0)
            ep = endpointFromSockaddr_(&sa, static_cast<size_t>(len));
        return ep;
    }

    Endpoint EthernetLink::peerEndpoint() const
    {
        Endpoint ep;
        if (!hasPeer())
            return ep;

        if (cfg_.protocol == EthernetProtocol::UDP) {
            ep.address = cfg_.host;
            ep.port = cfg_.port;
            return ep;
        }

        const socket_handle_t s = activeSocket_();
        sockaddr_storage sa{};
        socklen_type len = sizeof(sa);
        if (::getpeername(s, reinterpret_cast<sockaddr*>(&sa), &len) == 0)
            ep = endpointFromSockaddr_(&sa, static_cast<size_t>(len));
        return ep;
    }

} // namespace jc_ethernet

