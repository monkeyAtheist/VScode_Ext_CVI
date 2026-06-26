#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace jc_i2c {

    struct I2cConfig {
        std::string device = "/dev/i2c-1"; // Raspberry Pi: bus I2C principal
        uint16_t slaveAddress = 0x00;       // adresse 7 bits par defaut
        bool tenBitAddress = false;
        int retries = 1;                    // nb de tentatives kernel
        int timeoutMs = 50;                 // timeout approx. Linux (granularite 10 ms)
    };

    class I2cDevice {
    public:
        struct Frame {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        I2cDevice() = default;
        explicit I2cDevice(const I2cConfig& cfg);
        ~I2cDevice();

        I2cDevice(const I2cDevice&) = delete;
        I2cDevice& operator=(const I2cDevice&) = delete;

        I2cDevice(I2cDevice&& other) noexcept;
        I2cDevice& operator=(I2cDevice&& other) noexcept;

        bool open(const I2cConfig& cfg);
        void close();
        bool isOpen() const;

        const I2cConfig& config() const { return cfg_; }

        bool setSlaveAddress(uint16_t address, bool tenBit = false);
        bool setRetries(int retries);
        bool setTimeoutMs(int timeoutMs);

        int writeBytes(const uint8_t* data, size_t size);
        int readBytes(uint8_t* data, size_t size);

        bool writeThenRead(const uint8_t* txData, size_t txSize,
            uint8_t* rxData, size_t rxSize);

        bool writeRegister8(uint8_t reg, uint8_t value);
        bool writeRegister16(uint8_t reg, uint16_t value, bool lsbFirst = false);
        bool readRegister8(uint8_t reg, uint8_t& value);
        bool readRegister16(uint8_t reg, uint16_t& value, bool lsbFirst = false);

        bool writeBlock(uint8_t reg, const std::vector<uint8_t>& data);
        bool readBlock(uint8_t reg, std::vector<uint8_t>& data, size_t size);

        // Protocole applicatif optionnel pour un esclave I2C custom:
        // [TYPE][LEN][PAYLOAD...][CHK]
        // CHK = XOR(TYPE, LEN, PAYLOAD...)
        bool sendFrame(uint8_t type, const std::vector<uint8_t>& payload);
        bool readFrame(Frame& frame, size_t maxPayload = 255);

        static uint8_t checksum8(const uint8_t* data, size_t size);

    private:
#if defined(_WIN32)
        void* handle_ = nullptr; // stub Windows: I2C non implemente generiquement ici
#else
        int fd_ = -1;
#endif
        I2cConfig cfg_{};
        mutable std::mutex ioMutex_;

        bool configure_();
    };

} // namespace jc_i2c


//exemple d'utilisation
/*
#include "I2C.h"
#include <iostream>

int main()
{
    jc_i2c::I2cConfig cfg;
    cfg.device = "/dev/i2c-1";
    cfg.slaveAddress = 0x42;
    cfg.timeoutMs = 50;

    jc_i2c::I2cDevice i2c;
    if (!i2c.open(cfg)) {
        std::cerr << "Impossible d'ouvrir le bus I2C\n";
        return -1;
    }

    // Ecriture d'un registre
    i2c.writeRegister8(0x01, 0x7F);

    // Lecture d'un registre
    uint8_t value = 0;
    if (i2c.readRegister8(0x02, value)) {
        std::cout << "Valeur lue: " << int(value) << "\n";
    }

    // Envoi d'une trame custom
    i2c.sendFrame(0x10, {0x01, 0x02, 0x03});

    return 0;
}
*/
