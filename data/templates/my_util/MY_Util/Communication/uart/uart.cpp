#include "uart.h"

#include <algorithm>
#include <cstring>

#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <sys/select.h>
#include <termios.h>
#include <unistd.h>
#endif

namespace jc_uart {

    namespace {
#if !defined(_WIN32)
        speed_t toBaudLinux(int baud)
        {
            switch (baud) {
            case 1200: return B1200;
            case 2400: return B2400;
            case 4800: return B4800;
            case 9600: return B9600;
            case 19200: return B19200;
            case 38400: return B38400;
            case 57600: return B57600;
            case 115200: return B115200;
            case 230400: return B230400;
#ifdef B460800
            case 460800: return B460800;
#endif
#ifdef B921600
            case 921600: return B921600;
#endif
            default: return 0;
            }
        }
#endif
    }

    Uart::Uart(const UartConfig& cfg)
    {
        open(cfg);
    }

    Uart::~Uart()
    {
        close();
    }

    Uart::Uart(Uart&& other) noexcept
    {
        *this = std::move(other);
    }

    Uart& Uart::operator=(Uart&& other) noexcept
    {
        if (this == &other)
            return *this;

        close();

        std::scoped_lock lock(other.ioMutex_);
        cfg_ = other.cfg_;
        rxBuffer_ = std::move(other.rxBuffer_);
        lineBuffer_ = std::move(other.lineBuffer_);
#if defined(_WIN32)
        handle_ = other.handle_;
        other.handle_ = nullptr;
#else
        fd_ = other.fd_;
        other.fd_ = -1;
#endif
        return *this;
    }

    bool Uart::open(const UartConfig& cfg)
    {
        close();
        cfg_ = cfg;

#if defined(_WIN32)
        HANDLE h = CreateFileA(
            cfg.port.c_str(),
            GENERIC_READ | GENERIC_WRITE,
            0,
            nullptr,
            OPEN_EXISTING,
            0,
            nullptr);

        if (h == INVALID_HANDLE_VALUE) {
            handle_ = nullptr;
            return false;
        }

        handle_ = h;
        if (!configurePort_()) {
            close();
            return false;
        }
        return true;
#else
        fd_ = ::open(cfg.port.c_str(), O_RDWR | O_NOCTTY | O_SYNC);
        if (fd_ < 0) {
            fd_ = -1;
            return false;
        }

        if (!configurePort_()) {
            close();
            return false;
        }
        return true;
#endif
    }

    void Uart::close()
    {
        std::scoped_lock lock(ioMutex_);
#if defined(_WIN32)
        if (handle_) {
            CloseHandle(static_cast<HANDLE>(handle_));
            handle_ = nullptr;
        }
#else
        if (fd_ >= 0) {
            ::close(fd_);
            fd_ = -1;
        }
#endif
        rxBuffer_.clear();
        lineBuffer_.clear();
    }

    bool Uart::isOpen() const
    {
#if defined(_WIN32)
        return handle_ != nullptr;
#else
        return fd_ >= 0;
#endif
    }

    bool Uart::setTimeouts(int readMs, int writeMs)
    {
        cfg_.readTimeoutMs = std::max(0, readMs);
        cfg_.writeTimeoutMs = std::max(0, writeMs);
        if (!isOpen()) return true;
        return configurePort_();
    }

    bool Uart::configurePort_()
    {
#if defined(_WIN32)
        if (!handle_) return false;
        HANDLE h = static_cast<HANDLE>(handle_);

        DCB dcb{};
        dcb.DCBlength = sizeof(dcb);
        if (!GetCommState(h, &dcb))
            return false;

        dcb.BaudRate = static_cast<DWORD>(cfg_.baudrate);
        dcb.ByteSize = static_cast<BYTE>(cfg_.dataBits);
        dcb.StopBits = (cfg_.stopBits == 2) ? TWOSTOPBITS : ONESTOPBIT;
        dcb.Parity = NOPARITY;
        dcb.fParity = FALSE;
        dcb.fOutxCtsFlow = (cfg_.flow == FlowControl::Hardware);
        dcb.fRtsControl = (cfg_.flow == FlowControl::Hardware) ? RTS_CONTROL_HANDSHAKE : RTS_CONTROL_ENABLE;

        switch (cfg_.parity) {
        case Parity::Even:
            dcb.Parity = EVENPARITY;
            dcb.fParity = TRUE;
            break;
        case Parity::Odd:
            dcb.Parity = ODDPARITY;
            dcb.fParity = TRUE;
            break;
        case Parity::None:
        default:
            break;
        }

        if (!SetCommState(h, &dcb))
            return false;

        COMMTIMEOUTS timeouts{};
        timeouts.ReadIntervalTimeout = 0;
        timeouts.ReadTotalTimeoutConstant = static_cast<DWORD>(cfg_.readTimeoutMs);
        timeouts.ReadTotalTimeoutMultiplier = 0;
        timeouts.WriteTotalTimeoutConstant = static_cast<DWORD>(cfg_.writeTimeoutMs);
        timeouts.WriteTotalTimeoutMultiplier = 0;

        if (!SetCommTimeouts(h, &timeouts))
            return false;

        PurgeComm(h, PURGE_RXCLEAR | PURGE_TXCLEAR);
        return true;
#else
        if (fd_ < 0) return false;

        struct termios tty {};
        if (tcgetattr(fd_, &tty) != 0)
            return false;

        speed_t spd = toBaudLinux(cfg_.baudrate);
        if (spd == 0)
            return false;

        // Mode brut 8N1 stable.
        // IMPORTANT : ICANON/ECHO/ECHOE/ISIG appartiennent a c_lflag, pas a c_cflag.
        // Les effacer dans c_cflag corrompt les bits de vitesse et de taille de mot
        // sous Linux (ex: B115200 et CS8), ce qui produit des trames illisibles.
#ifdef __linux__
        cfmakeraw(&tty);
#else
        tty.c_iflag &= ~(BRKINT | ICRNL | INPCK | ISTRIP | IXON | IXOFF | IXANY);
        tty.c_oflag &= ~OPOST;
        tty.c_lflag &= ~(ICANON | ECHO | ECHOE | ISIG);
#endif

        cfsetospeed(&tty, spd);
        cfsetispeed(&tty, spd);

        tty.c_cflag &= ~CSIZE;
        switch (cfg_.dataBits) {
        case 5: tty.c_cflag |= CS5; break;
        case 6: tty.c_cflag |= CS6; break;
        case 7: tty.c_cflag |= CS7; break;
        case 8:
        default:
            tty.c_cflag |= CS8;
            break;
        }

        tty.c_cflag |= CLOCAL | CREAD;
        tty.c_iflag &= ~(IXON | IXOFF | IXANY);
        tty.c_iflag &= ~(IGNBRK | BRKINT | PARMRK | ISTRIP | INLCR | IGNCR | ICRNL);
        tty.c_lflag &= ~(ICANON | ECHO | ECHOE | ISIG);
        tty.c_oflag &= ~OPOST;

        if (cfg_.parity == Parity::None) {
            tty.c_cflag &= ~PARENB;
        }
        else {
            tty.c_cflag |= PARENB;
            if (cfg_.parity == Parity::Odd)
                tty.c_cflag |= PARODD;
            else
                tty.c_cflag &= ~PARODD;
        }

        if (cfg_.stopBits == 2)
            tty.c_cflag |= CSTOPB;
        else
            tty.c_cflag &= ~CSTOPB;

#ifdef CRTSCTS
        if (cfg_.flow == FlowControl::Hardware)
            tty.c_cflag |= CRTSCTS;
        else
            tty.c_cflag &= ~CRTSCTS;
#endif

        tty.c_cc[VMIN] = 0;
        tty.c_cc[VTIME] = 0;

        if (tcsetattr(fd_, TCSANOW, &tty) != 0)
            return false;

        tcflush(fd_, TCIOFLUSH);
        return true;
#endif
    }

    int Uart::bytesAvailable() const
    {
        if (!isOpen()) return -1;

#if defined(_WIN32)
        COMSTAT st{};
        DWORD err = 0;
        if (!ClearCommError(static_cast<HANDLE>(handle_), &err, &st))
            return -1;
        return static_cast<int>(st.cbInQue);
#else
        int n = 0;
        if (ioctl(fd_, FIONREAD, &n) < 0)
            return -1;
        return n;
#endif
    }

    bool Uart::flush()
    {
        if (!isOpen()) return false;

#if defined(_WIN32)
        return PurgeComm(static_cast<HANDLE>(handle_), PURGE_RXCLEAR | PURGE_TXCLEAR) != 0;
#else
        return tcflush(fd_, TCIOFLUSH) == 0;
#endif
    }

    int Uart::writeBytes(const uint8_t* data, size_t size)
    {
        if (!isOpen() || !data || size == 0) return -1;
        std::scoped_lock lock(ioMutex_);

#if defined(_WIN32)
        DWORD written = 0;
        if (!WriteFile(static_cast<HANDLE>(handle_), data, static_cast<DWORD>(size), &written, nullptr))
            return -1;
        return static_cast<int>(written);
#else
        ssize_t ret = ::write(fd_, data, size);
        if (ret < 0)
            return -1;
        return static_cast<int>(ret);
#endif
    }

    int Uart::writeString(const std::string& s)
    {
        return writeBytes(reinterpret_cast<const uint8_t*>(s.data()), s.size());
    }

    int Uart::readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs)
    {
        if (!isOpen() || !buffer || maxSize == 0) return -1;
        if (timeoutMs < 0) timeoutMs = cfg_.readTimeoutMs;
        std::scoped_lock lock(ioMutex_);

#if defined(_WIN32)
        DWORD nRead = 0;
        if (!ReadFile(static_cast<HANDLE>(handle_), buffer, static_cast<DWORD>(maxSize), &nRead, nullptr))
            return -1;
        return static_cast<int>(nRead);
#else
        fd_set set;
        FD_ZERO(&set);
        FD_SET(fd_, &set);

        struct timeval tv {};
        struct timeval* ptv = nullptr;
        if (timeoutMs >= 0) {
            tv.tv_sec = timeoutMs / 1000;
            tv.tv_usec = (timeoutMs % 1000) * 1000;
            ptv = &tv;
        }

        int rv = select(fd_ + 1, &set, nullptr, nullptr, ptv);
        if (rv < 0) return -1;
        if (rv == 0) return 0;

        ssize_t ret = ::read(fd_, buffer, maxSize);
        if (ret < 0) {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return 0;
            return -1;
        }
        return static_cast<int>(ret);
#endif
    }

    int Uart::readOne_(uint8_t& b, int timeoutMs)
    {
        return readBytes(&b, 1, timeoutMs);
    }

    bool Uart::readLine(std::string& outLine, char eol, int timeoutMs, size_t maxLen)
    {
        outLine.clear();
        if (!isOpen()) return false;
        if (timeoutMs < 0) timeoutMs = cfg_.readTimeoutMs;

        // readLine() ne doit pas retourner une trame partielle : le protocole
        // Raspberry/ESP32 est ligne par ligne et le parseur attend une ligne
        // complète. On conserve donc les octets reçus dans lineBuffer_ jusqu'au
        // caractère de fin de ligne.
        uint8_t c = 0;
        while (lineBuffer_.size() < maxLen) {
            int n = readOne_(c, timeoutMs);
            if (n < 0) {
                lineBuffer_.clear();
                return false;
            }
            if (n == 0) {
                return false;
            }
            if (static_cast<char>(c) == eol) {
                outLine = lineBuffer_;
                lineBuffer_.clear();
                return true;
            }
            if (c != '\r') lineBuffer_.push_back(static_cast<char>(c));
        }

        // Ligne trop longue ou désynchronisation : on jette le tampon pour
        // repartir sur la prochaine ligne propre.
        lineBuffer_.clear();
        return false;
    }

    uint8_t Uart::checksum8(const uint8_t* data, size_t size)
    {
        uint8_t chk = 0;
        for (size_t i = 0; i < size; ++i)
            chk ^= data[i];
        return chk;
    }

    bool Uart::sendPacket(uint8_t type, const std::vector<uint8_t>& payload)
    {
        if (!isOpen()) return false;
        if (payload.size() > 0xFFFFu) return false;

        const uint16_t len = static_cast<uint16_t>(payload.size());
        std::vector<uint8_t> frame;
        frame.reserve(payload.size() + 6);

        frame.push_back(0xAA);
        frame.push_back(0x55);
        frame.push_back(type);
        frame.push_back(static_cast<uint8_t>(len & 0xFF));
        frame.push_back(static_cast<uint8_t>((len >> 8) & 0xFF));
        frame.insert(frame.end(), payload.begin(), payload.end());

        const uint8_t chk = checksum8(frame.data() + 2, frame.size() - 2);
        frame.push_back(chk);

        return writeBytes(frame.data(), frame.size()) == static_cast<int>(frame.size());
    }

    bool Uart::receivePacket(Packet& packet, int timeoutMs)
    {
        if (!isOpen()) return false;
        if (timeoutMs < 0) timeoutMs = cfg_.readTimeoutMs;

        uint8_t tmp[64];
        const int n = readBytes(tmp, sizeof(tmp), timeoutMs);
        if (n < 0) return false;
        if (n > 0) rxBuffer_.insert(rxBuffer_.end(), tmp, tmp + n);

        while (rxBuffer_.size() >= 6) {
            auto it = std::search(rxBuffer_.begin(), rxBuffer_.end(),
                std::begin("\xAA\x55"), std::end("\xAA\x55") - 1);

            if (it == rxBuffer_.end()) {
                rxBuffer_.clear();
                return false;
            }

            if (it != rxBuffer_.begin())
                rxBuffer_.erase(rxBuffer_.begin(), it);

            if (rxBuffer_.size() < 6)
                return false;

            const uint8_t type = rxBuffer_[2];
            const uint16_t len = static_cast<uint16_t>(rxBuffer_[3]) |
                (static_cast<uint16_t>(rxBuffer_[4]) << 8);
            const size_t totalSize = static_cast<size_t>(2 + 1 + 2 + len + 1);

            if (rxBuffer_.size() < totalSize)
                return false;

            const uint8_t chk = checksum8(rxBuffer_.data() + 2, 3 + len);
            const uint8_t rxChk = rxBuffer_[5 + len];

            if (chk != rxChk) {
                rxBuffer_.erase(rxBuffer_.begin());
                continue;
            }

            packet.type = type;
            packet.payload.assign(rxBuffer_.begin() + 5, rxBuffer_.begin() + 5 + len);
            rxBuffer_.erase(rxBuffer_.begin(), rxBuffer_.begin() + totalSize);
            return true;
        }

        return false;
    }

} // namespace jc_uart

