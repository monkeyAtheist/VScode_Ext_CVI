#pragma once

#include <cstdint>
#include <deque>
#include <filesystem>
#include <mutex>
#include <optional>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

#include "../uart/uart.h"
#include "../bluetooth/bluetooth.h"
#include "../wifi/wifi.h"
#include "../ethernet/ethernet.h"
#include "../I2C/I2C.h"
#include "../SPI/SPI.h"

// -----------------------------------------------------------------------------
// CommsManager V2
//  - Charge des devices + presets depuis un INI (motherboard_trame.ini)
//  - Ajoute une auto-découverte (UART + Bluetooth quand possible)
//  - Envoie une trame via UART / BT / WiFi / RJ45
//  - Optionnel: lit une réponse (ACK / reply) et expose un historique JSON
// -----------------------------------------------------------------------------

namespace jc_comms {

enum class Transport {
    Uart,
    Usb,
    Bluetooth,
    Wifi,
    Ethernet,
    I2c,
    Spi
};

struct Preset {
    std::string name;   // label affiché
    std::string value;  // payload à envoyer
};

struct DeviceItem {
    std::string name;    // label affiché
    std::string spec;    // ex: /dev/ttyUSB0@460800, DC:A6:..#1, tcp://ip:port
    std::string source;  // "ini" | "scan"
};

struct CommsConfig {
    std::vector<DeviceItem> uartDevices;
    std::vector<Preset>     uartPresets;

    std::vector<DeviceItem> usbDevices;
    std::vector<Preset>     usbPresets;

    std::vector<DeviceItem> btDevices;
    std::vector<Preset>     btPresets;

    std::vector<DeviceItem> wifiDevices;
    std::vector<Preset>     wifiPresets;

    std::vector<DeviceItem> ethDevices;
    std::vector<Preset>     ethPresets;

    std::vector<DeviceItem> i2cDevices;
    std::vector<Preset>     i2cPresets;

    std::vector<DeviceItem> spiDevices;
    std::vector<Preset>     spiPresets;

    int uartDefaultBaud = 460800;
    int btDefaultChannel = 1;
    uint16_t netDefaultPort = 5000;
    bool netDefaultUdp = false; // false => TCP

    // Auto-discovery switches
    bool scanUart = true;
    bool scanUsb = true;
    bool scanBluetooth = false; // BT scan dépend souvent de bluetoothctl; OFF par défaut
    bool scanI2c = true;
    bool scanSpi = true;
};

struct SendRequest {
    Transport transport = Transport::Uart;
    std::string deviceSpec;      // port@baud, mac#ch, tcp://host:port, ...
    std::string payload;         // texte ou hex
    std::string encoding = "ascii"; // "ascii" | "hex"
    bool appendNewline = false;
};

struct ReplyOptions {
    bool expectReply = false;
    std::string mode = "line"; // "line" | "bytes" | "packet"
    int timeoutMs = 250;
    size_t maxBytes = 512;
    bool clearRxBeforeSend = true;
};

struct SendResult {
    bool ok = false;
    std::string error;

    bool haveReply = false;
    std::string replyAscii; // si décodage pertinent
    std::string replyHex;   // toujours disponible si haveReply
};

struct HistoryItem {
    uint64_t tsMs = 0;
    std::string dir;        // "tx" | "rx"
    std::string transport;  // "uart"|"bluetooth"|"wifi"|"ethernet"
    std::string device;
    std::string encoding;   // "ascii" | "hex"
    std::string data;       // string (ascii) ou hex string
};

class CommsManager {
public:
    bool loadIni(const std::filesystem::path& iniPath, std::string* err = nullptr);

    // Mise à jour des listes de devices via auto-discovery (UART + BT).
    void refreshDevices(std::string* err = nullptr);

    const CommsConfig& config() const { return cfg_; }

    // JSON stable pour le frontend
    std::string configJson() const;
    std::string historyJson(size_t limit = 200) const;

    // Envoi simple
    bool send(const SendRequest& req, std::string* err = nullptr);

    // Envoi + lecture optionnelle
    SendResult sendEx(const SendRequest& req, const ReplyOptions& ro);

    void closeAll();

private:
    CommsConfig cfg_{};
    std::filesystem::path iniPath_{};

    // Connexions ouvertes en cache
    mutable std::mutex m_;
    std::unordered_map<std::string, jc_uart::Uart> uart_;
    std::unordered_map<std::string, jc_uart::Uart> usb_;
    std::unordered_map<std::string, jc_bluetooth::BluetoothLink> bt_;
    std::unordered_map<std::string, jc_wifi::WifiLink> wifi_;
    std::unordered_map<std::string, jc_ethernet::EthernetLink> eth_;
    std::unordered_map<std::string, jc_i2c::I2cDevice> i2c_;
    std::unordered_map<std::string, jc_spi::SpiDevice> spi_;

    // Historique en RAM
    mutable std::mutex histMutex_;
    std::deque<HistoryItem> history_;
    size_t historyMax_ = 600;

    void pushHistory_(HistoryItem it);

    static uint64_t nowMs_();
    static std::string trim_(std::string s);

    static bool parseIniSection_(const std::filesystem::path& p,
                                const std::string& wantedSection,
                                std::vector<std::pair<std::string, std::string>>& out);

    static bool parseHexBytes_(const std::string& text, std::vector<uint8_t>& out);

    static bool parseUartSpec_(const CommsConfig& cfg, const std::string& spec,
                              std::string& outPort, int& outBaud);

    static bool parseBtSpec_(const CommsConfig& cfg, const std::string& spec,
                            std::string& outMac, int& outChannel);
    static bool parseI2cSpec_(const std::string& spec, std::string& outDev, uint16_t& outAddr);
    static bool parseSpiSpec_(const std::string& spec, std::string& outDev, uint32_t& outSpeed, uint8_t& outMode, uint8_t& outBits);

    struct NetSpec {
        bool udp = false;
        std::string host;
        uint16_t port = 0;
    };
    static bool parseNetSpec_(const CommsConfig& cfg, const std::string& spec, NetSpec& out);

    static std::string jsonEscape_(const std::string& s);
    static std::string bytesToHex_(const uint8_t* data, size_t n);

    // Discovery
    void scanUart_(std::vector<DeviceItem>& out, std::string* err);
    void scanUsb_(std::vector<DeviceItem>& out, std::string* err);
    void scanBluetooth_(std::vector<DeviceItem>& out, std::string* err);
    void scanI2c_(std::vector<DeviceItem>& out, std::string* err);
    void scanSpi_(std::vector<DeviceItem>& out, std::string* err);

    static bool containsSpec_(const std::vector<DeviceItem>& v, const std::string& spec);
};

} // namespace jc_comms
