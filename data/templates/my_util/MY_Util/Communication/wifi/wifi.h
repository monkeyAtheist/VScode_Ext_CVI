#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace jc_wifi {

    enum class WifiProtocol {
        TCP,
        UDP
    };

    enum class WifiMode {
        Client,
        Server
    };

    struct WifiConfig {
        WifiProtocol protocol = WifiProtocol::TCP;
        WifiMode mode = WifiMode::Client;

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

    class WifiLink {
    public:
        struct Packet {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        WifiLink() = default;
        explicit WifiLink(const WifiConfig& cfg);
        ~WifiLink();

        WifiLink(const WifiLink&) = delete;
        WifiLink& operator=(const WifiLink&) = delete;

        WifiLink(WifiLink&& other) noexcept;
        WifiLink& operator=(WifiLink&& other) noexcept;

        bool open(const WifiConfig& cfg);
        void close();
        bool isOpen() const;
        bool hasPeer() const;

        const WifiConfig& config() const { return cfg_; }
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
        WifiConfig cfg_{};
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

} // namespace jc_wifi


//exemple TCP Client
/*
#include "wifi.h"
#include <iostream>

int main()
{
    jc_wifi::WifiConfig cfg;
    cfg.protocol = jc_wifi::WifiProtocol::TCP;
    cfg.mode = jc_wifi::WifiMode::Client;
    cfg.host = "192.168.1.42";
    cfg.port = 5000;

    jc_wifi::WifiLink wifi;
    if (!wifi.open(cfg)) {
        std::cerr << "Impossible d'ouvrir la connexion TCP\n";
        return -1;
    }

    wifi.writeString("PING\n");

    std::string line;
    if (wifi.readLine(line)) {
        std::cout << "Recu: " << line << "\n";
    }

    wifi.sendPacket(0x10, {0x01, 0x02, 0x03});
    return 0;
}
*/

//exemple TCP serveur
/*
#include "wifi.h"
#include <iostream>

int main()
{
    jc_wifi::WifiConfig cfg;
    cfg.protocol = jc_wifi::WifiProtocol::TCP;
    cfg.mode = jc_wifi::WifiMode::Server;
    cfg.port = 5000;
    cfg.bindAddress = "0.0.0.0";

    jc_wifi::WifiLink wifi;
    if (!wifi.open(cfg)) {
        std::cerr << "Impossible de lancer le serveur\n";
        return -1;
    }

    std::cout << "Serveur en attente...\n";
    if (!wifi.acceptClient(5000)) {
        std::cerr << "Aucun client connecte\n";
        return -1;
    }

    std::string line;
    if (wifi.readLine(line)) {
        std::cout << "Client: " << line << "\n";
        wifi.writeString("PONG\n");
    }

    return 0;
}
*/
