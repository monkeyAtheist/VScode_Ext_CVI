#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace jc_bluetooth {

    enum class BluetoothMode {
        Client,
        Server
    };

    struct BluetoothConfig {
        BluetoothMode mode = BluetoothMode::Client;

        // Mode client : adresse MAC distante, ex: "DC:A6:32:11:22:33"
        std::string remoteAddress;

        // Mode serveur : laisser vide pour écouter sur n'importe quel adaptateur local.
        // Sinon, adresse MAC locale de l'adaptateur Bluetooth.
        std::string localAddress;

        // Canal RFCOMM (équivalent d'un "port" Bluetooth Classic)
        uint8_t channel = 1;

        int readTimeoutMs = 100;
        int writeTimeoutMs = 100;
        int connectTimeoutMs = 4000;
        int listenBacklog = 1;
    };

    class BluetoothLink {
    public:
        struct Packet {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        BluetoothLink() = default;
        explicit BluetoothLink(const BluetoothConfig& cfg);
        ~BluetoothLink();

        BluetoothLink(const BluetoothLink&) = delete;
        BluetoothLink& operator=(const BluetoothLink&) = delete;

        BluetoothLink(BluetoothLink&& other) noexcept;
        BluetoothLink& operator=(BluetoothLink&& other) noexcept;

        bool open(const BluetoothConfig& cfg);
        void close();
        bool isOpen() const;
        bool hasPeer() const;

        const BluetoothConfig& config() const { return cfg_; }
        bool setTimeouts(int readMs, int writeMs);

        // Serveur RFCOMM : accepte un client entrant.
        // En mode client, retourne simplement isOpen().
        bool acceptClient(int timeoutMs = -1);
        void disconnectPeer();

        int writeBytes(const uint8_t* data, size_t size);
        int writeString(const std::string& s);
        int readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs = -1);
        bool readLine(std::string& outLine, char eol = '\n', int timeoutMs = -1, size_t maxLen = 512);

        // Format de trame cohérent avec UART / Wi-Fi :
        // [0xAA][0x55][TYPE][LEN_L][LEN_H][PAYLOAD...][CHK]
        // CHK = checksum8(TYPE + LEN_L + LEN_H + PAYLOAD)
        bool sendPacket(uint8_t type, const std::vector<uint8_t>& payload);
        bool receivePacket(Packet& packet, int timeoutMs = -1);

        std::string localAddress() const;
        std::string peerAddress() const;

        static uint8_t checksum8(const uint8_t* data, size_t size);

    private:
        using socket_handle_t = int;
        static constexpr socket_handle_t kInvalidSocket = -1;

        BluetoothConfig cfg_{};
        mutable std::mutex ioMutex_;
        std::vector<uint8_t> rxBuffer_;

        socket_handle_t socket_ = kInvalidSocket;      // socket principal
        socket_handle_t peerSocket_ = kInvalidSocket;  // client accepté en mode serveur
        bool opened_ = false;

        bool openClient_();
        bool openServer_();
        void closeSocket_(socket_handle_t& s);
        socket_handle_t activeSocket_() const;
        int waitReadable_(socket_handle_t s, int timeoutMs) const;
        int waitWritable_(socket_handle_t s, int timeoutMs) const;
        bool setNonBlocking_(socket_handle_t s, bool enabled) const;
        int readOne_(uint8_t& b, int timeoutMs);
    };

} // namespace jc_bluetooth


//exemple client
/*
#include "bluetooth.h"
#include <iostream>

int main()
{
    jc_bluetooth::BluetoothConfig cfg;
    cfg.mode = jc_bluetooth::BluetoothMode::Client;
    cfg.remoteAddress = "DC:A6:32:11:22:33";
    cfg.channel = 1;

    jc_bluetooth::BluetoothLink bt;
    if (!bt.open(cfg)) {
        std::cerr << "Impossible d'ouvrir la connexion Bluetooth\n";
        return -1;
    }

    bt.writeString("PING\n");

    std::string line;
    if (bt.readLine(line)) {
        std::cout << "Recu: " << line << "\n";
    }

    bt.sendPacket(0x10, {0x01, 0x02, 0x03});
    return 0;
}
*/

//exemple serveur
/*
#include "bluetooth.h"
#include <iostream>

int main()
{
    jc_bluetooth::BluetoothConfig cfg;
    cfg.mode = jc_bluetooth::BluetoothMode::Server;
    cfg.channel = 1;

    jc_bluetooth::BluetoothLink bt;
    if (!bt.open(cfg)) {
        std::cerr << "Impossible de lancer le serveur Bluetooth\n";
        return -1;
    }

    std::cout << "En attente d'un client...\n";
    if (!bt.acceptClient(5000)) {
        std::cerr << "Aucun client connecte\n";
        return -1;
    }

    std::cout << "Client: " << bt.peerAddress() << "\n";
    bt.writeString("HELLO\n");
    return 0;
}
*/