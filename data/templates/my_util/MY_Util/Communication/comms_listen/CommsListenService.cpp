#include "CommsListenService.h"

#include "../uart/uart.h"
#include "../bluetooth/bluetooth.h"
#include "../I2C/I2C.h"
#include "../SPI/SPI.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <filesystem>
#include <sstream>
#include <thread>

#if defined(_WIN32)
  #define NOMINMAX
  #include <winsock2.h>
  #include <ws2tcpip.h>
  #pragma comment(lib, "ws2_32.lib")
#else
  #include <arpa/inet.h>
  #include <errno.h>
  #include <fcntl.h>
  #include <netdb.h>
  #include <netinet/in.h>
  #include <sys/select.h>
  #include <sys/socket.h>
  #include <unistd.h>
#endif

namespace jc_comms_listen {

namespace {

static std::string trim_(std::string s)
{
    auto isSpace = [](unsigned char c) { return std::isspace(c) != 0; };
    while (!s.empty() && isSpace((unsigned char)s.front())) s.erase(s.begin());
    while (!s.empty() && isSpace((unsigned char)s.back())) s.pop_back();
    return s;
}

static std::string lower_(std::string s)
{
    for (auto& c : s) c = (char)std::tolower((unsigned char)c);
    return s;
}

#if defined(_WIN32)
using socket_t = SOCKET;
static constexpr socket_t kInvalidSocket = INVALID_SOCKET;
static void closeSock(socket_t& s) { if (s != kInvalidSocket) { closesocket(s); s = kInvalidSocket; } }
static bool wsaInitOnce()
{
    static std::atomic<bool> inited{false};
    static std::mutex mx;
    if (inited.load()) return true;
    std::lock_guard<std::mutex> lk(mx);
    if (inited.load()) return true;
    WSADATA w;
    if (WSAStartup(MAKEWORD(2,2), &w) != 0) return false;
    inited.store(true);
    return true;
}
#else
using socket_t = int;
static constexpr socket_t kInvalidSocket = -1;
static void closeSock(socket_t& s) { if (s != kInvalidSocket) { ::close(s); s = kInvalidSocket; } }
#endif

static bool setReuseAddr(socket_t s)
{
    int opt = 1;
#if defined(_WIN32)
    return setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char*)&opt, sizeof(opt)) == 0;
#else
    return setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt)) == 0;
#endif
}

static bool setNonBlocking(socket_t s, bool nb)
{
#if defined(_WIN32)
    u_long mode = nb ? 1 : 0;
    return ioctlsocket(s, FIONBIO, &mode) == 0;
#else
    int flags = fcntl(s, F_GETFL, 0);
    if (flags < 0) return false;
    if (nb) flags |= O_NONBLOCK;
    else flags &= ~O_NONBLOCK;
    return fcntl(s, F_SETFL, flags) == 0;
#endif
}

static bool waitReadable(socket_t s, int timeoutMs)
{
    if (s == kInvalidSocket) return false;
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(s, &rfds);

    timeval tv;
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;

#if defined(_WIN32)
    int ret = select(0, &rfds, nullptr, nullptr, &tv);
#else
    int ret = select(s + 1, &rfds, nullptr, nullptr, &tv);
#endif
    return ret > 0 && FD_ISSET(s, &rfds);
}

static std::string sockaddrToString(const sockaddr_in& a)
{
    char buf[64] = {0};
    const char* ip = inet_ntop(AF_INET, (void*)&a.sin_addr, buf, sizeof(buf));
    std::ostringstream oss;
    oss << (ip ? ip : "?") << ":" << ntohs(a.sin_port);
    return oss.str();
}

static std::string jsonEsc_(const std::string& s)
{
    std::ostringstream o;
    for (char c : s) { if (c == '"' || c == '\\') o << '\\'; o << c; }
    return o.str();
}

} // namespace

CommsListenService::CommsListenService() = default;

CommsListenService::~CommsListenService()
{
    stop();
}

void CommsListenService::setEventCallback(EventCallback cb)
{
    std::lock_guard<std::mutex> lk(m_);
    eventCb_ = std::move(cb);
}

bool CommsListenService::start(const ListenRequest& req, std::string* errOut)
{
    stop();

    {
        std::lock_guard<std::mutex> lk(m_);
        req_ = req;
        st_ = ListenStatus{};
        st_.running = true;
        st_.connected = false;
        st_.peer = "";
        st_.error = "";
    }

    if (req.deviceSpec.empty()) {
        setError_("deviceSpec empty");
        if (errOut) *errOut = "deviceSpec empty";
        return false;
    }

    stopFlag_.store(false);
    running_.store(true);

    th_ = std::thread(&CommsListenService::threadMain_, this);
    emit_({ nowMs_(), "info", transportToString_(req.transport), req.deviceSpec, "ascii", "listen started" });
    return true;
}

void CommsListenService::stop()
{
    stopFlag_.store(true);
    if (th_.joinable()) th_.join();
    running_.store(false);

    {
        std::lock_guard<std::mutex> lk(m_);
        st_.running = false;
        st_.connected = false;
        st_.peer.clear();
    }
}

ListenStatus CommsListenService::status() const
{
    std::lock_guard<std::mutex> lk(m_);
    ListenStatus out = st_;
    out.running = running_.load();
    return out;
}

std::string CommsListenService::statusJson() const
{
    const auto st = status();
    std::ostringstream oss;
    oss << "{";
    oss << "\"running\":" << (st.running ? "true" : "false") << ",";
    oss << "\"connected\":" << (st.connected ? "true" : "false") << ",";
    oss << "\"peer\":\"" << jsonEsc_(st.peer) << "\",";
    oss << "\"rx_count\":" << st.rxCount << ",";
    oss << "\"tx_count\":" << st.txCount << ",";
    oss << "\"last_rx_ts_ms\":" << st.lastRxTsMs << ",";
    oss << "\"error\":\"" << jsonEsc_(st.error) << "\"";
    oss << "}";
    return oss.str();
}

uint64_t CommsListenService::nowMs_()
{
    using namespace std::chrono;
    return (uint64_t)duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

std::string CommsListenService::transportToString_(Transport t)
{
    switch (t) {
    case Transport::Uart: return "uart";
    case Transport::Usb: return "usb";
    case Transport::Bluetooth: return "bluetooth";
    case Transport::Wifi: return "wifi";
    case Transport::Ethernet: return "ethernet";
    case Transport::I2c: return "i2c";
    case Transport::Spi: return "spi";
    default: return "unknown";
    }
}

void CommsListenService::setError_(const std::string& err)
{
    std::lock_guard<std::mutex> lk(m_);
    st_.error = err;
}

void CommsListenService::setConnected_(bool connected, const std::string& peer)
{
    std::lock_guard<std::mutex> lk(m_);
    st_.connected = connected;
    st_.peer = peer;
}

void CommsListenService::bumpRx_(uint64_t tsMs)
{
    std::lock_guard<std::mutex> lk(m_);
    st_.rxCount++;
    st_.lastRxTsMs = tsMs;
}

void CommsListenService::bumpTx_()
{
    std::lock_guard<std::mutex> lk(m_);
    st_.txCount++;
}

void CommsListenService::emit_(ListenEvent ev)
{
    EventCallback cb;
    {
        std::lock_guard<std::mutex> lk(m_);
        cb = eventCb_;
    }
    if (cb) cb(ev);
}

bool CommsListenService::parseUartSpec_(const std::string& spec, std::string& portOut, int& baudOut)
{
    auto s = trim_(spec);
    baudOut = 115200;
    const auto at = s.find('@');
    if (at != std::string::npos) {
        portOut = s.substr(0, at);
        try { baudOut = std::stoi(s.substr(at + 1)); } catch (...) { baudOut = 115200; }
    } else {
        portOut = s;
    }
    portOut = trim_(portOut);
    return !portOut.empty();
}

bool CommsListenService::parseBtSpec_(const std::string& spec, bool& server, std::string& addr, int& channel)
{
    std::string s = lower_(trim_(spec));
    server = false;
    channel = 1;
    addr.clear();

    std::string raw = trim_(spec);
    const auto hash = raw.find('#');
    if (hash != std::string::npos) {
        try { channel = std::stoi(raw.substr(hash + 1)); } catch (...) { channel = 1; }
        raw = raw.substr(0, hash);
    }

    std::string rawLower = lower_(trim_(raw));
    if (rawLower.rfind("server", 0) == 0) {
        server = true;
        addr.clear();
    } else if (rawLower.rfind("client:", 0) == 0) {
        server = false;
        addr = trim_(raw.substr(7));
    } else {
        if (raw.find(':') != std::string::npos) {
            server = false;
            addr = trim_(raw);
        } else {
            server = true;
        }
    }

    return channel >= 1 && channel <= 30;
}

bool CommsListenService::parseNetSpec_(const std::string& spec, std::string& proto, std::string& host, int& port)
{
    std::string s = trim_(spec);
    proto = "tcp";
    host = "0.0.0.0";
    port = 5000;

    auto lowerS = lower_(s);
    if (lowerS.rfind("tcp://", 0) == 0) {
        proto = "tcp";
        s = s.substr(6);
    } else if (lowerS.rfind("udp://", 0) == 0) {
        proto = "udp";
        s = s.substr(6);
    }

    const auto colon = s.rfind(':');
    if (colon == std::string::npos) return false;

    host = trim_(s.substr(0, colon));
    try { port = std::stoi(trim_(s.substr(colon + 1))); } catch (...) { return false; }
    if (host.empty()) host = "0.0.0.0";
    if (port < 1 || port > 65535) return false;
    return true;
}

bool CommsListenService::parseI2cSpec_(const std::string& spec, std::string& deviceOut, uint16_t& addrOut)
{
    std::string s = trim_(spec);
    deviceOut = "/dev/i2c-1";
    addrOut = 0x42;
    const auto at = s.find('@');
    if (at == std::string::npos) return false;
    deviceOut = trim_(s.substr(0, at));
    std::string a = lower_(trim_(s.substr(at + 1)));
    try {
        addrOut = (uint16_t)std::stoul(a, nullptr, 0);
    } catch (...) { return false; }
    return !deviceOut.empty();
}

bool CommsListenService::parseSpiSpec_(const std::string& spec, std::string& deviceOut, uint32_t& speedOut, uint8_t& modeOut, uint8_t& bitsOut)
{
    std::string s = trim_(spec);
    deviceOut = "/dev/spidev0.0";
    speedOut = 1000000;
    modeOut = 0;
    bitsOut = 8;

    auto at = s.find('@');
    auto hash = s.find('#');
    auto plus = s.find('+');

    size_t cut = std::min({ at == std::string::npos ? s.size() : at,
                            hash == std::string::npos ? s.size() : hash,
                            plus == std::string::npos ? s.size() : plus });
    deviceOut = trim_(s.substr(0, cut));
    if (deviceOut.empty()) return false;

    if (at != std::string::npos) {
        size_t end = std::min(hash == std::string::npos ? s.size() : hash,
                              plus == std::string::npos ? s.size() : plus);
        try { speedOut = (uint32_t)std::stoul(trim_(s.substr(at + 1, end - at - 1))); } catch (...) { speedOut = 1000000; }
    }
    if (hash != std::string::npos) {
        size_t end = plus == std::string::npos ? s.size() : plus;
        try { modeOut = (uint8_t)std::stoul(trim_(s.substr(hash + 1, end - hash - 1))); } catch (...) { modeOut = 0; }
        modeOut &= 0x03u;
    }
    if (plus != std::string::npos) {
        try { bitsOut = (uint8_t)std::stoul(trim_(s.substr(plus + 1))); } catch (...) { bitsOut = 8; }
    }
    return true;
}

std::vector<uint8_t> CommsListenService::parseHexBytes_(const std::string& s, bool* ok)
{
    std::vector<uint8_t> out;
    bool success = true;
    int hi = -1;

    auto pushNibble = [&](int nib) {
        if (hi < 0) hi = nib;
        else {
            out.push_back((uint8_t)((hi << 4) | nib));
            hi = -1;
        }
    };

    for (char c : s) {
        if (c == 'x' || c == 'X') continue;
        if (std::isspace((unsigned char)c) || c == ',' || c == ';' || c == '-') continue;
        int v = -1;
        if (c >= '0' && c <= '9') v = c - '0';
        else if (c >= 'a' && c <= 'f') v = 10 + (c - 'a');
        else if (c >= 'A' && c <= 'F') v = 10 + (c - 'A');
        else { success = false; break; }
        pushNibble(v);
    }
    if (hi >= 0) success = false;

    if (ok) *ok = success;
    if (!success) out.clear();
    return out;
}

std::string CommsListenService::bytesToHex_(const uint8_t* data, size_t n)
{
    std::ostringstream oss;
    oss << std::hex;
    for (size_t i = 0; i < n; ++i) {
        int v = (int)data[i];
        if (i) oss << ' ';
        oss << "0x";
        oss.width(2);
        oss.fill('0');
        oss << (v & 0xFF);
    }
    return oss.str();
}

std::string CommsListenService::bytesToAsciiSafe_(const uint8_t* data, size_t n)
{
    std::string out;
    out.reserve(n);
    for (size_t i = 0; i < n; ++i) {
        char c = (char)data[i];
        if (c == '\r') continue;
        if (c == '\n') { out.push_back('\n'); continue; }
        if ((unsigned char)c >= 32 && (unsigned char)c <= 126) out.push_back(c);
        else out.push_back('.');
    }
    return out;
}

std::vector<uint8_t> CommsListenService::buildReply_(const ListenRequest& r,
                                                     const uint8_t* rxData,
                                                     size_t rxSize,
                                                     bool* ok)
{
    if (ok) *ok = true;

    if (!r.autoReply) {
        if (ok) *ok = false;
        return {};
    }

    if (r.echoReply) {
        std::vector<uint8_t> out(rxData, rxData + rxSize);
        if (r.replyAppendNewline) out.push_back((uint8_t)'\n');
        return out;
    }

    const std::string enc = lower_(trim_(r.replyEncoding));
    if (enc == "hex") {
        bool hexOk = false;
        auto bytes = parseHexBytes_(r.replyPayload, &hexOk);
        if (!hexOk) {
            if (ok) *ok = false;
            return {};
        }
        if (r.replyAppendNewline) bytes.push_back((uint8_t)'\n');
        return bytes;
    }

    std::vector<uint8_t> out(r.replyPayload.begin(), r.replyPayload.end());
    if (r.replyAppendNewline) out.push_back((uint8_t)'\n');
    return out;
}

std::vector<uint8_t> CommsListenService::buildPollRequest_(const ListenRequest& r, bool* ok)
{
    if (ok) *ok = true;
    if (trim_(r.pollTxPayload).empty()) return {};
    const std::string enc = lower_(trim_(r.pollTxEncoding));
    if (enc == "ascii") return std::vector<uint8_t>(r.pollTxPayload.begin(), r.pollTxPayload.end());
    bool hexOk = false;
    auto bytes = parseHexBytes_(r.pollTxPayload, &hexOk);
    if (!hexOk) {
        if (ok) *ok = false;
        return {};
    }
    return bytes;
}

std::string CommsListenService::scanJson()
{
    std::vector<std::string> uarts;
    std::vector<std::string> usbs;
    std::vector<std::string> i2cs;
    std::vector<std::string> spis;

#if !defined(_WIN32)
    try {
        for (const auto& entry : std::filesystem::directory_iterator("/dev")) {
            const auto name = entry.path().filename().string();
            if (name.rfind("ttyUSB", 0) == 0 || name.rfind("ttyACM", 0) == 0) {
                usbs.push_back("/dev/" + name);
            }
            else if (name.rfind("ttyAMA", 0) == 0 || name.rfind("ttyS", 0) == 0) {
                uarts.push_back("/dev/" + name);
            }
            if (name.rfind("i2c-", 0) == 0) {
                i2cs.push_back("/dev/" + name);
            }
            if (name.rfind("spidev", 0) == 0) {
                spis.push_back("/dev/" + name);
            }
        }
        const std::filesystem::path byId("/dev/serial/by-id");
        if (std::filesystem::exists(byId)) {
            for (const auto& entry : std::filesystem::directory_iterator(byId)) {
                usbs.push_back(entry.path().string());
            }
        }
        if (std::filesystem::exists("/dev/serial0")) uarts.push_back("/dev/serial0");
        if (std::filesystem::exists("/dev/serial1")) uarts.push_back("/dev/serial1");
    } catch (...) {}
#endif

    std::ostringstream oss;
    oss << "{";

    auto writeDevices = [&](const char* key, const std::vector<std::pair<std::string,std::string>>& devs, bool commaAfter) {
        oss << "\"" << key << "\":{";
        oss << "\"devices\":[";
        for (size_t i = 0; i < devs.size(); ++i) {
            if (i) oss << ',';
            oss << "{\"name\":\"" << jsonEsc_(devs[i].first) << "\",\"spec\":\"" << jsonEsc_(devs[i].second) << "\",\"source\":\"scan\"}";
        }
        oss << "]}";
        if (commaAfter) oss << ',';
    };

    std::vector<std::pair<std::string,std::string>> uartDevs;
    for (const auto& d : uarts) {
        // GPIO UART Raspberry Pi (serial0/serial1) : utilise par la carte mere.
        // Le baudrate du protocole carte mere est 115200. Ne pas proposer 460800 ici,
        // car ouvrir /dev/serial0 a 460800 depuis Comms Listen reconfigure le port
        // et rend les trames envoyees par le mode autonome illisibles cote Arduino.
        uartDevs.push_back({d, d + "@115200"});
    }
    writeDevices("uart", uartDevs, true);

    std::vector<std::pair<std::string,std::string>> usbDevs;
    for (const auto& d : usbs) usbDevs.push_back({d, d + "@460800"});
    writeDevices("usb", usbDevs, true);

    oss << "\"bluetooth\":{\"devices\":[{\"name\":\"BT server ch1\",\"spec\":\"server#1\",\"source\":\"default\"}]},";
    oss << "\"wifi\":{\"devices\":[{\"name\":\"TCP server 0.0.0.0:5000\",\"spec\":\"tcp://0.0.0.0:5000\",\"source\":\"default\"},{\"name\":\"UDP server 0.0.0.0:5000\",\"spec\":\"udp://0.0.0.0:5000\",\"source\":\"default\"}]},";
    oss << "\"ethernet\":{\"devices\":[{\"name\":\"TCP server 0.0.0.0:5000\",\"spec\":\"tcp://0.0.0.0:5000\",\"source\":\"default\"},{\"name\":\"UDP server 0.0.0.0:5000\",\"spec\":\"udp://0.0.0.0:5000\",\"source\":\"default\"}]},";

    std::vector<std::pair<std::string,std::string>> i2cDevs;
    if (i2cs.empty()) i2cDevs.push_back({"/dev/i2c-1", "/dev/i2c-1@0x42"});
    else for (const auto& d : i2cs) i2cDevs.push_back({d, d + "@0x42"});
    writeDevices("i2c", i2cDevs, true);

    std::vector<std::pair<std::string,std::string>> spiDevs;
    if (spis.empty()) spiDevs.push_back({"/dev/spidev0.0", "/dev/spidev0.0@1000000#0+8"});
    else for (const auto& d : spis) spiDevs.push_back({d, d + "@1000000#0+8"});
    writeDevices("spi", spiDevs, false);

    oss << "}";
    return oss.str();
}

void CommsListenService::threadMain_()
{
    ListenRequest req;
    {
        std::lock_guard<std::mutex> lk(m_);
        req = req_;
    }

#if defined(_WIN32)
    (void)wsaInitOnce();
#endif

    const std::string tr = transportToString_(req.transport);
    auto rxMode = lower_(trim_(req.rxMode));
    if (rxMode != "line" && rxMode != "bytes" && rxMode != "packet") rxMode = "bytes";

    // ---------------- UART ----------------
    if (req.transport == Transport::Uart || req.transport == Transport::Usb)
    {
        std::string port;
        int baud = 115200;
        if (!parseUartSpec_(req.deviceSpec, port, baud)) {
            setError_("invalid uart spec");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid uart spec" });
            return;
        }

#if !defined(_WIN32)
        // Protection projet : /dev/serial0 et /dev/ttyS0 sont les broches UART
        // GPIO14/GPIO15 vers la carte mere. Dans notre protocole elles doivent rester
        // en 115200 bauds. Cela evite qu'un onglet Listen ouvert par erreur en 460800
        // casse les trames du mode autonome.
        if ((port == "/dev/serial0" || port == "/dev/ttyS0") && baud != 115200) {
            setError_("/dev/serial0 must be opened at 115200 bauds for motherboard UART");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "/dev/serial0 must be opened at 115200 bauds" });
            return;
        }
#endif

        jc_uart::Uart uart;
        jc_uart::UartConfig cfg;
        cfg.port = port;
        cfg.baudrate = baud;
        cfg.readTimeoutMs = std::max(5, req.pollTimeoutMs);
        cfg.writeTimeoutMs = 50;

        if (!uart.open(cfg)) {
            setError_("uart open failed");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "uart open failed" });
            return;
        }

        setConnected_(true, port);
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "uart connected" });

        while (!stopFlag_.load()) {
            if (rxMode == "line") {
                std::string line;
                if (uart.readLine(line, '\n', req.pollTimeoutMs, std::max<size_t>(16, req.maxBytes))) {
                    const auto ts = nowMs_();
                    bumpRx_(ts);
                    emit_({ ts, "rx", tr, req.deviceSpec, "ascii", line });

                    bool ok = false;
                    auto reply = buildReply_(req, (const uint8_t*)line.data(), line.size(), &ok);
                    if (ok && !reply.empty()) {
                        uart.writeBytes(reply.data(), reply.size());
                        bumpTx_();
                        emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                                (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                                (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                                      : std::string(reply.begin(), reply.end())) });
                    }
                }
            } else if (rxMode == "packet") {
                jc_uart::Uart::Packet pkt;
                if (uart.receivePacket(pkt, req.pollTimeoutMs)) {
                    const auto ts = nowMs_();
                    bumpRx_(ts);
                    std::string s = "type=0x" + bytesToHex_(&pkt.type, 1) + " payload=" + bytesToHex_(pkt.payload.data(), pkt.payload.size());
                    emit_({ ts, "rx", tr, req.deviceSpec, "hex", s });

                    if (req.autoReply) {
                        if (req.echoReply) {
                            uart.sendPacket(pkt.type, pkt.payload);
                            bumpTx_();
                            emit_({ nowMs_(), "tx", tr, req.deviceSpec, "hex", "echo packet" });
                        } else {
                            bool ok = false;
                            auto reply = buildReply_(req, nullptr, 0, &ok);
                            if (ok && !reply.empty()) {
                                uart.writeBytes(reply.data(), reply.size());
                                bumpTx_();
                                emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                                        (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                                        (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                                              : std::string(reply.begin(), reply.end())) });
                            }
                        }
                    }
                }
            } else {
                std::vector<uint8_t> buf(std::max<size_t>(16, req.maxBytes));
                int n = uart.readBytes(buf.data(), buf.size(), req.pollTimeoutMs);
                if (n > 0) {
                    const auto ts = nowMs_();
                    bumpRx_(ts);
                    emit_({ ts, "rx", tr, req.deviceSpec, "hex", bytesToHex_(buf.data(), (size_t)n) });

                    bool ok = false;
                    auto reply = buildReply_(req, buf.data(), (size_t)n, &ok);
                    if (ok && !reply.empty()) {
                        uart.writeBytes(reply.data(), reply.size());
                        bumpTx_();
                        emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                                (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                                (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                                      : std::string(reply.begin(), reply.end())) });
                    }
                }
            }
        }

        uart.close();
        setConnected_(false, "");
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "uart disconnected" });
        return;
    }

    // ---------------- Bluetooth ----------------
    if (req.transport == Transport::Bluetooth)
    {
        bool server = true;
        std::string addr;
        int channel = 1;
        if (!parseBtSpec_(req.deviceSpec, server, addr, channel)) {
            setError_("invalid bluetooth spec");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid bluetooth spec" });
            return;
        }

        jc_bluetooth::BluetoothConfig cfg;
        cfg.channel = (uint8_t)std::clamp(channel, 1, 30);
        cfg.readTimeoutMs = std::max(10, req.pollTimeoutMs);

        if (server) {
            cfg.mode = jc_bluetooth::BluetoothMode::Server;
        } else {
            cfg.mode = jc_bluetooth::BluetoothMode::Client;
            cfg.remoteAddress = addr;
        }

        jc_bluetooth::BluetoothLink bt;
        if (!bt.open(cfg)) {
            setError_("bluetooth open failed (BlueZ?)");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "bluetooth open failed" });
            return;
        }

        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", server ? "bt server started" : "bt client connected" });

        if (server) {
            while (!stopFlag_.load()) {
                if (bt.acceptClient(req.pollTimeoutMs)) {
                    setConnected_(true, bt.peerAddress());
                    emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "bt peer connected" });
                    break;
                }
            }
        } else {
            setConnected_(true, bt.peerAddress());
        }

        while (!stopFlag_.load()) {
            if (server && !bt.hasPeer()) {
                setConnected_(false, "");
                std::this_thread::sleep_for(std::chrono::milliseconds(50));
                continue;
            }

            if (rxMode == "line") {
                std::string line;
                if (bt.readLine(line, '\n', req.pollTimeoutMs, std::max<size_t>(16, req.maxBytes))) {
                    const auto ts = nowMs_();
                    bumpRx_(ts);
                    emit_({ ts, "rx", tr, req.deviceSpec, "ascii", line });

                    bool ok = false;
                    auto reply = buildReply_(req, (const uint8_t*)line.data(), line.size(), &ok);
                    if (ok && !reply.empty()) {
                        bt.writeBytes(reply.data(), reply.size());
                        bumpTx_();
                        emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                                (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                                (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                                      : std::string(reply.begin(), reply.end())) });
                    }
                }
            } else {
                std::vector<uint8_t> buf(std::max<size_t>(16, req.maxBytes));
                int n = bt.readBytes(buf.data(), buf.size(), req.pollTimeoutMs);
                if (n > 0) {
                    const auto ts = nowMs_();
                    bumpRx_(ts);
                    emit_({ ts, "rx", tr, req.deviceSpec, "hex", bytesToHex_(buf.data(), (size_t)n) });

                    bool ok = false;
                    auto reply = buildReply_(req, buf.data(), (size_t)n, &ok);
                    if (ok && !reply.empty()) {
                        bt.writeBytes(reply.data(), reply.size());
                        bumpTx_();
                        emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                                (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                                (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                                      : std::string(reply.begin(), reply.end())) });
                    }
                }
            }
        }

        bt.close();
        setConnected_(false, "");
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "bt stopped" });
        return;
    }

    // ---------------- I2C (master polling) ----------------
    if (req.transport == Transport::I2c)
    {
        std::string dev;
        uint16_t addr = 0;
        if (!parseI2cSpec_(req.deviceSpec, dev, addr)) {
            setError_("invalid i2c spec (/dev/i2c-1@0x42)");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid i2c spec" });
            return;
        }

        jc_i2c::I2cConfig cfg;
        cfg.device = dev;
        cfg.slaveAddress = addr;
        cfg.timeoutMs = std::max(5, req.pollTimeoutMs);

        jc_i2c::I2cDevice i2c;
        if (!i2c.open(cfg)) {
            setError_("i2c open failed");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "i2c open failed" });
            return;
        }

        { std::ostringstream peer; peer << dev << "@0x" << std::hex << (int)addr; setConnected_(true, peer.str()); }
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "i2c master polling started" });

        bool pollOk = true;
        const auto pollTx = buildPollRequest_(req, &pollOk);
        if (!pollOk) {
            setError_("invalid poll request payload");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid poll request payload" });
            i2c.close();
            setConnected_(false, "");
            return;
        }

        std::string lastHex;
        uint64_t lastEmitMs = 0;
        while (!stopFlag_.load()) {
            bool got = false;
            std::vector<uint8_t> rx(std::max<size_t>(1, req.maxBytes), 0);
            size_t n = 0;

            if (rxMode == "packet") {
                jc_i2c::I2cDevice::Frame fr;
                if (!pollTx.empty()) {
                    i2c.writeBytes(pollTx.data(), pollTx.size());
                    bumpTx_();
                    emit_({ nowMs_(), "tx", tr, req.deviceSpec, lower_(req.pollTxEncoding) == "ascii" ? "ascii" : "hex",
                            lower_(req.pollTxEncoding) == "ascii" ? std::string(pollTx.begin(), pollTx.end()) : bytesToHex_(pollTx.data(), pollTx.size()) });
                }
                if (i2c.readFrame(fr, std::min<size_t>(255, req.maxBytes))) {
                    std::vector<uint8_t> packed;
                    packed.push_back(fr.type);
                    packed.push_back((uint8_t)fr.payload.size());
                    packed.insert(packed.end(), fr.payload.begin(), fr.payload.end());
                    uint8_t chk = jc_i2c::I2cDevice::checksum8(packed.data(), packed.size());
                    packed.push_back(chk);
                    rx = std::move(packed);
                    n = rx.size();
                    got = true;
                }
            } else if (!pollTx.empty()) {
                if (req.maxBytes > 0) {
                    if (i2c.writeThenRead(pollTx.data(), pollTx.size(), rx.data(), rx.size())) {
                        n = rx.size();
                        got = true;
                        bumpTx_();
                        emit_({ nowMs_(), "tx", tr, req.deviceSpec, lower_(req.pollTxEncoding) == "ascii" ? "ascii" : "hex",
                                lower_(req.pollTxEncoding) == "ascii" ? std::string(pollTx.begin(), pollTx.end()) : bytesToHex_(pollTx.data(), pollTx.size()) });
                    }
                } else {
                    int wr = i2c.writeBytes(pollTx.data(), pollTx.size());
                    if (wr > 0) {
                        bumpTx_();
                        emit_({ nowMs_(), "tx", tr, req.deviceSpec, lower_(req.pollTxEncoding) == "ascii" ? "ascii" : "hex",
                                lower_(req.pollTxEncoding) == "ascii" ? std::string(pollTx.begin(), pollTx.end()) : bytesToHex_(pollTx.data(), pollTx.size()) });
                    }
                }
            } else {
                int rn = i2c.readBytes(rx.data(), rx.size());
                if (rn > 0) {
                    n = (size_t)rn;
                    got = true;
                }
            }

            if (got && n > 0) {
                const auto ts = nowMs_();
                const std::string hex = bytesToHex_(rx.data(), n);
                if (hex != lastHex || (ts - lastEmitMs) > 1000) {
                    bumpRx_(ts);
                    emit_({ ts, "rx", tr, req.deviceSpec,
                            (rxMode == "line" ? "ascii" : "hex"),
                            (rxMode == "line" ? bytesToAsciiSafe_(rx.data(), n) : hex) });
                    lastHex = hex;
                    lastEmitMs = ts;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(std::max(20, req.pollIntervalMs)));
        }

        i2c.close();
        setConnected_(false, "");
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "i2c polling stopped" });
        return;
    }

    // ---------------- SPI (master polling) ----------------
    if (req.transport == Transport::Spi)
    {
        std::string dev;
        uint32_t speed = 1000000;
        uint8_t mode = 0, bits = 8;
        if (!parseSpiSpec_(req.deviceSpec, dev, speed, mode, bits)) {
            setError_("invalid spi spec (/dev/spidev0.0@1000000#0+8)");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid spi spec" });
            return;
        }

        jc_spi::SpiConfig cfg;
        cfg.device = dev;
        cfg.speedHz = speed;
        cfg.mode = mode;
        cfg.bitsPerWord = bits;

        jc_spi::SpiDevice spi;
        if (!spi.open(cfg)) {
            setError_("spi open failed");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "spi open failed" });
            return;
        }

        setConnected_(true, dev);
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "spi master polling started" });

        bool pollOk = true;
        auto pollTx = buildPollRequest_(req, &pollOk);
        if (!pollOk) {
            setError_("invalid poll request payload");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid poll request payload" });
            spi.close();
            setConnected_(false, "");
            return;
        }
        if (pollTx.empty()) pollTx.assign(std::max<size_t>(1, req.maxBytes), 0xFF);

        std::string lastHex;
        uint64_t lastEmitMs = 0;
        while (!stopFlag_.load()) {
            std::vector<uint8_t> rx;
            bool got = false;
            if (rxMode == "packet") {
                jc_spi::SpiDevice::Packet pkt;
                if (spi.receivePacket(pkt, std::max<size_t>(64, req.maxBytes * 4), std::max<size_t>(16, req.maxBytes), 0xFF)) {
                    rx.push_back(pkt.type);
                    rx.push_back((uint8_t)(pkt.payload.size() & 0xFFu));
                    rx.insert(rx.end(), pkt.payload.begin(), pkt.payload.end());
                    got = true;
                }
            } else {
                if (spi.transfer(pollTx, rx) && !rx.empty()) {
                    got = true;
                    bumpTx_();
                    emit_({ nowMs_(), "tx", tr, req.deviceSpec, lower_(req.pollTxEncoding) == "ascii" ? "ascii" : "hex",
                            lower_(req.pollTxEncoding) == "ascii" ? std::string(pollTx.begin(), pollTx.end()) : bytesToHex_(pollTx.data(), pollTx.size()) });
                }
            }

            if (got && !rx.empty()) {
                const auto ts = nowMs_();
                const std::string hex = bytesToHex_(rx.data(), rx.size());
                if (hex != lastHex || (ts - lastEmitMs) > 1000) {
                    bumpRx_(ts);
                    emit_({ ts, "rx", tr, req.deviceSpec,
                            (rxMode == "line" ? "ascii" : "hex"),
                            (rxMode == "line" ? bytesToAsciiSafe_(rx.data(), rx.size()) : hex) });
                    lastHex = hex;
                    lastEmitMs = ts;
                }
            }
            std::this_thread::sleep_for(std::chrono::milliseconds(std::max(20, req.pollIntervalMs)));
        }

        spi.close();
        setConnected_(false, "");
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "spi polling stopped" });
        return;
    }

    // ---------------- Network (WiFi/Ethernet) ----------------
    {
        std::string proto, host;
        int port = 0;
        if (!parseNetSpec_(req.deviceSpec, proto, host, port)) {
            setError_("invalid net spec (tcp://host:port or udp://host:port)");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid net spec" });
            return;
        }

        proto = lower_(proto);

        socket_t listenSock = kInvalidSocket;
        socket_t clientSock = kInvalidSocket;

        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_port = htons((uint16_t)port);
        if (host == "*" || host == "0.0.0.0") {
            addr.sin_addr.s_addr = htonl(INADDR_ANY);
        } else {
            if (host == "localhost") host = "127.0.0.1";
            in_addr a{};
#if defined(_WIN32)
            if (InetPtonA(AF_INET, host.c_str(), &a) != 1) {
#else
            if (inet_pton(AF_INET, host.c_str(), &a) != 1) {
#endif
                setError_("invalid IPv4 address (use 0.0.0.0 or a numeric IPv4)");
                emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "invalid IPv4 address" });
                return;
            }
            addr.sin_addr = a;
        }

        if (proto == "tcp") {
            listenSock = ::socket(AF_INET, SOCK_STREAM, 0);
            if (listenSock == kInvalidSocket) {
                setError_("socket() failed");
                emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "socket() failed" });
                return;
            }
            setReuseAddr(listenSock);
            setNonBlocking(listenSock, true);

            if (::bind(listenSock, (sockaddr*)&addr, sizeof(addr)) != 0) {
                setError_("bind() failed");
                emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "bind() failed" });
                closeSock(listenSock);
                return;
            }
            if (::listen(listenSock, 1) != 0) {
                setError_("listen() failed");
                emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "listen() failed" });
                closeSock(listenSock);
                return;
            }

            emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "tcp server listening" });

            while (!stopFlag_.load()) {
                if (clientSock == kInvalidSocket) {
                    if (!waitReadable(listenSock, req.pollTimeoutMs)) continue;
                    sockaddr_in cli{};
#if defined(_WIN32)
                    int len = sizeof(cli);
#else
                    socklen_t len = sizeof(cli);
#endif
                    clientSock = ::accept(listenSock, (sockaddr*)&cli, &len);
                    if (clientSock != kInvalidSocket) {
                        setNonBlocking(clientSock, true);
                        setConnected_(true, sockaddrToString(cli));
                        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "client connected: " + sockaddrToString(cli) });
                    }
                    continue;
                }

                if (!waitReadable(clientSock, req.pollTimeoutMs)) {
                    continue;
                }

                std::vector<uint8_t> buf(std::max<size_t>(16, req.maxBytes));
#if defined(_WIN32)
                int n = ::recv(clientSock, (char*)buf.data(), (int)buf.size(), 0);
#else
                int n = (int)::recv(clientSock, buf.data(), buf.size(), 0);
#endif
                if (n <= 0) {
                    closeSock(clientSock);
                    setConnected_(false, "");
                    emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "client disconnected" });
                    continue;
                }

                const auto ts = nowMs_();
                bumpRx_(ts);
                emit_({ ts, "rx", tr, req.deviceSpec, "hex", bytesToHex_(buf.data(), (size_t)n) });

                bool ok = false;
                auto reply = buildReply_(req, buf.data(), (size_t)n, &ok);
                if (ok && !reply.empty()) {
#if defined(_WIN32)
                    ::send(clientSock, (const char*)reply.data(), (int)reply.size(), 0);
#else
                    ::send(clientSock, reply.data(), reply.size(), 0);
#endif
                    bumpTx_();
                    emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                            (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                            (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                                  : std::string(reply.begin(), reply.end())) });
                }
            }

            closeSock(clientSock);
            closeSock(listenSock);
            setConnected_(false, "");
            emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "tcp server stopped" });
            return;
        }

        listenSock = ::socket(AF_INET, SOCK_DGRAM, 0);
        if (listenSock == kInvalidSocket) {
            setError_("socket() failed");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "socket() failed" });
            return;
        }
        setReuseAddr(listenSock);
        setNonBlocking(listenSock, true);

        if (::bind(listenSock, (sockaddr*)&addr, sizeof(addr)) != 0) {
            setError_("bind() failed");
            emit_({ nowMs_(), "err", tr, req.deviceSpec, "ascii", "bind() failed" });
            closeSock(listenSock);
            return;
        }

        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "udp server listening" });

        sockaddr_in lastPeer{};
        bool havePeer = false;

        while (!stopFlag_.load()) {
            if (!waitReadable(listenSock, req.pollTimeoutMs)) continue;

            std::vector<uint8_t> buf(std::max<size_t>(16, req.maxBytes));
            sockaddr_in src{};
#if defined(_WIN32)
            int slen = sizeof(src);
            int n = ::recvfrom(listenSock, (char*)buf.data(), (int)buf.size(), 0, (sockaddr*)&src, &slen);
#else
            socklen_t slen = sizeof(src);
            int n = (int)::recvfrom(listenSock, buf.data(), buf.size(), 0, (sockaddr*)&src, &slen);
#endif
            if (n <= 0) continue;

            lastPeer = src;
            havePeer = true;
            setConnected_(true, sockaddrToString(src));

            const auto ts = nowMs_();
            bumpRx_(ts);
            emit_({ ts, "rx", tr, req.deviceSpec, "hex", bytesToHex_(buf.data(), (size_t)n) });

            bool ok = false;
            auto reply = buildReply_(req, buf.data(), (size_t)n, &ok);
            if (ok && !reply.empty() && havePeer) {
#if defined(_WIN32)
                ::sendto(listenSock, (const char*)reply.data(), (int)reply.size(), 0, (sockaddr*)&lastPeer, sizeof(lastPeer));
#else
                ::sendto(listenSock, reply.data(), reply.size(), 0, (sockaddr*)&lastPeer, sizeof(lastPeer));
#endif
                bumpTx_();
                emit_({ nowMs_(), "tx", tr, req.deviceSpec,
                        (lower_(req.replyEncoding) == "hex" ? "hex" : "ascii"),
                        (lower_(req.replyEncoding) == "hex" ? bytesToHex_(reply.data(), reply.size())
                                                              : std::string(reply.begin(), reply.end())) });
            }
        }

        closeSock(listenSock);
        setConnected_(false, "");
        emit_({ nowMs_(), "info", tr, req.deviceSpec, "ascii", "udp server stopped" });
        return;
    }
}

} // namespace jc_comms_listen
