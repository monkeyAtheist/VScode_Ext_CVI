#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace jc_ethernet {

    enum class EthernetProtocol {
        TCP,
        UDP
    };

    enum class EthernetMode {
        Client,
        Server
    };

    struct EthernetConfig {
        EthernetProtocol protocol = EthernetProtocol::TCP;
        EthernetMode mode = EthernetMode::Client;

        // Client TCP / destination UDP
        std::string host = "127.0.0.1";
        uint16_t port = 5000;

        // Serveur TCP / bind UDP. Laisser vide pour 0.0.0.0
        std::string bindAddress;

        int readTimeoutMs = 100;
        int writeTimeoutMs = 100;
        int connectTimeoutMs = 2000;
        int listenBacklog = 4;
        bool reuseAddress = true;
        bool tcpNoDelay = true;
    };

    struct Endpoint {
        std::string address;
        uint16_t port = 0;
    };

    class EthernetLink {
    public:
        struct Packet {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        EthernetLink() = default;
        explicit EthernetLink(const EthernetConfig& cfg);
        ~EthernetLink();

        EthernetLink(const EthernetLink&) = delete;
        EthernetLink& operator=(const EthernetLink&) = delete;

        EthernetLink(EthernetLink&& other) noexcept;
        EthernetLink& operator=(EthernetLink&& other) noexcept;

        bool open(const EthernetConfig& cfg);
        void close();
        bool isOpen() const;
        bool hasPeer() const;

        const EthernetConfig& config() const { return cfg_; }
        bool setTimeouts(int readMs, int writeMs);

        // TCP serveur : accepte un client entrant.
        // Pour TCP client / UDP, retourne simplement isOpen().
        bool acceptClient(int timeoutMs = -1);
        void disconnectPeer();

        int writeBytes(const uint8_t* data, size_t size);
        int readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs = -1);
        int writeString(const std::string& s);
        bool readLine(std::string& outLine, char eol = '\n', int timeoutMs = -1, size_t maxLen = 512);

        // UDP uniquement : émission/réception avec endpoint explicite
        int sendTo(const Endpoint& endpoint, const uint8_t* data, size_t size);
        int receiveFrom(Endpoint& endpoint, uint8_t* buffer, size_t maxSize, int timeoutMs = -1);

        // Format de trame cohérent avec l'UART :
        // [0xAA][0x55][TYPE][LEN_L][LEN_H][PAYLOAD...][CHK]
        // CHK = checksum8(TYPE + LEN_L + LEN_H + PAYLOAD)
        bool sendPacket(uint8_t type, const std::vector<uint8_t>& payload);
        bool receivePacket(Packet& packet, int timeoutMs = -1);

        Endpoint localEndpoint() const;
        Endpoint peerEndpoint() const;

        static uint8_t checksum8(const uint8_t* data, size_t size);

    public:
#if defined(_WIN32)
        using socket_handle_t = uintptr_t;
        static constexpr socket_handle_t kInvalidSocket = static_cast<socket_handle_t>(~uintptr_t(0));
#else
        using socket_handle_t = int;
        static constexpr socket_handle_t kInvalidSocket = -1;
#endif

    private:
        EthernetConfig cfg_{};
        mutable std::mutex ioMutex_;
        std::vector<uint8_t> rxBuffer_;

        socket_handle_t socket_ = kInvalidSocket;      // socket principal
        socket_handle_t peerSocket_ = kInvalidSocket;  // client accepté TCP serveur
        bool opened_ = false;

        bool initSockets_();
        void cleanupSockets_();
        void closeSocket_(socket_handle_t& s);
        bool configureSocket_(socket_handle_t s);
        bool connectTcpClient_();
        bool openTcpServer_();
        bool openUdp_();
        socket_handle_t activeSocket_() const;
        int waitReadable_(socket_handle_t s, int timeoutMs) const;
        int waitWritable_(socket_handle_t s, int timeoutMs) const;
        Endpoint endpointFromSockaddr_(const void* sa, size_t salen) const;
        bool sockaddrFromEndpoint_(const Endpoint& ep, void* outSa, size_t& ioLen) const;
        int readOne_(uint8_t& b, int timeoutMs);
    };

} // namespace jc_ethernet


//exemple d'utilisation :
/*
#include "ethernet.h"
#include <iostream>

int main()
{
    jc_ethernet::EthernetConfig cfg;
    cfg.protocol = jc_ethernet::EthernetProtocol::TCP;
    cfg.mode = jc_ethernet::EthernetMode::Client;
    cfg.host = "192.168.1.50";
    cfg.port = 5000;

    jc_ethernet::EthernetLink eth;
    if (!eth.open(cfg)) {
        std::cerr << "Impossible d'ouvrir la connexion Ethernet\n";
        return -1;
    }

    eth.writeString("PING\n");

    std::string line;
    if (eth.readLine(line)) {
        std::cout << "Recu: " << line << "\n";
    }

    eth.sendPacket(0x10, {0x01, 0x02, 0x03});
    return 0;
}
*/