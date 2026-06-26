#include "comms_manager.h"

#include <algorithm>
#include <chrono>
#include <cctype>
#include <cstdio>
#include <fstream>
#include <sstream>

#if !defined(_WIN32)
#include <unistd.h>
#endif

namespace jc_comms {

static bool toBoolLoose(const std::string& s, bool fallback)
{
    std::string v;
    v.reserve(s.size());
    for (char c : s) v.push_back(static_cast<char>(std::tolower(static_cast<unsigned char>(c))));
    v.erase(std::remove_if(v.begin(), v.end(), ::isspace), v.end());

    if (v == "1" || v == "true" || v == "yes" || v == "on") return true;
    if (v == "0" || v == "false" || v == "no" || v == "off") return false;
    return fallback;
}

uint64_t CommsManager::nowMs_()
{
    using namespace std::chrono;
    return static_cast<uint64_t>(duration_cast<milliseconds>(system_clock::now().time_since_epoch()).count());
}

void CommsManager::pushHistory_(HistoryItem it)
{
    std::lock_guard<std::mutex> lk(histMutex_);
    if (history_.size() >= historyMax_) {
        history_.pop_front();
    }
    history_.push_back(std::move(it));
}

std::string CommsManager::trim_(std::string s)
{
    auto issp = [](unsigned char c) { return std::isspace(c) != 0; };
    while (!s.empty() && issp(static_cast<unsigned char>(s.front()))) s.erase(s.begin());
    while (!s.empty() && issp(static_cast<unsigned char>(s.back()))) s.pop_back();
    return s;
}

bool CommsManager::parseIniSection_(const std::filesystem::path& p,
                                   const std::string& wantedSection,
                                   std::vector<std::pair<std::string, std::string>>& out)
{
    out.clear();
    std::ifstream f(p);
    if (!f.is_open()) return false;

    std::string section;
    std::string line;
    const auto wantLower = [&]() {
        std::string s = wantedSection;
        std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return std::tolower(c); });
        return s;
    }();

    while (std::getline(f, line)) {
        // strip comments ; and #
        const auto semi = line.find(';');
        const auto hash = line.find('#');
        size_t cut = std::string::npos;
        if (semi != std::string::npos) cut = semi;
        if (hash != std::string::npos) cut = std::min(cut, hash);
        if (cut != std::string::npos) line = line.substr(0, cut);

        line = trim_(line);
        if (line.empty()) continue;

        if (line.front() == '[' && line.back() == ']') {
            section = line.substr(1, line.size() - 2);
            section = trim_(section);
            std::transform(section.begin(), section.end(), section.begin(), [](unsigned char c) { return std::tolower(c); });
            continue;
        }

        if (section != wantLower) continue;

        const auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = trim_(line.substr(0, eq));
        std::string v = trim_(line.substr(eq + 1));
        if (!k.empty()) out.emplace_back(std::move(k), std::move(v));
    }

    return !out.empty();
}

bool CommsManager::parseHexBytes_(const std::string& text, std::vector<uint8_t>& out)
{
    out.clear();
    std::string s = text;
    // accept separators: space, comma, ';', ':'
    for (char& c : s) {
        if (c == ',' || c == ';' || c == ':') c = ' ';
    }

    std::istringstream iss(s);
    std::string tok;
    while (iss >> tok) {
        if (tok.rfind("0x", 0) == 0 || tok.rfind("0X", 0) == 0) tok = tok.substr(2);
        if (tok.size() == 1) tok = "0" + tok;
        if (tok.size() != 2) return false;
        auto hexVal = [](char c) -> int {
            if (c >= '0' && c <= '9') return c - '0';
            if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
            if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
            return -1;
        };
        const int hi = hexVal(tok[0]);
        const int lo = hexVal(tok[1]);
        if (hi < 0 || lo < 0) return false;
        out.push_back(static_cast<uint8_t>((hi << 4) | lo));
    }

    return !out.empty();
}

static std::string unescapeAscii(const std::string& s)
{
    std::string out;
    out.reserve(s.size());

    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (c == '\\' && i + 1 < s.size()) {
            const char n = s[i + 1];
            if (n == 'n') { out.push_back('\n'); ++i; continue; }
            if (n == 'r') { out.push_back('\r'); ++i; continue; }
            if (n == 't') { out.push_back('\t'); ++i; continue; }
            if (n == '\\') { out.push_back('\\'); ++i; continue; }
        }
        out.push_back(c);
    }
    return out;
}

bool CommsManager::parseUartSpec_(const CommsConfig& cfg, const std::string& spec,
                                 std::string& outPort, int& outBaud)
{
    std::string s = trim_(spec);
    if (s.empty()) return false;
    outBaud = cfg.uartDefaultBaud;

    const auto at = s.find('@');
    if (at == std::string::npos) {
        outPort = s;
        return true;
    }

    outPort = trim_(s.substr(0, at));
    const std::string b = trim_(s.substr(at + 1));
    try {
        outBaud = std::max(1200, std::stoi(b));
    } catch (...) {
        outBaud = cfg.uartDefaultBaud;
    }

    return !outPort.empty();
}

bool CommsManager::parseBtSpec_(const CommsConfig& cfg, const std::string& spec,
                               std::string& outMac, int& outChannel)
{
    std::string s = trim_(spec);
    if (s.empty()) return false;
    outChannel = cfg.btDefaultChannel;

    const auto hash = s.find('#');
    if (hash == std::string::npos) {
        outMac = s;
        return true;
    }

    outMac = trim_(s.substr(0, hash));
    const std::string ch = trim_(s.substr(hash + 1));
    try {
        outChannel = std::clamp(std::stoi(ch), 1, 30);
    } catch (...) {
        outChannel = cfg.btDefaultChannel;
    }
    return !outMac.empty();
}

bool CommsManager::parseNetSpec_(const CommsConfig& cfg, const std::string& spec, NetSpec& out)
{
    std::string s = trim_(spec);
    if (s.empty()) return false;

    out.udp = cfg.netDefaultUdp;

    if (s.rfind("udp://", 0) == 0) {
        out.udp = true;
        s = s.substr(6);
    } else if (s.rfind("tcp://", 0) == 0) {
        out.udp = false;
        s = s.substr(6);
    }

    const auto colon = s.rfind(':');
    if (colon == std::string::npos) {
        out.host = s;
        out.port = cfg.netDefaultPort;
        return !out.host.empty();
    }

    out.host = trim_(s.substr(0, colon));
    const std::string p = trim_(s.substr(colon + 1));
    int port = cfg.netDefaultPort;
    try {
        port = std::stoi(p);
    } catch (...) {
        port = cfg.netDefaultPort;
    }
    port = std::clamp(port, 1, 65535);
    out.port = static_cast<uint16_t>(port);
    return !out.host.empty();
}

bool CommsManager::parseI2cSpec_(const std::string& spec, std::string& outDev, uint16_t& outAddr)
{
    std::string s = trim_(spec);
    if (s.empty()) return false;
    outDev = "/dev/i2c-1";
    outAddr = 0x42;

    const auto at = s.find('@');
    if (at == std::string::npos) {
        outDev = s;
        return true;
    }
    outDev = trim_(s.substr(0, at));
    std::string a = trim_(s.substr(at + 1));
    try {
        int base = 10;
        if (a.rfind("0x", 0) == 0 || a.rfind("0X", 0) == 0) { a = a.substr(2); base = 16; }
        outAddr = static_cast<uint16_t>(std::stoi(a, nullptr, base));
    } catch (...) {
        return false;
    }
    return !outDev.empty();
}

bool CommsManager::parseSpiSpec_(const std::string& spec, std::string& outDev, uint32_t& outSpeed, uint8_t& outMode, uint8_t& outBits)
{
    std::string s = trim_(spec);
    if (s.empty()) return false;
    outDev = "/dev/spidev0.0";
    outSpeed = 1000000;
    outMode = 0;
    outBits = 8;

    const auto at = s.find('@');
    if (at == std::string::npos) {
        outDev = s;
        return true;
    }
    outDev = trim_(s.substr(0, at));
    std::string rest = trim_(s.substr(at + 1));

    // format: speed#mode+bits
    std::string speedPart = rest;
    std::string modePart;
    std::string bitsPart;
    auto hash = rest.find('#');
    if (hash != std::string::npos) {
        speedPart = trim_(rest.substr(0, hash));
        auto plus = rest.find('+', hash + 1);
        if (plus == std::string::npos) modePart = trim_(rest.substr(hash + 1));
        else {
            modePart = trim_(rest.substr(hash + 1, plus - (hash + 1)));
            bitsPart = trim_(rest.substr(plus + 1));
        }
    }

    try { if (!speedPart.empty()) outSpeed = static_cast<uint32_t>(std::stoul(speedPart)); } catch (...) {}
    try { if (!modePart.empty()) outMode = static_cast<uint8_t>(std::stoi(modePart)); } catch (...) {}
    try { if (!bitsPart.empty()) outBits = static_cast<uint8_t>(std::stoi(bitsPart)); } catch (...) {}
    outMode = std::min<uint8_t>(outMode, 3);
    if (outBits == 0) outBits = 8;
    return !outDev.empty();
}

std::string CommsManager::jsonEscape_(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
        case '\\': out += "\\\\"; break;
        case '"':  out += "\\\""; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                // skip control chars
            } else {
                out.push_back(c);
            }
        }
    }
    return out;
}

std::string CommsManager::bytesToHex_(const uint8_t* data, size_t n)
{
    static const char* kHex = "0123456789ABCDEF";
    std::string out;
    out.reserve(n * 3);
    for (size_t i = 0; i < n; ++i) {
        const uint8_t b = data[i];
        out.push_back(kHex[(b >> 4) & 0xF]);
        out.push_back(kHex[b & 0xF]);
        if (i + 1 < n) out.push_back(' ');
    }
    return out;
}

bool CommsManager::containsSpec_(const std::vector<DeviceItem>& v, const std::string& spec)
{
    for (const auto& d : v) {
        if (d.spec == spec) return true;
    }
    return false;
}

bool CommsManager::loadIni(const std::filesystem::path& iniPath, std::string* err)
{
    if (err) err->clear();

    iniPath_ = iniPath;
    cfg_ = CommsConfig{};

    if (!std::filesystem::exists(iniPath)) {
        if (err) *err = "motherboard_trame.ini introuvable: " + iniPath.string();
        return false;
    }

    // defaults
    {
        std::vector<std::pair<std::string, std::string>> kv;
        if (parseIniSection_(iniPath, "defaults", kv)) {
            for (const auto& [k0, v0] : kv) {
                std::string k = k0;
                std::transform(k.begin(), k.end(), k.begin(), [](unsigned char c) { return std::tolower(c); });
                if (k == "uart_baud") {
                    try { cfg_.uartDefaultBaud = std::stoi(v0); } catch (...) {}
                } else if (k == "bt_channel") {
                    try { cfg_.btDefaultChannel = std::stoi(v0); } catch (...) {}
                } else if (k == "net_port") {
                    try { cfg_.netDefaultPort = static_cast<uint16_t>(std::stoi(v0)); } catch (...) {}
                } else if (k == "net_udp") {
                    cfg_.netDefaultUdp = toBoolLoose(v0, cfg_.netDefaultUdp);
                }
            }
        }
    }

    // scan
    {
        std::vector<std::pair<std::string, std::string>> kv;
        if (parseIniSection_(iniPath, "scan", kv)) {
            for (const auto& [k0, v0] : kv) {
                std::string k = k0;
                std::transform(k.begin(), k.end(), k.begin(), [](unsigned char c) { return std::tolower(c); });
                if (k == "uart") cfg_.scanUart = toBoolLoose(v0, cfg_.scanUart);
                if (k == "usb") cfg_.scanUsb = toBoolLoose(v0, cfg_.scanUsb);
                if (k == "bluetooth") cfg_.scanBluetooth = toBoolLoose(v0, cfg_.scanBluetooth);
                if (k == "i2c") cfg_.scanI2c = toBoolLoose(v0, cfg_.scanI2c);
                if (k == "spi") cfg_.scanSpi = toBoolLoose(v0, cfg_.scanSpi);
            }
        }
    }

    auto loadDevices = [&](const std::string& sec, std::vector<DeviceItem>& dst) {
        std::vector<std::pair<std::string, std::string>> kv;
        if (!parseIniSection_(iniPath, sec, kv)) return;
        for (const auto& [name, spec] : kv) {
            if (trim_(spec).empty()) continue;
            DeviceItem it;
            it.name = trim_(name);
            it.spec = trim_(spec);
            it.source = "ini";
            dst.push_back(std::move(it));
        }
    };

    auto loadPresets = [&](const std::string& sec, std::vector<Preset>& dst) {
        std::vector<std::pair<std::string, std::string>> kv;
        if (!parseIniSection_(iniPath, sec, kv)) return;
        for (const auto& [name, value] : kv) {
            if (trim_(value).empty()) continue;
            Preset p;
            p.name = trim_(name);
            p.value = trim_(value);
            dst.push_back(std::move(p));
        }
    };

    loadDevices("uart_devices", cfg_.uartDevices);
    loadPresets("uart_presets", cfg_.uartPresets);

    loadDevices("usb_devices", cfg_.usbDevices);
    loadPresets("usb_presets", cfg_.usbPresets);

    loadDevices("bluetooth_devices", cfg_.btDevices);
    loadPresets("bluetooth_presets", cfg_.btPresets);

    loadDevices("wifi_devices", cfg_.wifiDevices);
    loadPresets("wifi_presets", cfg_.wifiPresets);

    loadDevices("ethernet_devices", cfg_.ethDevices);
    loadPresets("ethernet_presets", cfg_.ethPresets);

    loadDevices("i2c_devices", cfg_.i2cDevices);
    loadPresets("i2c_presets", cfg_.i2cPresets);

    loadDevices("spi_devices", cfg_.spiDevices);
    loadPresets("spi_presets", cfg_.spiPresets);

    // Auto-discovery
    refreshDevices(err);

    return true;
}

void CommsManager::scanUart_(std::vector<DeviceItem>& out, std::string* err)
{
    out.clear();
#if defined(_WIN32)
    (void)err;
    return;
#else
    try {
        const std::filesystem::path dev("/dev");
        if (std::filesystem::exists("/dev/serial0")) {
            out.push_back({"serial0", "/dev/serial0@" + std::to_string(cfg_.uartDefaultBaud), "scan"});
        }
        if (std::filesystem::exists("/dev/serial1")) {
            out.push_back({"serial1", "/dev/serial1@" + std::to_string(cfg_.uartDefaultBaud), "scan"});
        }
        for (const auto& e : std::filesystem::directory_iterator(dev)) {
            const auto name = e.path().filename().string();
            if (name.rfind("ttyAMA", 0) == 0 || name.rfind("ttyS", 0) == 0) {
                const std::string spec = (dev / name).string() + "@" + std::to_string(cfg_.uartDefaultBaud);
                out.push_back({name, spec, "scan"});
            }
        }
    } catch (const std::exception& ex) {
        if (err) *err = std::string("UART scan failed: ") + ex.what();
    }
#endif
}

void CommsManager::scanUsb_(std::vector<DeviceItem>& out, std::string* err)
{
    out.clear();
#if defined(_WIN32)
    (void)err;
    return;
#else
    try {
        const std::filesystem::path dev("/dev");
        for (const auto& e : std::filesystem::directory_iterator(dev)) {
            const auto name = e.path().filename().string();
            if (name.rfind("ttyUSB", 0) == 0 || name.rfind("ttyACM", 0) == 0) {
                const std::string spec = (dev / name).string() + "@" + std::to_string(cfg_.uartDefaultBaud);
                out.push_back({name, spec, "scan"});
            }
        }
        const std::filesystem::path byId("/dev/serial/by-id");
        if (std::filesystem::exists(byId)) {
            for (const auto& e : std::filesystem::directory_iterator(byId)) {
                const auto name = e.path().filename().string();
                const std::string spec = e.path().string() + "@" + std::to_string(cfg_.uartDefaultBaud);
                out.push_back({"by-id:" + name, spec, "scan"});
            }
        }
    } catch (const std::exception& ex) {
        if (err) *err = std::string("USB scan failed: ") + ex.what();
    }
#endif
}

void CommsManager::scanBluetooth_(std::vector<DeviceItem>& out, std::string* err)
{
    out.clear();
#if defined(_WIN32)
    (void)err;
    return;
#else
    // Best-effort scan using bluetoothctl.
    // Output format example:
    //   Device DC:A6:32:11:22:33 ESP32-Boat
    FILE* fp = ::popen("bluetoothctl devices 2>/dev/null", "r");
    if (!fp) {
        if (err) *err = "bluetoothctl not available";
        return;
    }

    char buf[512];
    while (std::fgets(buf, sizeof(buf), fp)) {
        std::string line(buf);
        line = trim_(line);
        if (line.rfind("Device ", 0) != 0) continue;

        // split
        std::istringstream iss(line);
        std::string word, mac;
        iss >> word >> mac;
        std::string name;
        std::getline(iss, name);
        name = trim_(name);
        if (mac.empty()) continue;

        DeviceItem it;
        it.name = name.empty() ? ("BT " + mac) : name;
        it.spec = mac + "#" + std::to_string(cfg_.btDefaultChannel);
        it.source = "scan";
        out.push_back(std::move(it));
    }

    ::pclose(fp);
#endif
}

void CommsManager::scanI2c_(std::vector<DeviceItem>& out, std::string* err)
{
    out.clear();
#if defined(_WIN32)
    (void)err; return;
#else
    try {
        for (const auto& e : std::filesystem::directory_iterator("/dev")) {
            const auto name = e.path().filename().string();
            if (name.rfind("i2c-", 0) == 0) {
                const std::string dev = std::string("/dev/") + name;
                out.push_back({name, dev + "@0x42", "scan"});
            }
        }
        if (out.empty()) out.push_back({"i2c-1", "/dev/i2c-1@0x42", "default"});
    } catch (const std::exception& ex) {
        if (err) *err = std::string("I2C scan failed: ") + ex.what();
    }
#endif
}

void CommsManager::scanSpi_(std::vector<DeviceItem>& out, std::string* err)
{
    out.clear();
#if defined(_WIN32)
    (void)err; return;
#else
    try {
        for (const auto& e : std::filesystem::directory_iterator("/dev")) {
            const auto name = e.path().filename().string();
            if (name.rfind("spidev", 0) == 0) {
                const std::string dev = std::string("/dev/") + name;
                out.push_back({name, dev + "@1000000#0+8", "scan"});
            }
        }
        if (out.empty()) out.push_back({"spidev0.0", "/dev/spidev0.0@1000000#0+8", "default"});
    } catch (const std::exception& ex) {
        if (err) *err = std::string("SPI scan failed: ") + ex.what();
    }
#endif
}

void CommsManager::refreshDevices(std::string* err)
{
    if (err) err->clear();

    if (cfg_.scanUart) {
        std::vector<DeviceItem> found;
        scanUart_(found, err);
        for (auto& d : found) if (!containsSpec_(cfg_.uartDevices, d.spec)) cfg_.uartDevices.push_back(std::move(d));
    }
    if (cfg_.scanUsb) {
        std::vector<DeviceItem> found;
        scanUsb_(found, err);
        for (auto& d : found) if (!containsSpec_(cfg_.usbDevices, d.spec)) cfg_.usbDevices.push_back(std::move(d));
    }
    if (cfg_.scanBluetooth) {
        std::vector<DeviceItem> found;
        scanBluetooth_(found, err);
        for (auto& d : found) if (!containsSpec_(cfg_.btDevices, d.spec)) cfg_.btDevices.push_back(std::move(d));
    }
    if (cfg_.scanI2c) {
        std::vector<DeviceItem> found;
        scanI2c_(found, err);
        for (auto& d : found) if (!containsSpec_(cfg_.i2cDevices, d.spec)) cfg_.i2cDevices.push_back(std::move(d));
    }
    if (cfg_.scanSpi) {
        std::vector<DeviceItem> found;
        scanSpi_(found, err);
        for (auto& d : found) if (!containsSpec_(cfg_.spiDevices, d.spec)) cfg_.spiDevices.push_back(std::move(d));
    }

    auto sortByName = [](std::vector<DeviceItem>& v) {
        std::sort(v.begin(), v.end(), [](const DeviceItem& a, const DeviceItem& b) { return a.name < b.name; });
    };
    sortByName(cfg_.uartDevices);
    sortByName(cfg_.usbDevices);
    sortByName(cfg_.btDevices);
    sortByName(cfg_.wifiDevices);
    sortByName(cfg_.ethDevices);
    sortByName(cfg_.i2cDevices);
    sortByName(cfg_.spiDevices);
}

std::string CommsManager::configJson() const
{
    auto dumpSection = [&](const char* key,
                           const std::vector<DeviceItem>& devs,
                           const std::vector<Preset>& presets) -> std::string {
        std::ostringstream oss;
        oss << "\"" << key << "\":{";

        oss << "\"devices\":[";
        for (size_t i = 0; i < devs.size(); ++i) {
            const auto& d = devs[i];
            if (i) oss << ",";
            oss << "{";
            oss << "\"name\":\"" << jsonEscape_(d.name) << "\",";
            oss << "\"spec\":\"" << jsonEscape_(d.spec) << "\",";
            oss << "\"source\":\"" << jsonEscape_(d.source) << "\"";
            oss << "}";
        }
        oss << "]";

        oss << ",\"presets\":[";
        for (size_t i = 0; i < presets.size(); ++i) {
            const auto& p = presets[i];
            if (i) oss << ",";
            oss << "{";
            oss << "\"name\":\"" << jsonEscape_(p.name) << "\",";
            oss << "\"value\":\"" << jsonEscape_(p.value) << "\"";
            oss << "}";
        }
        oss << "]";

        oss << "}";
        return oss.str();
    };

    std::ostringstream root;
    root << "{";
    root << dumpSection("uart", cfg_.uartDevices, cfg_.uartPresets) << ",";
    root << dumpSection("usb", cfg_.usbDevices, cfg_.usbPresets) << ",";
    root << dumpSection("bluetooth", cfg_.btDevices, cfg_.btPresets) << ",";
    root << dumpSection("wifi", cfg_.wifiDevices, cfg_.wifiPresets) << ",";
    root << dumpSection("ethernet", cfg_.ethDevices, cfg_.ethPresets) << ",";
    root << dumpSection("i2c", cfg_.i2cDevices, cfg_.i2cPresets) << ",";
    root << dumpSection("spi", cfg_.spiDevices, cfg_.spiPresets) << ",";

    root << "\"defaults\":{";
    root << "\"uart_baud\":" << cfg_.uartDefaultBaud << ",";
    root << "\"bt_channel\":" << cfg_.btDefaultChannel << ",";
    root << "\"net_port\":" << cfg_.netDefaultPort << ",";
    root << "\"net_udp\":" << (cfg_.netDefaultUdp ? "true" : "false") << ",";
    root << "\"scan_uart\":" << (cfg_.scanUart ? "true" : "false") << ",";
    root << "\"scan_usb\":" << (cfg_.scanUsb ? "true" : "false") << ",";
    root << "\"scan_bluetooth\":" << (cfg_.scanBluetooth ? "true" : "false") << ",";
    root << "\"scan_i2c\":" << (cfg_.scanI2c ? "true" : "false") << ",";
    root << "\"scan_spi\":" << (cfg_.scanSpi ? "true" : "false");
    root << "}";

    root << "}";
    return root.str();
}

std::string CommsManager::historyJson(size_t limit) const
{
    std::lock_guard<std::mutex> lk(histMutex_);

    const size_t n = std::min(limit, history_.size());
    const size_t start = (history_.size() > n) ? (history_.size() - n) : 0;

    std::ostringstream oss;
    oss << "{";
    oss << "\"items\":[";
    for (size_t i = start; i < history_.size(); ++i) {
        const auto& it = history_[i];
        if (i != start) oss << ",";
        oss << "{";
        oss << "\"ts_ms\":" << it.tsMs << ",";
        oss << "\"dir\":\"" << jsonEscape_(it.dir) << "\",";
        oss << "\"transport\":\"" << jsonEscape_(it.transport) << "\",";
        oss << "\"device\":\"" << jsonEscape_(it.device) << "\",";
        oss << "\"encoding\":\"" << jsonEscape_(it.encoding) << "\",";
        oss << "\"data\":\"" << jsonEscape_(it.data) << "\"";
        oss << "}";
    }
    oss << "]";
    oss << "}";
    return oss.str();
}

static std::string transportToStr(Transport t)
{
    switch (t) {
    case Transport::Usb: return "usb";
    case Transport::Bluetooth: return "bluetooth";
    case Transport::Wifi: return "wifi";
    case Transport::Ethernet: return "ethernet";
    case Transport::I2c: return "i2c";
    case Transport::Spi: return "spi";
    default: return "uart";
    }
}

bool CommsManager::send(const SendRequest& req, std::string* err)
{
    ReplyOptions ro;
    ro.expectReply = false;
    auto r = sendEx(req, ro);
    if (err) *err = r.error;
    return r.ok;
}

SendResult CommsManager::sendEx(const SendRequest& req, const ReplyOptions& ro)
{
    SendResult res;

    const std::string tStr = transportToStr(req.transport);

    if (trim_(req.deviceSpec).empty()) {
        res.ok = false;
        res.error = "missing device spec";
        return res;
    }

    // Build TX bytes
    std::vector<uint8_t> tx;
    {
        const std::string encLower = [&]() {
            std::string e = req.encoding;
            std::transform(e.begin(), e.end(), e.begin(), [](unsigned char c) { return std::tolower(c); });
            return e;
        }();

        if (encLower == "hex") {
            if (!parseHexBytes_(req.payload, tx)) {
                res.ok = false;
                res.error = "invalid hex payload";
                return res;
            }
        } else {
            std::string s = unescapeAscii(req.payload);
            tx.assign(s.begin(), s.end());
        }

        if (req.appendNewline) {
            tx.push_back(static_cast<uint8_t>('\n'));
        }
    }

    // history TX
    {
        HistoryItem h;
        h.tsMs = nowMs_();
        h.dir = "tx";
        h.transport = tStr;
        h.device = req.deviceSpec;
        h.encoding = (req.encoding.empty() ? "ascii" : req.encoding);
        if (h.encoding == "hex") {
            h.data = bytesToHex_(tx.data(), tx.size());
        } else {
            h.data = req.payload;
        }
        pushHistory_(std::move(h));
    }

    // Open link + send
    std::vector<uint8_t> rx;
    std::string replyAscii;

    try {
        if (req.transport == Transport::Uart || req.transport == Transport::Usb) {
            std::string port;
            int baud = cfg_.uartDefaultBaud;
            if (!parseUartSpec_(cfg_, req.deviceSpec, port, baud)) {
                res.ok = false;
                res.error = "bad uart spec";
                return res;
            }
#if !defined(_WIN32)
            if ((port == "/dev/serial0" || port == "/dev/ttyS0") && baud != 115200) {
                res.ok = false;
                res.error = "/dev/serial0 must be opened at 115200 bauds for motherboard UART";
                return res;
            }
#endif
            const std::string key = port + "@" + std::to_string(baud);

            jc_uart::Uart* link = nullptr;
            {
                std::lock_guard<std::mutex> lk(m_);
                auto& serialMap = (req.transport == Transport::Usb) ? usb_ : uart_;
                auto it = serialMap.find(key);
                if (it == serialMap.end() || !it->second.isOpen()) {
                    jc_uart::UartConfig uc;
                    uc.port = port;
                    uc.baudrate = baud;
                    uc.readTimeoutMs = 50;
                    uc.writeTimeoutMs = 200;
                    jc_uart::Uart u;
                    if (!u.open(uc)) {
                        res.ok = false;
                        res.error = "UART open failed: " + key;
                        return res;
                    }
                    serialMap[key] = std::move(u);
                    it = serialMap.find(key);
                }
                link = &it->second;
            }

            if (ro.clearRxBeforeSend) {
                link->flush();
            }

            const int w = link->writeBytes(tx.data(), tx.size());
            if (w != static_cast<int>(tx.size())) {
                res.ok = false;
                res.error = "UART write failed";
                return res;
            }
            res.ok = true;

            if (ro.expectReply) {
                const std::string modeLower = [&]() {
                    std::string m = ro.mode;
                    std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return std::tolower(c); });
                    return m;
                }();

                if (modeLower == "packet") {
                    jc_uart::Uart::Packet pkt;
                    if (link->receivePacket(pkt, ro.timeoutMs)) {
                        rx.clear();
                        rx.push_back(pkt.type);
                        rx.insert(rx.end(), pkt.payload.begin(), pkt.payload.end());
                        std::ostringstream oss;
                        oss << "packet type=0x" << std::hex << std::uppercase << int(pkt.type)
                            << " payload=" << bytesToHex_(pkt.payload.data(), pkt.payload.size());
                        replyAscii = oss.str();
                    }
                } else if (modeLower == "bytes") {
                    rx.resize(std::max<size_t>(1, ro.maxBytes));
                    const int n = link->readBytes(rx.data(), rx.size(), ro.timeoutMs);
                    if (n > 0) {
                        rx.resize(static_cast<size_t>(n));
                        replyAscii.assign(rx.begin(), rx.end());
                    } else {
                        rx.clear();
                    }
                } else {
                    std::string line;
                    if (link->readLine(line, '\n', ro.timeoutMs, ro.maxBytes)) {
                        replyAscii = line;
                        rx.assign(line.begin(), line.end());
                    }
                }
            }
        }
        else if (req.transport == Transport::Bluetooth) {
            std::string mac;
            int channel = cfg_.btDefaultChannel;
            if (!parseBtSpec_(cfg_, req.deviceSpec, mac, channel)) {
                res.ok = false;
                res.error = "bad bluetooth spec";
                return res;
            }
            const std::string key = mac + "#" + std::to_string(channel);

            jc_bluetooth::BluetoothLink* link = nullptr;
            {
                std::lock_guard<std::mutex> lk(m_);
                auto it = bt_.find(key);
                if (it == bt_.end() || !it->second.isOpen()) {
                    jc_bluetooth::BluetoothConfig bc;
                    bc.mode = jc_bluetooth::BluetoothMode::Client;
                    bc.remoteAddress = mac;
                    bc.channel = static_cast<uint8_t>(channel);
                    bc.readTimeoutMs = 100;
                    bc.writeTimeoutMs = 200;
                    jc_bluetooth::BluetoothLink b;
                    if (!b.open(bc)) {
                        res.ok = false;
                        res.error = "Bluetooth open failed: " + key;
                        return res;
                    }
                    bt_[key] = std::move(b);
                    it = bt_.find(key);
                }
                link = &it->second;
            }

            // NOTE: pas de flush RX pour BT (pas d'API dédiée) -> on ignore
            const int w = link->writeBytes(tx.data(), tx.size());
            if (w != static_cast<int>(tx.size())) {
                res.ok = false;
                res.error = "Bluetooth write failed";
                return res;
            }
            res.ok = true;

            if (ro.expectReply) {
                const std::string modeLower = [&]() {
                    std::string m = ro.mode;
                    std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return std::tolower(c); });
                    return m;
                }();

                if (modeLower == "packet") {
                    jc_bluetooth::BluetoothLink::Packet pkt;
                    if (link->receivePacket(pkt, ro.timeoutMs)) {
                        rx.clear();
                        rx.push_back(pkt.type);
                        rx.insert(rx.end(), pkt.payload.begin(), pkt.payload.end());
                        std::ostringstream oss;
                        oss << "packet type=0x" << std::hex << std::uppercase << int(pkt.type)
                            << " payload=" << bytesToHex_(pkt.payload.data(), pkt.payload.size());
                        replyAscii = oss.str();
                    }
                } else if (modeLower == "bytes") {
                    rx.resize(std::max<size_t>(1, ro.maxBytes));
                    const int n = link->readBytes(rx.data(), rx.size(), ro.timeoutMs);
                    if (n > 0) {
                        rx.resize(static_cast<size_t>(n));
                        replyAscii.assign(rx.begin(), rx.end());
                    } else {
                        rx.clear();
                    }
                } else {
                    std::string line;
                    if (link->readLine(line, '\n', ro.timeoutMs, ro.maxBytes)) {
                        replyAscii = line;
                        rx.assign(line.begin(), line.end());
                    }
                }
            }
        }
        else if (req.transport == Transport::Wifi || req.transport == Transport::Ethernet) {
            NetSpec ns;
            if (!parseNetSpec_(cfg_, req.deviceSpec, ns)) {
                res.ok = false;
                res.error = "bad network spec";
                return res;
            }
            const std::string key = (ns.udp ? "udp://" : "tcp://") + ns.host + ":" + std::to_string(ns.port);

            if (req.transport == Transport::Wifi) {
                jc_wifi::WifiLink* link = nullptr;
                {
                    std::lock_guard<std::mutex> lk(m_);
                    auto it = wifi_.find(key);
                    if (it == wifi_.end() || !it->second.isOpen()) {
                        jc_wifi::WifiConfig wc;
                        wc.protocol = ns.udp ? jc_wifi::WifiProtocol::UDP : jc_wifi::WifiProtocol::TCP;
                        wc.mode = jc_wifi::WifiMode::Client;
                        wc.host = ns.host;
                        wc.port = ns.port;
                        wc.readTimeoutMs = 150;
                        wc.writeTimeoutMs = 200;
                        jc_wifi::WifiLink w;
                        if (!w.open(wc)) {
                            res.ok = false;
                            res.error = "WiFi open failed: " + key;
                            return res;
                        }
                        wifi_[key] = std::move(w);
                        it = wifi_.find(key);
                    }
                    link = &it->second;
                }

                const int w = link->writeBytes(tx.data(), tx.size());
                if (w != static_cast<int>(tx.size())) {
                    res.ok = false;
                    res.error = "WiFi write failed";
                    return res;
                }
                res.ok = true;

                if (ro.expectReply) {
                    const std::string modeLower = [&]() {
                        std::string m = ro.mode;
                        std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return std::tolower(c); });
                        return m;
                    }();

                    if (modeLower == "packet") {
                        jc_wifi::WifiLink::Packet pkt;
                        if (link->receivePacket(pkt, ro.timeoutMs)) {
                            rx.clear();
                            rx.push_back(pkt.type);
                            rx.insert(rx.end(), pkt.payload.begin(), pkt.payload.end());
                            std::ostringstream oss;
                            oss << "packet type=0x" << std::hex << std::uppercase << int(pkt.type)
                                << " payload=" << bytesToHex_(pkt.payload.data(), pkt.payload.size());
                            replyAscii = oss.str();
                        }
                    } else if (modeLower == "bytes") {
                        rx.resize(std::max<size_t>(1, ro.maxBytes));
                        const int n = link->readBytes(rx.data(), rx.size(), ro.timeoutMs);
                        if (n > 0) {
                            rx.resize(static_cast<size_t>(n));
                            replyAscii.assign(rx.begin(), rx.end());
                        } else {
                            rx.clear();
                        }
                    } else {
                        std::string line;
                        if (link->readLine(line, '\n', ro.timeoutMs, ro.maxBytes)) {
                            replyAscii = line;
                            rx.assign(line.begin(), line.end());
                        }
                    }
                }
            }
            else {
                jc_ethernet::EthernetLink* link = nullptr;
                {
                    std::lock_guard<std::mutex> lk(m_);
                    auto it = eth_.find(key);
                    if (it == eth_.end() || !it->second.isOpen()) {
                        jc_ethernet::EthernetConfig ec;
                        ec.protocol = ns.udp ? jc_ethernet::EthernetProtocol::UDP : jc_ethernet::EthernetProtocol::TCP;
                        ec.mode = jc_ethernet::EthernetMode::Client;
                        ec.host = ns.host;
                        ec.port = ns.port;
                        ec.readTimeoutMs = 150;
                        ec.writeTimeoutMs = 200;
                        jc_ethernet::EthernetLink e;
                        if (!e.open(ec)) {
                            res.ok = false;
                            res.error = "Ethernet open failed: " + key;
                            return res;
                        }
                        eth_[key] = std::move(e);
                        it = eth_.find(key);
                    }
                    link = &it->second;
                }

                const int w = link->writeBytes(tx.data(), tx.size());
                if (w != static_cast<int>(tx.size())) {
                    res.ok = false;
                    res.error = "Ethernet write failed";
                    return res;
                }
                res.ok = true;

                if (ro.expectReply) {
                    const std::string modeLower = [&]() {
                        std::string m = ro.mode;
                        std::transform(m.begin(), m.end(), m.begin(), [](unsigned char c) { return std::tolower(c); });
                        return m;
                    }();

                    if (modeLower == "packet") {
                        jc_ethernet::EthernetLink::Packet pkt;
                        if (link->receivePacket(pkt, ro.timeoutMs)) {
                            rx.clear();
                            rx.push_back(pkt.type);
                            rx.insert(rx.end(), pkt.payload.begin(), pkt.payload.end());
                            std::ostringstream oss;
                            oss << "packet type=0x" << std::hex << std::uppercase << int(pkt.type)
                                << " payload=" << bytesToHex_(pkt.payload.data(), pkt.payload.size());
                            replyAscii = oss.str();
                        }
                    } else if (modeLower == "bytes") {
                        rx.resize(std::max<size_t>(1, ro.maxBytes));
                        const int n = link->readBytes(rx.data(), rx.size(), ro.timeoutMs);
                        if (n > 0) {
                            rx.resize(static_cast<size_t>(n));
                            replyAscii.assign(rx.begin(), rx.end());
                        } else {
                            rx.clear();
                        }
                    } else {
                        std::string line;
                        if (link->readLine(line, '\n', ro.timeoutMs, ro.maxBytes)) {
                            replyAscii = line;
                            rx.assign(line.begin(), line.end());
                        }
                    }
                }
            }
        }
        else if (req.transport == Transport::I2c) {
            std::string dev; uint16_t addr = 0x42;
            if (!parseI2cSpec_(req.deviceSpec, dev, addr)) { res.ok = false; res.error = "bad i2c spec"; return res; }
            const std::string key = dev + "@0x" + bytesToHex_(reinterpret_cast<const uint8_t*>(&addr), sizeof(addr));
            jc_i2c::I2cDevice* link = nullptr;
            {
                std::lock_guard<std::mutex> lk(m_);
                auto it = i2c_.find(key);
                if (it == i2c_.end() || !it->second.isOpen()) {
                    jc_i2c::I2cConfig ic; ic.device = dev; ic.slaveAddress = addr; ic.timeoutMs = std::clamp(ro.timeoutMs, 10, 1000);
                    jc_i2c::I2cDevice d; if (!d.open(ic)) { res.ok = false; res.error = "I2C open failed: " + dev; return res; }
                    i2c_[key] = std::move(d); it = i2c_.find(key);
                }
                link = &it->second;
            }
            if (ro.expectReply) {
                rx.resize(std::max<size_t>(1, ro.maxBytes));
                bool ok = false;
                if (!tx.empty()) ok = link->writeThenRead(tx.data(), tx.size(), rx.data(), rx.size());
                else ok = (link->readBytes(rx.data(), rx.size()) >= 0);
                if (!ok) { res.ok = false; res.error = "I2C transfer failed"; return res; }
                replyAscii.assign(rx.begin(), rx.end());
            } else {
                const int w = link->writeBytes(tx.data(), tx.size());
                if (w != static_cast<int>(tx.size())) { res.ok = false; res.error = "I2C write failed"; return res; }
            }
            res.ok = true;
        }
        else if (req.transport == Transport::Spi) {
            std::string dev; uint32_t speed = 1000000; uint8_t mode = 0, bits = 8;
            if (!parseSpiSpec_(req.deviceSpec, dev, speed, mode, bits)) { res.ok = false; res.error = "bad spi spec"; return res; }
            const std::string key = dev + "@" + std::to_string(speed) + "#" + std::to_string(mode) + "+" + std::to_string(bits);
            jc_spi::SpiDevice* link = nullptr;
            {
                std::lock_guard<std::mutex> lk(m_);
                auto it = spi_.find(key);
                if (it == spi_.end() || !it->second.isOpen()) {
                    jc_spi::SpiConfig sc; sc.device = dev; sc.speedHz = speed; sc.mode = mode; sc.bitsPerWord = bits;
                    jc_spi::SpiDevice d; if (!d.open(sc)) { res.ok = false; res.error = "SPI open failed: " + dev; return res; }
                    spi_[key] = std::move(d); it = spi_.find(key);
                }
                link = &it->second;
            }
            if (ro.expectReply) {
                if (tx.empty()) {
                    rx.resize(std::max<size_t>(1, ro.maxBytes));
                    if (link->readBytes(rx.data(), rx.size()) != static_cast<int>(rx.size())) { res.ok = false; res.error = "SPI read failed"; return res; }
                } else {
                    if (!link->transfer(tx, rx)) { res.ok = false; res.error = "SPI transfer failed"; return res; }
                }
                replyAscii.assign(rx.begin(), rx.end());
            } else {
                const int w = link->writeBytes(tx.data(), tx.size());
                if (w != static_cast<int>(tx.size())) { res.ok = false; res.error = "SPI write failed"; return res; }
            }
            res.ok = true;
        }
        else {
            res.ok = false;
            res.error = "unknown transport";
            return res;
        }
    }
    catch (const std::exception& ex) {
        res.ok = false;
        res.error = ex.what();
        return res;
    }

    if (ro.expectReply && !rx.empty()) {
        res.haveReply = true;
        res.replyAscii = replyAscii;
        res.replyHex = bytesToHex_(rx.data(), rx.size());

        HistoryItem h;
        h.tsMs = nowMs_();
        h.dir = "rx";
        h.transport = tStr;
        h.device = req.deviceSpec;
        h.encoding = "hex";
        h.data = res.replyHex;
        pushHistory_(std::move(h));
    }

    return res;
}

void CommsManager::closeAll()
{
    std::lock_guard<std::mutex> lk(m_);
    for (auto& [_, u] : uart_) u.close();
    for (auto& [_, u] : usb_) u.close();
    for (auto& [_, b] : bt_) b.close();
    for (auto& [_, w] : wifi_) w.close();
    for (auto& [_, e] : eth_) e.close();
    for (auto& [_, d] : i2c_) d.close();
    for (auto& [_, d] : spi_) d.close();

    uart_.clear();
    usb_.clear();
    bt_.clear();
    wifi_.clear();
    eth_.clear();
    i2c_.clear();
    spi_.clear();
}

} // namespace jc_comms
