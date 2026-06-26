#pragma once

#include <cstdint>
#include <string>
#include <vector>
#include <mutex>

namespace jc_uart {

    enum class Parity {
        None,
        Even,
        Odd
    };

    enum class FlowControl {
        None,
        Hardware
    };

    struct UartConfig {
        std::string port;          
        int baudrate = 115200;
        int dataBits = 8;
        int stopBits = 1;
        Parity parity = Parity::None;
        FlowControl flow = FlowControl::None;
        int readTimeoutMs = 50;
        int writeTimeoutMs = 50;
    };

    class Uart {
    public:
        struct Packet {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        Uart() = default;
        explicit Uart(const UartConfig& cfg);
        ~Uart();

        Uart(const Uart&) = delete;
        Uart& operator=(const Uart&) = delete;

        Uart(Uart&& other) noexcept;
        Uart& operator=(Uart&& other) noexcept;

        bool open(const UartConfig& cfg);
        void close();
        bool isOpen() const;

        const UartConfig& config() const { return cfg_; }
        bool setTimeouts(int readMs, int writeMs);
        int bytesAvailable() const;
        bool flush();

        int writeBytes(const uint8_t* data, size_t size);
        int writeString(const std::string& s);
        int readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs = -1);
        bool readLine(std::string& outLine, char eol = '\n', int timeoutMs = -1, size_t maxLen = 256);

        // Format de trame simple:
        // [0xAA][0x55][TYPE][LEN_L][LEN_H][PAYLOAD...][CHK]
        // CHK = checksum8(TYPE + LEN_L + LEN_H + PAYLOAD)
        bool sendPacket(uint8_t type, const std::vector<uint8_t>& payload);
        bool receivePacket(Packet& packet, int timeoutMs = -1);

        static uint8_t checksum8(const uint8_t* data, size_t size);

    private:
#if defined(_WIN32)
        void* handle_ = nullptr;
#else
        int fd_ = -1;
#endif
        UartConfig cfg_{};
        mutable std::mutex ioMutex_;
        std::vector<uint8_t> rxBuffer_;
        std::string lineBuffer_; // tampon persistant pour readLine()

        bool configurePort_();
        int readOne_(uint8_t& b, int timeoutMs);
    };

} // namespace jc_uart



// Exemple d'utilisation :
/*
#include "uart.h"
#include <iostream>

int main()
{
    jc_uart::UartConfig cfg;
    cfg.port = "/dev/serial0";   // ou COM3 sous Windows
    cfg.baudrate = 115200;
    cfg.readTimeoutMs = 100;

    jc_uart::Uart uart;
    if (!uart.open(cfg)) {
        std::cerr << "Impossible d'ouvrir l'UART\n";
        return -1;
    }

    // Mode texte
    uart.writeString("PING\n");

    std::string line;
    if (uart.readLine(line)) {
        std::cout << "Recu: " << line << "\n";
    }

    // Mode paquet
    uart.sendPacket(0x10, {0x01, 0x02, 0x03});

    jc_uart::Uart::Packet pkt;
    if (uart.receivePacket(pkt, 100)) {
        std::cout << "Type: " << int(pkt.type)
                  << " | taille payload: " << pkt.payload.size() << "\n";
    }

    uart.close();
    return 0;
}
*/