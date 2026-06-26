#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace jc_comms_listen {

enum class Transport {
    Uart,
    Usb,
    Bluetooth,
    Wifi,
    Ethernet,
    I2c,
    Spi
};

struct ListenRequest {
    Transport transport = Transport::Uart;
    std::string deviceSpec;            // ex: /dev/ttyUSB0@460800 | server#1 | tcp://0.0.0.0:5000

    // rx_mode: "line" | "bytes" | "packet"
    std::string rxMode = "line";
    int pollTimeoutMs = 80;
    size_t maxBytes = 512;

    // UART/BT/TCP/UDP auto reply
    bool autoReply = false;
    bool echoReply = false;
    std::string replyPayload = "ACK";
    std::string replyEncoding = "ascii";   // "ascii" | "hex"
    bool replyAppendNewline = true;

    // I2C / SPI are master-driven on Linux user space:
    // we cannot "passively listen". We do an active poll request and log the reply.
    std::string pollTxPayload;              // request bytes to send periodically
    std::string pollTxEncoding = "hex";    // "ascii" | "hex"
    int pollIntervalMs = 250;               // active polling period for I2C / SPI
};

struct ListenStatus {
    bool running = false;
    bool connected = false;
    std::string peer;
    uint64_t rxCount = 0;
    uint64_t txCount = 0;
    uint64_t lastRxTsMs = 0;
    std::string error;
};

struct ListenEvent {
    uint64_t tsMs = 0;
    std::string dir;       // "rx" | "tx" | "info" | "err"
    std::string transport; // "uart" | "bluetooth" | "wifi" | "ethernet" | "i2c" | "spi"
    std::string device;
    std::string encoding;  // "ascii" | "hex"
    std::string data;      // already formatted for UI (ascii or hex)
};

using EventCallback = std::function<void(const ListenEvent&)>;

class CommsListenService {
public:
    CommsListenService();
    ~CommsListenService();

    CommsListenService(const CommsListenService&) = delete;
    CommsListenService& operator=(const CommsListenService&) = delete;

    void setEventCallback(EventCallback cb);

    // Start a background listener. Returns false on immediate error.
    bool start(const ListenRequest& req, std::string* errOut = nullptr);
    void stop();

    ListenStatus status() const;
    std::string statusJson() const;

    // Minimal scan helper (best effort) to populate dropdowns.
    // Returns JSON (object with arrays per transport).
    static std::string scanJson();

private:
    mutable std::mutex m_;
    ListenRequest req_{};
    ListenStatus st_{};

    std::atomic<bool> running_{false};
    std::atomic<bool> stopFlag_{false};
    std::thread th_;

    EventCallback eventCb_;

    void setError_(const std::string& err);
    void setConnected_(bool connected, const std::string& peer);
    void bumpRx_(uint64_t tsMs);
    void bumpTx_();

    void emit_(ListenEvent ev);

    void threadMain_();

    // Helpers
    static uint64_t nowMs_();
    static std::string transportToString_(Transport t);

    static bool parseUartSpec_(const std::string& spec, std::string& portOut, int& baudOut);
    static bool parseBtSpec_(const std::string& spec, bool& server, std::string& addr, int& channel);
    static bool parseNetSpec_(const std::string& spec, std::string& proto, std::string& host, int& port);
    static bool parseI2cSpec_(const std::string& spec, std::string& deviceOut, uint16_t& addrOut);
    static bool parseSpiSpec_(const std::string& spec, std::string& deviceOut, uint32_t& speedOut, uint8_t& modeOut, uint8_t& bitsOut);

    static std::vector<uint8_t> parseHexBytes_(const std::string& s, bool* ok = nullptr);
    static std::string bytesToHex_(const uint8_t* data, size_t n);
    static std::string bytesToAsciiSafe_(const uint8_t* data, size_t n);
    static std::vector<uint8_t> buildReply_(const ListenRequest& r,
                                            const uint8_t* rxData,
                                            size_t rxSize,
                                            bool* ok);
    static std::vector<uint8_t> buildPollRequest_(const ListenRequest& r, bool* ok);
};

} // namespace jc_comms_listen
