#include "bluetooth.h"

#include <algorithm>
#include <cstring>

#if defined(__linux__) && __has_include(<bluetooth/bluetooth.h>) && __has_include(<bluetooth/rfcomm.h>)
#define jc_BLUETOOTH_BLUEZ_AVAILABLE 1
#include <cerrno>
#include <fcntl.h>
#include <sys/select.h>
#include <sys/socket.h>
#include <unistd.h>
#include <bluetooth/bluetooth.h>
#include <bluetooth/rfcomm.h>
#else
#define jc_BLUETOOTH_BLUEZ_AVAILABLE 0
#endif

namespace jc_bluetooth {

    namespace {
        int normalizeTimeout(int requested, int fallback)
        {
            return (requested >= 0) ? requested : fallback;
        }
    }

    BluetoothLink::BluetoothLink(const BluetoothConfig& cfg)
    {
        open(cfg);
    }

    BluetoothLink::~BluetoothLink()
    {
        close();
    }

    BluetoothLink::BluetoothLink(BluetoothLink&& other) noexcept
    {
        *this = std::move(other);
    }

    BluetoothLink& BluetoothLink::operator=(BluetoothLink&& other) noexcept
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

    void BluetoothLink::closeSocket_(socket_handle_t& s)
    {
        if (s == kInvalidSocket)
            return;
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        ::close(s);
#endif
        s = kInvalidSocket;
    }

    bool BluetoothLink::setNonBlocking_(socket_handle_t s, bool enabled) const
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        const int flags = ::fcntl(s, F_GETFL, 0);
        if (flags < 0)
            return false;
        const int newFlags = enabled ? (flags | O_NONBLOCK) : (flags & ~O_NONBLOCK);
        return ::fcntl(s, F_SETFL, newFlags) == 0;
#else
        (void)s;
        (void)enabled;
        return false;
#endif
    }

    bool BluetoothLink::openClient_()
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        if (cfg_.remoteAddress.empty())
            return false;

        socket_handle_t s = ::socket(AF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM);
        if (s == kInvalidSocket)
            return false;

        sockaddr_rc addr{};
        addr.rc_family = AF_BLUETOOTH;
        addr.rc_channel = cfg_.channel;
        if (::str2ba(cfg_.remoteAddress.c_str(), &addr.rc_bdaddr) != 0) {
            closeSocket_(s);
            return false;
        }

        if (!setNonBlocking_(s, true)) {
            closeSocket_(s);
            return false;
        }

        const int rc = ::connect(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr));
        const bool inProgress = (rc < 0 && errno == EINPROGRESS);
        if (rc < 0 && !inProgress) {
            closeSocket_(s);
            return false;
        }

        if (rc == 0 || inProgress) {
            if (waitWritable_(s, cfg_.connectTimeoutMs) <= 0) {
                closeSocket_(s);
                return false;
            }

            int soError = 0;
            socklen_t optLen = sizeof(soError);
            if (::getsockopt(s, SOL_SOCKET, SO_ERROR, &soError, &optLen) != 0 || soError != 0) {
                closeSocket_(s);
                return false;
            }
        }

        if (!setNonBlocking_(s, false)) {
            closeSocket_(s);
            return false;
        }

        socket_ = s;
        return true;
#else
        return false;
#endif
    }

    bool BluetoothLink::openServer_()
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        socket_handle_t s = ::socket(AF_BLUETOOTH, SOCK_STREAM, BTPROTO_RFCOMM);
        if (s == kInvalidSocket)
            return false;

        sockaddr_rc addr{};
        addr.rc_family = AF_BLUETOOTH;
        addr.rc_channel = cfg_.channel;

        if (!cfg_.localAddress.empty()) {
            if (::str2ba(cfg_.localAddress.c_str(), &addr.rc_bdaddr) != 0) {
                closeSocket_(s);
                return false;
            }
        }
        else {
            sockaddr_rc addr{};
            addr.rc_family = AF_BLUETOOTH;
            addr.rc_channel = static_cast<uint8_t>(cfg_.channel);
            std::memset(&addr.rc_bdaddr, 0, sizeof(addr.rc_bdaddr));
        }

        if (::bind(s, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
            closeSocket_(s);
            return false;
        }

        if (::listen(s, std::max(1, cfg_.listenBacklog)) != 0) {
            closeSocket_(s);
            return false;
        }

        socket_ = s;
        return true;
#else
        return false;
#endif
    }

    bool BluetoothLink::open(const BluetoothConfig& cfg)
    {
        close();
        cfg_ = cfg;

        bool ok = false;
        if (cfg_.mode == BluetoothMode::Server)
            ok = openServer_();
        else
            ok = openClient_();

        opened_ = ok;
        if (!ok)
            close();
        return ok;
    }

    void BluetoothLink::close()
    {
        std::scoped_lock lock(ioMutex_);
        disconnectPeer();
        closeSocket_(socket_);
        rxBuffer_.clear();
        opened_ = false;
    }

    bool BluetoothLink::isOpen() const
    {
        return opened_ && socket_ != kInvalidSocket;
    }

    bool BluetoothLink::hasPeer() const
    {
        if (!isOpen())
            return false;
        if (cfg_.mode == BluetoothMode::Client)
            return socket_ != kInvalidSocket;
        return peerSocket_ != kInvalidSocket;
    }

    bool BluetoothLink::setTimeouts(int readMs, int writeMs)
    {
        cfg_.readTimeoutMs = std::max(0, readMs);
        cfg_.writeTimeoutMs = std::max(0, writeMs);
        return true;
    }

    BluetoothLink::socket_handle_t BluetoothLink::activeSocket_() const
    {
        if (cfg_.mode == BluetoothMode::Server)
            return peerSocket_;
        return socket_;
    }

    int BluetoothLink::waitReadable_(socket_handle_t s, int timeoutMs) const
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
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

        return ::select(s + 1, &readSet, nullptr, nullptr, ptv);
#else
        (void)s;
        (void)timeoutMs;
        return -1;
#endif
    }

    int BluetoothLink::waitWritable_(socket_handle_t s, int timeoutMs) const
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
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

        return ::select(s + 1, nullptr, &writeSet, nullptr, ptv);
#else
        (void)s;
        (void)timeoutMs;
        return -1;
#endif
    }

    bool BluetoothLink::acceptClient(int timeoutMs)
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        if (!isOpen())
            return false;

        if (cfg_.mode == BluetoothMode::Client)
            return true;

        if (peerSocket_ != kInvalidSocket)
            return true;

        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);
        if (waitReadable_(socket_, effectiveTimeout) <= 0)
            return false;

        sockaddr_rc remAddr{};
        socklen_t len = sizeof(remAddr);
        socket_handle_t s = ::accept(socket_, reinterpret_cast<sockaddr*>(&remAddr), &len);
        if (s == kInvalidSocket)
            return false;

        peerSocket_ = s;
        rxBuffer_.clear();
        return true;
#else
        (void)timeoutMs;
        return false;
#endif
    }

    void BluetoothLink::disconnectPeer()
    {
        if (cfg_.mode == BluetoothMode::Server)
            closeSocket_(peerSocket_);
        rxBuffer_.clear();
    }

    int BluetoothLink::writeBytes(const uint8_t* data, size_t size)
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        if (!data || size == 0 || !isOpen())
            return -1;

        std::scoped_lock lock(ioMutex_);
        socket_handle_t s = activeSocket_();
        if (s == kInvalidSocket)
            return -1;

        if (waitWritable_(s, cfg_.writeTimeoutMs) <= 0)
            return -1;

        size_t totalSent = 0;
        while (totalSent < size) {
            const ssize_t sent = ::send(s,
                data + totalSent,
                size - totalSent,
                0);
            if (sent <= 0)
                return (totalSent > 0) ? static_cast<int>(totalSent) : -1;
            totalSent += static_cast<size_t>(sent);
        }

        return static_cast<int>(totalSent);
#else
        (void)data;
        (void)size;
        return -1;
#endif
    }

    int BluetoothLink::writeString(const std::string& s)
    {
        return writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }

    int BluetoothLink::readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs)
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        if (!buffer || maxSize == 0 || !isOpen())
            return -1;

        std::scoped_lock lock(ioMutex_);
        socket_handle_t s = activeSocket_();
        if (s == kInvalidSocket)
            return -1;

        const int effectiveTimeout = normalizeTimeout(timeoutMs, cfg_.readTimeoutMs);
        if (waitReadable_(s, effectiveTimeout) <= 0)
            return 0;

        const ssize_t ret = ::recv(s, buffer, maxSize, 0);
        if (ret == 0) {
            if (cfg_.mode == BluetoothMode::Server)
                closeSocket_(peerSocket_);
            else {
                closeSocket_(socket_);
                opened_ = false;
            }
            return -1;
        }

        return (ret < 0) ? -1 : static_cast<int>(ret);
#else
        (void)buffer;
        (void)maxSize;
        (void)timeoutMs;
        return -1;
#endif
    }

    int BluetoothLink::readOne_(uint8_t& b, int timeoutMs)
    {
        return readBytes(&b, 1, timeoutMs);
    }

    bool BluetoothLink::readLine(std::string& outLine, char eol, int timeoutMs, size_t maxLen)
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

    uint8_t BluetoothLink::checksum8(const uint8_t* data, size_t size)
    {
        uint8_t chk = 0;
        for (size_t i = 0; i < size; ++i)
            chk ^= data[i];
        return chk;
    }

    bool BluetoothLink::sendPacket(uint8_t type, const std::vector<uint8_t>& payload)
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

        return writeBytes(frame.data(), frame.size()) == static_cast<int>(frame.size());
    }

    bool BluetoothLink::receivePacket(Packet& packet, int timeoutMs)
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

    std::string BluetoothLink::localAddress() const
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        if (!isOpen())
            return {};

        sockaddr_rc addr{};
        socklen_t len = sizeof(addr);
        if (::getsockname(socket_, reinterpret_cast<sockaddr*>(&addr), &len) != 0)
            return {};

        char out[19]{};
        ::ba2str(&addr.rc_bdaddr, out);
        return std::string(out);
#else
        return {};
#endif
    }

    std::string BluetoothLink::peerAddress() const
    {
#if jc_BLUETOOTH_BLUEZ_AVAILABLE
        if (!hasPeer())
            return {};

        const socket_handle_t s = activeSocket_();
        sockaddr_rc addr{};
        socklen_t len = sizeof(addr);
        if (::getpeername(s, reinterpret_cast<sockaddr*>(&addr), &len) != 0)
            return {};

        char out[19]{};
        ::ba2str(&addr.rc_bdaddr, out);
        return std::string(out);
#else
        return {};
#endif
    }

} // namespace jc_bluetooth
