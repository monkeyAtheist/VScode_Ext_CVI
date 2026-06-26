#include "SPI.h"

#include <algorithm>
#include <array>
#include <cstring>

#if defined(__linux__) && __has_include(<linux/spi/spidev.h>)
#define jc_SPI_LINUX_AVAILABLE 1
#include <cerrno>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#include <linux/spi/spidev.h>
#else
#define jc_SPI_LINUX_AVAILABLE 0
#endif

namespace jc_spi {

    namespace {
        constexpr uint8_t kSync0 = 0xAA;
        constexpr uint8_t kSync1 = 0x55;

        template <typename T>
        void appendValueLE(std::vector<uint8_t>& out, T value)
        {
            for (size_t i = 0; i < sizeof(T); ++i)
                out.push_back(static_cast<uint8_t>((value >> (8 * i)) & 0xFF));
        }
    }

    SpiDevice::SpiDevice(const SpiConfig& cfg)
    {
        open(cfg);
    }

    SpiDevice::~SpiDevice()
    {
        close();
    }

    SpiDevice::SpiDevice(SpiDevice&& other) noexcept
    {
        *this = std::move(other);
    }

    SpiDevice& SpiDevice::operator=(SpiDevice&& other) noexcept
    {
        if (this == &other)
            return *this;

        close();

        std::scoped_lock lock(other.ioMutex_);
        cfg_ = other.cfg_;
        fd_ = other.fd_;
        rxBuffer_ = std::move(other.rxBuffer_);

        other.fd_ = kInvalidHandle;

        return *this;
    }

    bool SpiDevice::open(const SpiConfig& cfg)
    {
        close();
        cfg_ = cfg;

#if jc_SPI_LINUX_AVAILABLE
        fd_ = ::open(cfg_.device.c_str(), O_RDWR);
        if (fd_ < 0) {
            fd_ = kInvalidHandle;
            return false;
        }

        if (!applyConfig_()) {
            close();
            return false;
        }

        rxBuffer_.clear();
        return true;
#else
        return false;
#endif
    }

    void SpiDevice::close()
    {
        std::scoped_lock lock(ioMutex_);
#if jc_SPI_LINUX_AVAILABLE
        if (fd_ != kInvalidHandle)
            ::close(fd_);
#endif
        fd_ = kInvalidHandle;
        rxBuffer_.clear();
    }

    bool SpiDevice::isOpen() const
    {
        return fd_ != kInvalidHandle;
    }

    bool SpiDevice::applyConfig_()
    {
#if jc_SPI_LINUX_AVAILABLE
        if (!isOpen())
            return false;

        uint8_t mode = static_cast<uint8_t>(cfg_.mode & 0x03u);
        uint8_t lsb = static_cast<uint8_t>(cfg_.lsbFirst ? 1 : 0);
        uint8_t bits = cfg_.bitsPerWord;
        uint32_t speed = cfg_.speedHz;

        if (::ioctl(fd_, SPI_IOC_WR_MODE, &mode) < 0)
            return false;
        if (::ioctl(fd_, SPI_IOC_RD_MODE, &mode) < 0)
            return false;

        if (::ioctl(fd_, SPI_IOC_WR_LSB_FIRST, &lsb) < 0)
            return false;
        if (::ioctl(fd_, SPI_IOC_RD_LSB_FIRST, &lsb) < 0)
            return false;

        if (::ioctl(fd_, SPI_IOC_WR_BITS_PER_WORD, &bits) < 0)
            return false;
        if (::ioctl(fd_, SPI_IOC_RD_BITS_PER_WORD, &bits) < 0)
            return false;

        if (::ioctl(fd_, SPI_IOC_WR_MAX_SPEED_HZ, &speed) < 0)
            return false;
        if (::ioctl(fd_, SPI_IOC_RD_MAX_SPEED_HZ, &speed) < 0)
            return false;

        return true;
#else
        return false;
#endif
    }

    bool SpiDevice::setMode(uint8_t mode)
    {
        cfg_.mode = static_cast<uint8_t>(mode & 0x03u);
        return isOpen() ? applyConfig_() : true;
    }

    bool SpiDevice::setSpeedHz(uint32_t speedHz)
    {
        cfg_.speedHz = speedHz;
        return isOpen() ? applyConfig_() : true;
    }

    bool SpiDevice::setBitsPerWord(uint8_t bitsPerWord)
    {
        cfg_.bitsPerWord = bitsPerWord;
        return isOpen() ? applyConfig_() : true;
    }

    bool SpiDevice::setBitOrder(bool lsbFirst)
    {
        cfg_.lsbFirst = lsbFirst;
        return isOpen() ? applyConfig_() : true;
    }

    int SpiDevice::transfer(const uint8_t* txData, uint8_t* rxData, size_t size)
    {
        if (!isOpen())
            return -1;
        if (size == 0)
            return 0;

#if jc_SPI_LINUX_AVAILABLE
        std::scoped_lock lock(ioMutex_);

        spi_ioc_transfer tr{};
        tr.tx_buf = reinterpret_cast<unsigned long long>(txData);
        tr.rx_buf = reinterpret_cast<unsigned long long>(rxData);
        tr.len = static_cast<decltype(tr.len)>(size);
        tr.delay_usecs = cfg_.delayUsec;
        tr.speed_hz = cfg_.speedHz;
        tr.bits_per_word = cfg_.bitsPerWord;
        tr.cs_change = static_cast<uint8_t>(cfg_.csChange ? 1 : 0);

        return ::ioctl(fd_, SPI_IOC_MESSAGE(1), &tr);
#else
        (void)txData;
        (void)rxData;
        (void)size;
        return -1;
#endif
    }

    bool SpiDevice::transfer(const std::vector<uint8_t>& txData, std::vector<uint8_t>& rxData)
    {
        rxData.assign(txData.size(), 0);
        const int rc = transfer(txData.empty() ? nullptr : txData.data(), rxData.empty() ? nullptr : rxData.data(), txData.size());
        return rc >= 0;
    }

    bool SpiDevice::transferInPlace(std::vector<uint8_t>& data)
    {
        std::vector<uint8_t> rx;
        if (!transfer(data, rx))
            return false;
        data = std::move(rx);
        return true;
    }

    int SpiDevice::writeBytes(const uint8_t* data, size_t size)
    {
        if (size == 0)
            return 0;
        std::vector<uint8_t> rx(size, 0);
        return transfer(data, rx.data(), size);
    }

    int SpiDevice::writeBytes(const std::vector<uint8_t>& data)
    {
        return writeBytes(data.empty() ? nullptr : data.data(), data.size());
    }

    int SpiDevice::readBytes(uint8_t* data, size_t size, uint8_t fillByte)
    {
        if (size == 0)
            return 0;
        std::vector<uint8_t> tx(size, fillByte);
        return transfer(tx.data(), data, size);
    }

    bool SpiDevice::readBytes(std::vector<uint8_t>& data, size_t size, uint8_t fillByte)
    {
        data.assign(size, 0);
        return readBytes(data.data(), size, fillByte) >= 0;
    }

    std::vector<uint8_t> SpiDevice::regToBytes16_(uint16_t reg) const
    {
        if (cfg_.registerMsbFirst) {
            return {
                static_cast<uint8_t>((reg >> 8) & 0xFF),
                static_cast<uint8_t>(reg & 0xFF)
            };
        }
        return {
            static_cast<uint8_t>(reg & 0xFF),
            static_cast<uint8_t>((reg >> 8) & 0xFF)
        };
    }

    bool SpiDevice::writeRegister8(uint8_t reg, uint8_t value)
    {
        return writeRegisterBlock8(reg, { value });
    }

    bool SpiDevice::readRegister8(uint8_t reg, uint8_t& value, uint8_t fillByte)
    {
        std::vector<uint8_t> data;
        if (!readRegisterBlock8(reg, data, 1, fillByte) || data.empty())
            return false;
        value = data[0];
        return true;
    }

    bool SpiDevice::writeRegister16(uint16_t reg, uint8_t value)
    {
        return writeRegisterBlock16(reg, { value });
    }

    bool SpiDevice::readRegister16(uint16_t reg, uint8_t& value, uint8_t fillByte)
    {
        std::vector<uint8_t> data;
        if (!readRegisterBlock16(reg, data, 1, fillByte) || data.empty())
            return false;
        value = data[0];
        return true;
    }

    bool SpiDevice::writeRegisterBlock8(uint8_t reg, const std::vector<uint8_t>& data)
    {
        std::vector<uint8_t> tx;
        tx.reserve(1 + data.size());
        tx.push_back(reg);
        tx.insert(tx.end(), data.begin(), data.end());
        return writeBytes(tx) >= 0;
    }

    bool SpiDevice::readRegisterBlock8(uint8_t reg, std::vector<uint8_t>& data, size_t size, uint8_t fillByte)
    {
        std::vector<uint8_t> tx(1 + size, fillByte);
        tx[0] = reg;

        std::vector<uint8_t> rx;
        if (!transfer(tx, rx) || rx.size() < (1 + size))
            return false;

        data.assign(rx.begin() + 1, rx.end());
        return true;
    }

    bool SpiDevice::writeRegisterBlock16(uint16_t reg, const std::vector<uint8_t>& data)
    {
        std::vector<uint8_t> tx = regToBytes16_(reg);
        tx.insert(tx.end(), data.begin(), data.end());
        return writeBytes(tx) >= 0;
    }

    bool SpiDevice::readRegisterBlock16(uint16_t reg, std::vector<uint8_t>& data, size_t size, uint8_t fillByte)
    {
        std::vector<uint8_t> tx = regToBytes16_(reg);
        tx.resize(tx.size() + size, fillByte);

        std::vector<uint8_t> rx;
        if (!transfer(tx, rx) || rx.size() < tx.size())
            return false;

        const size_t regSize = 2;
        data.assign(rx.begin() + regSize, rx.end());
        return true;
    }

    uint8_t SpiDevice::checksum8(const uint8_t* data, size_t size)
    {
        uint8_t chk = 0;
        for (size_t i = 0; i < size; ++i)
            chk ^= data[i];
        return chk;
    }

    bool SpiDevice::sendPacket(uint8_t type, const std::vector<uint8_t>& payload)
    {
        if (payload.size() > 0xFFFFu)
            return false;

        std::vector<uint8_t> frame;
        frame.reserve(6 + payload.size());
        frame.push_back(kSync0);
        frame.push_back(kSync1);
        frame.push_back(type);
        appendValueLE<uint16_t>(frame, static_cast<uint16_t>(payload.size()));
        frame.insert(frame.end(), payload.begin(), payload.end());
        frame.push_back(checksum8(frame.data() + 2, 3 + payload.size()));

        return writeBytes(frame) >= 0;
    }

    bool SpiDevice::readOne_(uint8_t& b, uint8_t fillByte)
    {
        return readBytes(&b, 1, fillByte) >= 0;
    }

    bool SpiDevice::receivePacket(Packet& packet,
        size_t maxSearchBytes,
        size_t maxPayloadSize,
        uint8_t fillByte)
    {
        if (!isOpen())
            return false;

        size_t clockedBytes = 0;

        auto fetchBytes = [&](size_t count) -> bool {
            if (count == 0)
                return true;
            std::vector<uint8_t> incoming;
            if (!readBytes(incoming, count, fillByte))
                return false;
            rxBuffer_.insert(rxBuffer_.end(), incoming.begin(), incoming.end());
            clockedBytes += count;
            return true;
            };

        while (clockedBytes < maxSearchBytes) {
            if (rxBuffer_.size() < 2) {
                if (!fetchBytes(1))
                    return false;
                continue;
            }

            const std::array<uint8_t, 2> syncBytes{ {kSync0, kSync1} };
            auto it = std::search(rxBuffer_.begin(), rxBuffer_.end(),
                syncBytes.begin(), syncBytes.end());

            if (it == rxBuffer_.end()) {
                if (!rxBuffer_.empty())
                    rxBuffer_.erase(rxBuffer_.begin(), rxBuffer_.end() - 1);
                if (!fetchBytes(1))
                    return false;
                continue;
            }

            if (it != rxBuffer_.begin())
                rxBuffer_.erase(rxBuffer_.begin(), it);

            while (rxBuffer_.size() < 5) {
                if (clockedBytes >= maxSearchBytes || !fetchBytes(1))
                    return false;
            }

            const uint16_t payloadLen = static_cast<uint16_t>(rxBuffer_[3]) |
                (static_cast<uint16_t>(rxBuffer_[4]) << 8);

            if (payloadLen > maxPayloadSize) {
                rxBuffer_.erase(rxBuffer_.begin());
                continue;
            }

            const size_t totalSize = 2 + 1 + 2 + payloadLen + 1;
            while (rxBuffer_.size() < totalSize) {
                if (clockedBytes >= maxSearchBytes || !fetchBytes(1))
                    return false;
            }

            const uint8_t chk = checksum8(rxBuffer_.data() + 2, 3 + payloadLen);
            if (chk != rxBuffer_[totalSize - 1]) {
                rxBuffer_.erase(rxBuffer_.begin());
                continue;
            }

            packet.type = rxBuffer_[2];
            packet.payload.assign(rxBuffer_.begin() + 5, rxBuffer_.begin() + 5 + payloadLen);
            rxBuffer_.erase(rxBuffer_.begin(), rxBuffer_.begin() + static_cast<std::ptrdiff_t>(totalSize));
            return true;
        }

        return false;
    }

} // namespace jc_spi
