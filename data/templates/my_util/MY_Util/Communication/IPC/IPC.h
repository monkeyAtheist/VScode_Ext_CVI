#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace jc_ipc {

    enum class PipeType {
        NamedPipe,  // Windows: Named Pipe, Linux: socket local AF_UNIX
        Fifo,       // Linux: paire de FIFO nommées pour full-duplex
        Anonymous   // pipe anonyme local (via createAnonymousPair)
    };

    enum class PipeRole {
        Server,
        Client
    };

    enum class PipeAccess {
        ReadOnly,
        WriteOnly,
        ReadWrite
    };

    struct IpcConfig {
        PipeType type = PipeType::NamedPipe;
        PipeRole role = PipeRole::Server;
        PipeAccess access = PipeAccess::ReadWrite;

        // NamedPipe:
        //   Windows -> nom logique, ex: "jc_PIPE"
        //   Linux   -> chemin socket UNIX, ex: "/tmp/jc_pipe.sock"
        // Fifo:
        //   base de nom/path, ex: "/tmp/jc_fifo"
        //   la lib créera automatiquement :
        //     <base>_c2s et <base>_s2c
        std::string name = "jc_IPC";

        int readTimeoutMs = 100;
        int writeTimeoutMs = 100;
        int connectTimeoutMs = 2000;
        bool createIfMissing = true;
        bool removeEndpointOnClose = false;
        bool messageMode = true; // utile surtout côté Windows Named Pipe
    };

    class IpcPipe {
    public:
        struct Packet {
            uint8_t type = 0;
            std::vector<uint8_t> payload;
        };

        IpcPipe() = default;
        explicit IpcPipe(const IpcConfig& cfg);
        ~IpcPipe();

        IpcPipe(const IpcPipe&) = delete;
        IpcPipe& operator=(const IpcPipe&) = delete;

        IpcPipe(IpcPipe&& other) noexcept;
        IpcPipe& operator=(IpcPipe&& other) noexcept;

        bool open(const IpcConfig& cfg);
        void close();
        bool isOpen() const;
        bool hasPeer() const;

        // Server NamedPipe: attend un client.
        // Client NamedPipe: retourne isOpen().
        // FIFO / Anonymous: retourne isOpen().
        bool waitPeer(int timeoutMs = -1);

        const IpcConfig& config() const { return cfg_; }
        bool setTimeouts(int readMs, int writeMs);

        int writeBytes(const uint8_t* data, size_t size);
        int readBytes(uint8_t* buffer, size_t maxSize, int timeoutMs = -1);
        int writeString(const std::string& s);
        bool readLine(std::string& outLine, char eol = '\n', int timeoutMs = -1, size_t maxLen = 512);

        // Format de trame simple :
        // [0xAA][0x55][TYPE][LEN_L][LEN_H][PAYLOAD...][CHK]
        // CHK = checksum8(TYPE + LEN_L + LEN_H + PAYLOAD)
        bool sendPacket(uint8_t type, const std::vector<uint8_t>& payload);
        bool receivePacket(Packet& packet, int timeoutMs = -1);

        // Crée une paire de pipes anonymes unidirectionnelle.
        // reader  : endpoint lecture seule
        // writer  : endpoint écriture seule
        static bool createAnonymousPair(IpcPipe& reader, IpcPipe& writer,
            int readTimeoutMs = 100,
            int writeTimeoutMs = 100);

        static uint8_t checksum8(const uint8_t* data, size_t size);

    public:
#if defined(_WIN32)
        using handle_t = void*;
        static constexpr handle_t kInvalidHandle = nullptr;
#else
        using handle_t = int;
        static constexpr handle_t kInvalidHandle = -1;
#endif

    private:
        IpcConfig cfg_{};
        mutable std::mutex ioMutex_;
        std::vector<uint8_t> rxBuffer_;

        handle_t controlHandle_ = kInvalidHandle; // serveur/listen si nécessaire
        handle_t readHandle_ = kInvalidHandle;
        handle_t writeHandle_ = kInvalidHandle;

        bool opened_ = false;
        bool peerConnected_ = false;
        bool ownsEndpoint_ = false;
        std::string endpointNameResolved_;

        bool openNamedPipe_();
        bool openFifo_();
        bool openAnonymous_();
        bool waitPeerNamedPipe_(int timeoutMs);

        void closeHandle_(handle_t& h);
        int waitReadable_(handle_t h, int timeoutMs) const;
        int waitWritable_(handle_t h, int timeoutMs) const;
        int readOne_(uint8_t& b, int timeoutMs);
    };

} // namespace jc_ipc

//Exemple Named pipe - socket locale
//Serveur :
/*
#include "IPC.h"
#include <iostream>

int main()
{
    jc_ipc::IpcConfig cfg;
    cfg.type = jc_ipc::PipeType::NamedPipe;
    cfg.role = jc_ipc::PipeRole::Server;
    cfg.name =
#ifdef _WIN32
        "jc_ROBOT_PIPE";
#else
        "/tmp/jc_robot.sock";
#endif

    jc_ipc::IpcPipe ipc;
    if (!ipc.open(cfg)) {
        std::cerr << "Impossible d'ouvrir l'IPC serveur\n";
        return -1;
    }

    if (!ipc.waitPeer(5000)) {
        std::cerr << "Aucun client connecte\n";
        return -1;
    }

    ipc.writeString("HELLO\n");
    return 0;
}
*/

//Client :
/*
#include "IPC.h"
#include <iostream>

int main()
{
    jc_ipc::IpcConfig cfg;
    cfg.type = jc_ipc::PipeType::NamedPipe;
    cfg.role = jc_ipc::PipeRole::Client;
    cfg.name =
#ifdef _WIN32
        "jc_ROBOT_PIPE";
#else
        "/tmp/jc_robot.sock";
#endif

    jc_ipc::IpcPipe ipc;
    if (!ipc.open(cfg)) {
        std::cerr << "Impossible d'ouvrir l'IPC client\n";
        return -1;
    }

    std::string line;
    if (ipc.readLine(line)) {
        std::cout << "Recu: " << line << "\n";
    }

    return 0;
}
*/


//Exemple FIFO (Linux uniquement)
/*
jc_ipc::IpcConfig cfg;
cfg.type = jc_ipc::PipeType::Fifo;
cfg.role = jc_ipc::PipeRole::Server;
cfg.name = "/tmp/jc_fifo";

jc_ipc::IpcPipe ipc;
if (!ipc.open(cfg)) {
    return -1;
}

ipc.sendPacket(0x20, {0x01, 0x02, 0x03});
*/

//Exemple pipe anonyme (full-duplex local, pas de nom, pas de timeout de connexion)
/*
#include "IPC.h"
#include <iostream>

int main()
{
    jc_ipc::IpcPipe reader;
    jc_ipc::IpcPipe writer;

    if (!jc_ipc::IpcPipe::createAnonymousPair(reader, writer)) {
        std::cerr << "Impossible de creer la paire anonyme\n";
        return -1;
    }

    writer.writeString("PING\n");

    std::string line;
    if (reader.readLine(line)) {
        std::cout << "Recu: " << line << "\n";
    }

    return 0;
}
*/