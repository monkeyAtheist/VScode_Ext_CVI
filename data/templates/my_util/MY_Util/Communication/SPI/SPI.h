#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace jc_spi {

    struct SpiConfig {
        // Sous Linux / Raspberry Pi : /dev/spidev0.0, /dev/spidev0.1, ...
        std::string device = "/dev/spidev0.0";

        // Paramètres SPI classiques
        uint32_t speedHz = 1000000;   // 1 MHz
        uint8_t mode = 0;             // SPI mode 0..3
        uint8_t bitsPerWord = 8;
        bool lsbFirst = false;

        // Options de transfert
        bool csChange = false;        // Demande au driver de relâcher / modifier le CS après transfert
        uint16_t delayUsec = 0;       // Délai entre messages SPI
        uint8_t dummyByte = 0xFF;     // Octet envoyé lors des lectures pures

        // Convention utilisée par les helpers de registres 16 bits
        bool registerMsbFirst = true;
    };

    class SpiDevice {
    public:
        struct Packet {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        SpiDevice() = default;
        explicit SpiDevice(const SpiConfig& cfg);
        ~SpiDevice();

        SpiDevice(const SpiDevice&) = delete;
        SpiDevice& operator=(const SpiDevice&) = delete;

        SpiDevice(SpiDevice&& other) noexcept;
        SpiDevice& operator=(SpiDevice&& other) noexcept;

        bool open(const SpiConfig& cfg);
        void close();
        bool isOpen() const;

        const SpiConfig& config() const { return cfg_; }

        bool setMode(uint8_t mode);
        bool setSpeedHz(uint32_t speedHz);
        bool setBitsPerWord(uint8_t bitsPerWord);
        bool setBitOrder(bool lsbFirst);

        // Transfert SPI full-duplex bas niveau
        int transfer(const uint8_t* txData, uint8_t* rxData, size_t size);
        bool transfer(const std::vector<uint8_t>& txData, std::vector<uint8_t>& rxData);
        bool transferInPlace(std::vector<uint8_t>& data);

        // Helpers usuels
        int writeBytes(const uint8_t* data, size_t size);
        int writeBytes(const std::vector<uint8_t>& data);
        int readBytes(uint8_t* data, size_t size, uint8_t fillByte = 0xFF);
        bool readBytes(std::vector<uint8_t>& data, size_t size, uint8_t fillByte = 0xFF);

        // Helpers registre génériques.
        // Important : la sémantique exacte du bit de lecture/écriture dépend du composant SPI.
        // Ici, le byte / mot de registre est envoyé tel quel.
        bool writeRegister8(uint8_t reg, uint8_t value);
        bool readRegister8(uint8_t reg, uint8_t& value, uint8_t fillByte = 0xFF);
        bool writeRegister16(uint16_t reg, uint8_t value);
        bool readRegister16(uint16_t reg, uint8_t& value, uint8_t fillByte = 0xFF);

        bool writeRegisterBlock8(uint8_t reg, const std::vector<uint8_t>& data);
        bool readRegisterBlock8(uint8_t reg, std::vector<uint8_t>& data, size_t size, uint8_t fillByte = 0xFF);
        bool writeRegisterBlock16(uint16_t reg, const std::vector<uint8_t>& data);
        bool readRegisterBlock16(uint16_t reg, std::vector<uint8_t>& data, size_t size, uint8_t fillByte = 0xFF);

        // Petit protocole de trame cohérent avec UART / Wi-Fi / Bluetooth.
        // [0xAA][0x55][TYPE][LEN_L][LEN_H][PAYLOAD...][CHK]
        // CHK = checksum8(TYPE + LEN_L + LEN_H + PAYLOAD)
        bool sendPacket(uint8_t type, const std::vector<uint8_t>& payload);

        // En SPI, le maître doit générer l'horloge pour recevoir des données.
        // Cette fonction envoie fillByte tant qu'elle cherche une trame valide.
        bool receivePacket(Packet& packet,
            size_t maxSearchBytes = 4096,
            size_t maxPayloadSize = 1024,
            uint8_t fillByte = 0xFF);

        static uint8_t checksum8(const uint8_t* data, size_t size);

    private:
        using handle_t = int;
        static constexpr handle_t kInvalidHandle = -1;

        SpiConfig cfg_{};
        handle_t fd_ = kInvalidHandle;
        mutable std::mutex ioMutex_;
        std::vector<uint8_t> rxBuffer_;

        bool applyConfig_();
        bool readOne_(uint8_t& b, uint8_t fillByte);
        std::vector<uint8_t> regToBytes16_(uint16_t reg) const;
    };

} // namespace jc_spi


//exemple d'utilisation
/*
#include "SPI.h"
#include <iostream>
#include <vector>

int main()
{
    jc_spi::SpiConfig cfg;
    cfg.device = "/dev/spidev0.0";
    cfg.speedHz = 1000000;
    cfg.mode = 0;
    cfg.bitsPerWord = 8;

    jc_spi::SpiDevice spi;
    if (!spi.open(cfg)) {
        std::cerr << "Impossible d'ouvrir le SPI\n";
        return -1;
    }

    // Transfert simple
    std::vector<uint8_t> tx = {0x9F, 0x00, 0x00, 0x00};
    std::vector<uint8_t> rx;
    if (spi.transfer(tx, rx)) {
        std::cout << "Recu " << rx.size() << " octets\n";
    }

    // Ecriture d'un registre 8 bits
    spi.writeRegister8(0x10, 0x55);

    // Lecture d'un registre 8 bits
    uint8_t value = 0;
    if (spi.readRegister8(0x10, value)) {
        std::cout << "Valeur lue = " << static_cast<int>(value) << "\n";
    }

    // Envoi d'une trame
    spi.sendPacket(0x20, {0x01, 0x02, 0x03});

    return 0;
}
*/