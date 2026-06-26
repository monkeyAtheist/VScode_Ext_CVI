#include "I2C.h"

#include <algorithm>
#include <cstring>

#if defined(_WIN32)
#define NOMINMAX
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <linux/i2c-dev.h>
#include <linux/i2c.h>
#include <sys/ioctl.h>
#include <unistd.h>
#endif

namespace jc_i2c {

    I2cDevice::I2cDevice(const I2cConfig& cfg)
    {
        open(cfg);
    }

    I2cDevice::~I2cDevice()
    {
        close();
    }

    I2cDevice::I2cDevice(I2cDevice&& other) noexcept
    {
        *this = std::move(other);
    }

    I2cDevice& I2cDevice::operator=(I2cDevice&& other) noexcept
    {
        if (this == &other)
            return *this;

        close();

        std::scoped_lock lock(other.ioMutex_);
        cfg_ = other.cfg_;
#if defined(_WIN32)
        handle_ = other.handle_;
        other.handle_ = nullptr;
#else
        fd_ = other.fd_;
        other.fd_ = -1;
#endif
        return *this;
    }

    bool I2cDevice::open(const I2cConfig& cfg)
    {
        close();
        cfg_ = cfg;

#if defined(_WIN32)
        handle_ = nullptr;
        return false;
#else
        fd_ = ::open(cfg.device.c_str(), O_RDWR);
        if (fd_ < 0) {
            fd_ = -1;
            return false;
        }

        if (!configure_()) {
            close();
            return false;
        }

        return true;
#endif
    }

    void I2cDevice::close()
    {
        std::scoped_lock lock(ioMutex_);
#if defined(_WIN32)
        handle_ = nullptr;
#else
        if (fd_ >= 0) {
            ::close(fd_);
            fd_ = -1;
        }
#endif
    }

    bool I2cDevice::isOpen() const
    {
#if defined(_WIN32)
        return handle_ != nullptr;
#else
        return fd_ >= 0;
#endif
    }

    bool I2cDevice::configure_()
    {
#if defined(_WIN32)
        return false;
#else
        if (fd_ < 0)
            return false;

#ifdef I2C_TIMEOUT
        const int timeout10ms = std::max(0, cfg_.timeoutMs + 9) / 10;
        (void)::ioctl(fd_, I2C_TIMEOUT, timeout10ms);
#endif

#ifdef I2C_RETRIES
        (void)::ioctl(fd_, I2C_RETRIES, std::max(0, cfg_.retries));
#endif

        return setSlaveAddress(cfg_.slaveAddress, cfg_.tenBitAddress);
#endif
    }

    bool I2cDevice::setSlaveAddress(uint16_t address, bool tenBit)
    {
        cfg_.slaveAddress = address;
        cfg_.tenBitAddress = tenBit;

#if defined(_WIN32)
        return false;
#else
        if (fd_ < 0)
            return false;

#ifdef I2C_TENBIT
        if (::ioctl(fd_, I2C_TENBIT, tenBit ? 1 : 0) < 0)
            return false;
#endif

        if (::ioctl(fd_, I2C_SLAVE, static_cast<unsigned long>(address)) < 0)
            return false;

        return true;
#endif
    }

    bool I2cDevice::setRetries(int retries)
    {
        cfg_.retries = std::max(0, retries);
#if defined(_WIN32)
        return false;
#else
        if (fd_ < 0)
            return true;
#ifdef I2C_RETRIES
        return ::ioctl(fd_, I2C_RETRIES, cfg_.retries) >= 0;
#else
        return true;
#endif
#endif
    }

    bool I2cDevice::setTimeoutMs(int timeoutMs)
    {
        cfg_.timeoutMs = std::max(0, timeoutMs);
#if defined(_WIN32)
        return false;
#else
        if (fd_ < 0)
            return true;
#ifdef I2C_TIMEOUT
        const int timeout10ms = (cfg_.timeoutMs + 9) / 10;
        return ::ioctl(fd_, I2C_TIMEOUT, timeout10ms) >= 0;
#else
        return true;
#endif
#endif
    }

    int I2cDevice::writeBytes(const uint8_t* data, size_t size)
    {
        if (!isOpen() || !data || size == 0)
            return -1;

        std::scoped_lock lock(ioMutex_);

#if defined(_WIN32)
        return -1;
#else
        const ssize_t ret = ::write(fd_, data, size);
        if (ret < 0)
            return -1;
        return static_cast<int>(ret);
#endif
    }

    int I2cDevice::readBytes(uint8_t* data, size_t size)
    {
        if (!isOpen() || !data || size == 0)
            return -1;

        std::scoped_lock lock(ioMutex_);

#if defined(_WIN32)
        return -1;
#else
        const ssize_t ret = ::read(fd_, data, size);
        if (ret < 0)
            return -1;
        return static_cast<int>(ret);
#endif
    }

    bool I2cDevice::writeThenRead(const uint8_t* txData, size_t txSize,
        uint8_t* rxData, size_t rxSize)
    {
        if (!isOpen())
            return false;
        if ((txSize > 0 && txData == nullptr) || (rxSize > 0 && rxData == nullptr))
            return false;

#if defined(_WIN32)
        return false;
#else
        std::scoped_lock lock(ioMutex_);

        struct i2c_msg msgs[2]{};
        int nMsgs = 0;

        if (txSize > 0) {
            msgs[nMsgs].addr = cfg_.slaveAddress;
            msgs[nMsgs].flags = 0;
            msgs[nMsgs].len = static_cast<__u16>(txSize);
            msgs[nMsgs].buf = const_cast<__u8*>(reinterpret_cast<const __u8*>(txData));
            ++nMsgs;
        }

        if (rxSize > 0) {
            msgs[nMsgs].addr = cfg_.slaveAddress;
            msgs[nMsgs].flags = I2C_M_RD;
            msgs[nMsgs].len = static_cast<__u16>(rxSize);
            msgs[nMsgs].buf = reinterpret_cast<__u8*>(rxData);
            ++nMsgs;
        }

        if (nMsgs == 0)
            return false;

        struct i2c_rdwr_ioctl_data ioctlData {};
        ioctlData.msgs = msgs;
        ioctlData.nmsgs = nMsgs;

        return ::ioctl(fd_, I2C_RDWR, &ioctlData) >= 0;
#endif
    }

    bool I2cDevice::writeRegister8(uint8_t reg, uint8_t value)
    {
        const uint8_t buffer[2] = { reg, value };
        return writeBytes(buffer, sizeof(buffer)) == static_cast<int>(sizeof(buffer));
    }

    bool I2cDevice::writeRegister16(uint8_t reg, uint16_t value, bool lsbFirst)
    {
        uint8_t buffer[3]{};
        buffer[0] = reg;
        if (lsbFirst) {
            buffer[1] = static_cast<uint8_t>(value & 0xFFu);
            buffer[2] = static_cast<uint8_t>((value >> 8) & 0xFFu);
        }
        else {
            buffer[1] = static_cast<uint8_t>((value >> 8) & 0xFFu);
            buffer[2] = static_cast<uint8_t>(value & 0xFFu);
        }
        return writeBytes(buffer, sizeof(buffer)) == static_cast<int>(sizeof(buffer));
    }

    bool I2cDevice::readRegister8(uint8_t reg, uint8_t& value)
    {
        return writeThenRead(&reg, 1, &value, 1);
    }

    bool I2cDevice::readRegister16(uint8_t reg, uint16_t& value, bool lsbFirst)
    {
        uint8_t buffer[2]{};
        if (!writeThenRead(&reg, 1, buffer, sizeof(buffer)))
            return false;

        if (lsbFirst)
            value = static_cast<uint16_t>(buffer[0]) |
            (static_cast<uint16_t>(buffer[1]) << 8);
        else
            value = (static_cast<uint16_t>(buffer[0]) << 8) |
            static_cast<uint16_t>(buffer[1]);

        return true;
    }

    bool I2cDevice::writeBlock(uint8_t reg, const std::vector<uint8_t>& data)
    {
        if (data.empty())
            return writeBytes(&reg, 1) == 1;

        std::vector<uint8_t> buffer;
        buffer.reserve(1 + data.size());
        buffer.push_back(reg);
        buffer.insert(buffer.end(), data.begin(), data.end());

        return writeBytes(buffer.data(), buffer.size()) == static_cast<int>(buffer.size());
    }

    bool I2cDevice::readBlock(uint8_t reg, std::vector<uint8_t>& data, size_t size)
    {
        data.assign(size, 0);
        if (size == 0)
            return true;

        return writeThenRead(&reg, 1, data.data(), data.size());
    }

    uint8_t I2cDevice::checksum8(const uint8_t* data, size_t size)
    {
        uint8_t chk = 0;
        for (size_t i = 0; i < size; ++i)
            chk ^= data[i];
        return chk;
    }

    bool I2cDevice::sendFrame(uint8_t type, const std::vector<uint8_t>& payload)
    {
        if (!isOpen())
            return false;
        if (payload.size() > 255u)
            return false;

        std::vector<uint8_t> frame;
        frame.reserve(payload.size() + 3);
        frame.push_back(type);
        frame.push_back(static_cast<uint8_t>(payload.size()));
        frame.insert(frame.end(), payload.begin(), payload.end());
        frame.push_back(checksum8(frame.data(), frame.size()));

        return writeBytes(frame.data(), frame.size()) == static_cast<int>(frame.size());
    }

    bool I2cDevice::readFrame(Frame& frame, size_t maxPayload)
    {
        if (!isOpen())
            return false;

        uint8_t header[2]{};
        if (readBytes(header, sizeof(header)) != static_cast<int>(sizeof(header)))
            return false;

        const uint8_t type = header[0];
        const uint8_t len = header[1];
        if (len > maxPayload)
            return false;

        std::vector<uint8_t> buffer(static_cast<size_t>(len) + 1u, 0);
        if (readBytes(buffer.data(), buffer.size()) != static_cast<int>(buffer.size()))
            return false;

        std::vector<uint8_t> check;
        check.reserve(2 + len);
        check.push_back(type);
        check.push_back(len);
        check.insert(check.end(), buffer.begin(), buffer.begin() + len);

        const uint8_t chk = checksum8(check.data(), check.size());
        const uint8_t rxChk = buffer[len];
        if (chk != rxChk)
            return false;

        frame.type = type;
        frame.payload.assign(buffer.begin(), buffer.begin() + len);
        return true;
    }

} // namespace jc_i2c

