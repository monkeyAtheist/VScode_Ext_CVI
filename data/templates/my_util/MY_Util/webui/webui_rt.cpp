#include "webui_rt.h"

#include <algorithm>
#include <array>
#include <chrono>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <iostream>

#if defined(_WIN32)
    #ifndef NOMINMAX
        #define NOMINMAX
    #endif
    #include <winsock2.h>
    #include <ws2tcpip.h>
    #pragma comment(lib, "ws2_32.lib")
#else
    #include <arpa/inet.h>
    #include <fcntl.h>
    #include <netinet/in.h>
    #include <sys/select.h>
    #include <sys/socket.h>
    #include <unistd.h>
    #include <signal.h>
#endif

namespace jc_webui_rt {

namespace fs = std::filesystem;

#if defined(_WIN32)
static struct WsaAutoInit {
    WsaAutoInit() {
        WSADATA wsa{};
        WSAStartup(MAKEWORD(2, 2), &wsa);
    }
    ~WsaAutoInit() {
        WSACleanup();
    }
} g_wsaAutoInit;
#endif

namespace {

struct Sha1Ctx {
    uint32_t state[5] = {
        0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u
    };
    uint64_t bitCount = 0;
    uint8_t buffer[64]{};
    size_t bufferSize = 0;
};

static inline uint32_t rol32(uint32_t v, int n)
{
    return (v << n) | (v >> (32 - n));
}

void sha1ProcessBlock(Sha1Ctx& ctx, const uint8_t* block)
{
    uint32_t w[80]{};
    for (int i = 0; i < 16; ++i) {
        w[i] = (static_cast<uint32_t>(block[i * 4 + 0]) << 24)
             | (static_cast<uint32_t>(block[i * 4 + 1]) << 16)
             | (static_cast<uint32_t>(block[i * 4 + 2]) << 8)
             | (static_cast<uint32_t>(block[i * 4 + 3]));
    }
    for (int i = 16; i < 80; ++i) {
        w[i] = rol32(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
    }

    uint32_t a = ctx.state[0];
    uint32_t b = ctx.state[1];
    uint32_t c = ctx.state[2];
    uint32_t d = ctx.state[3];
    uint32_t e = ctx.state[4];

    for (int i = 0; i < 80; ++i) {
        uint32_t f = 0;
        uint32_t k = 0;
        if (i < 20) {
            f = (b & c) | ((~b) & d);
            k = 0x5A827999u;
        }
        else if (i < 40) {
            f = b ^ c ^ d;
            k = 0x6ED9EBA1u;
        }
        else if (i < 60) {
            f = (b & c) | (b & d) | (c & d);
            k = 0x8F1BBCDCu;
        }
        else {
            f = b ^ c ^ d;
            k = 0xCA62C1D6u;
        }

        const uint32_t tmp = rol32(a, 5) + f + e + k + w[i];
        e = d;
        d = c;
        c = rol32(b, 30);
        b = a;
        a = tmp;
    }

    ctx.state[0] += a;
    ctx.state[1] += b;
    ctx.state[2] += c;
    ctx.state[3] += d;
    ctx.state[4] += e;
}

void sha1Update(Sha1Ctx& ctx, const uint8_t* data, size_t size)
{
    ctx.bitCount += static_cast<uint64_t>(size) * 8u;
    while (size > 0) {
        const size_t toCopy = std::min<size_t>(size, 64u - ctx.bufferSize);
        std::memcpy(ctx.buffer + ctx.bufferSize, data, toCopy);
        ctx.bufferSize += toCopy;
        data += toCopy;
        size -= toCopy;
        if (ctx.bufferSize == 64) {
            sha1ProcessBlock(ctx, ctx.buffer);
            ctx.bufferSize = 0;
        }
    }
}

std::array<uint8_t, 20> sha1Final(Sha1Ctx& ctx)
{
    ctx.buffer[ctx.bufferSize++] = 0x80;
    if (ctx.bufferSize > 56) {
        while (ctx.bufferSize < 64) ctx.buffer[ctx.bufferSize++] = 0;
        sha1ProcessBlock(ctx, ctx.buffer);
        ctx.bufferSize = 0;
    }

    while (ctx.bufferSize < 56) ctx.buffer[ctx.bufferSize++] = 0;
    for (int i = 7; i >= 0; --i) {
        ctx.buffer[ctx.bufferSize++] = static_cast<uint8_t>((ctx.bitCount >> (i * 8)) & 0xFFu);
    }
    sha1ProcessBlock(ctx, ctx.buffer);

    std::array<uint8_t, 20> out{};
    for (int i = 0; i < 5; ++i) {
        out[i * 4 + 0] = static_cast<uint8_t>((ctx.state[i] >> 24) & 0xFFu);
        out[i * 4 + 1] = static_cast<uint8_t>((ctx.state[i] >> 16) & 0xFFu);
        out[i * 4 + 2] = static_cast<uint8_t>((ctx.state[i] >> 8) & 0xFFu);
        out[i * 4 + 3] = static_cast<uint8_t>((ctx.state[i]) & 0xFFu);
    }
    return out;
}

std::string base64Encode(const uint8_t* data, size_t len)
{
    static constexpr char lut[] =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    out.reserve(((len + 2) / 3) * 4);

    for (size_t i = 0; i < len; i += 3) {
        const uint32_t a = data[i];
        const uint32_t b = (i + 1 < len) ? data[i + 1] : 0;
        const uint32_t c = (i + 2 < len) ? data[i + 2] : 0;
        const uint32_t triple = (a << 16) | (b << 8) | c;

        out.push_back(lut[(triple >> 18) & 0x3F]);
        out.push_back(lut[(triple >> 12) & 0x3F]);
        out.push_back((i + 1 < len) ? lut[(triple >> 6) & 0x3F] : '=');
        out.push_back((i + 2 < len) ? lut[triple & 0x3F] : '=');
    }
    return out;
}

std::string guessMimeFromExt(const std::string& path)
{
    const auto pos = path.find_last_of('.');
    const std::string ext = (pos == std::string::npos) ? "" : path.substr(pos + 1);
    std::string lower = ext;
    std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

    if (lower == "html" || lower == "htm") return "text/html; charset=utf-8";
    if (lower == "css") return "text/css; charset=utf-8";
    if (lower == "js") return "application/javascript; charset=utf-8";
    if (lower == "json") return "application/json; charset=utf-8";
    if (lower == "svg") return "image/svg+xml";
    if (lower == "png") return "image/png";
    if (lower == "jpg" || lower == "jpeg") return "image/jpeg";
    if (lower == "ico") return "image/x-icon";
    if (lower == "txt") return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

std::string toJsonEnvelope(const std::string& type, const std::string& jsonPayload)
{
    std::ostringstream oss;
    oss << "{\"type\":\"" << WebUiRtServer::jsonEscape(type) << "\",\"payload\":";
    oss << (jsonPayload.empty() ? "null" : jsonPayload);
    oss << "}";
    return oss.str();
}

} // namespace

WebUiRtServer::WebUiRtServer() = default;

WebUiRtServer::~WebUiRtServer()
{
    stop();
}

bool WebUiRtServer::start(const WebUiRtConfig& cfg)
{
    stop();
    cfg_ = cfg;
    jpegQualityRuntime_.store(std::clamp(cfg_.jpegQuality, 20, 100));

#if !defined(_WIN32)
    // Prevent process termination when a client disconnects while we send data.
    // (Linux default is to raise SIGPIPE on send() to a closed socket.)
    ::signal(SIGPIPE, SIG_IGN);
#endif

    if (!createListenSocket_()) {
        return false;
    }

    registerDefaultRoutes_();
    running_.store(true);
    acceptThread_ = std::thread(&WebUiRtServer::acceptLoop_, this);
    telemetryThread_ = std::thread(&WebUiRtServer::telemetryLoop_, this);
    return true;
}

void WebUiRtServer::stop()
{
    running_.store(false);
    closeListenSocket_();

    if (acceptThread_.joinable()) {
        acceptThread_.join();
    }
    if (telemetryThread_.joinable()) {
        telemetryThread_.join();
    }

    {
        std::lock_guard<std::mutex> lock(wsMutex_);
        for (auto& c : wsClients_) {
            if (c) {
                c->alive.store(false);
                closeSocket_(c->sock);
            }
        }
        wsClients_.clear();
    }
}

std::string WebUiRtServer::baseUrl(const std::string& hostOrIp) const
{
    std::ostringstream oss;
    oss << "http://" << (hostOrIp.empty() ? cfg_.bindAddress : hostOrIp) << ':' << cfg_.port;
    return oss.str();
}

void WebUiRtServer::setTelemetryProvider(TelemetryProvider cb)
{
    std::lock_guard<std::mutex> lock(routesMutex_);
    telemetryProvider_ = std::move(cb);
}

void WebUiRtServer::setCommandHandler(CommandHandler cb)
{
    std::lock_guard<std::mutex> lock(routesMutex_);
    commandHandler_ = std::move(cb);
}

void WebUiRtServer::registerGet(const std::string& route, HttpHandler cb)
{
    std::lock_guard<std::mutex> lock(routesMutex_);
    getRoutes_[normalizeRoute_(route)] = std::move(cb);
}

void WebUiRtServer::registerPost(const std::string& route, HttpHandler cb)
{
    std::lock_guard<std::mutex> lock(routesMutex_);
    postRoutes_[normalizeRoute_(route)] = std::move(cb);
}

void WebUiRtServer::addOrUpdateStaticRoute(const std::string& route,
                                           const std::string& content,
                                           const std::string& contentType)
{
    std::lock_guard<std::mutex> lock(routesMutex_);
    staticRoutes_[normalizeRoute_(route)] = { content, contentType };
}

bool WebUiRtServer::popCommand(WebCommandEvent& outEvent)
{
    std::lock_guard<std::mutex> lock(cmdMutex_);
    if (cmdQueue_.empty()) {
        return false;
    }
    outEvent = cmdQueue_.front();
    cmdQueue_.pop();
    return true;
}

size_t WebUiRtServer::queuedCommandCount() const
{
    std::lock_guard<std::mutex> lock(cmdMutex_);
    return cmdQueue_.size();
}

void WebUiRtServer::setJpegQuality(int quality)
{
    jpegQualityRuntime_.store(std::clamp(quality, 20, 100));
}

int WebUiRtServer::jpegQuality() const
{
    return jpegQualityRuntime_.load();
}

bool WebUiRtServer::updateFrame(const cv::Mat& frameBgr)
{
    if (frameBgr.empty()) {
        return false;
    }

    std::vector<uint8_t> jpeg;
    std::vector<int> params{ cv::IMWRITE_JPEG_QUALITY, jpegQualityRuntime_.load() };
    if (!cv::imencode(".jpg", frameBgr, jpeg, params)) {
        return false;
    }
    return updateFrameJpeg(jpeg, frameBgr.cols, frameBgr.rows);
}

bool WebUiRtServer::updateFrameJpeg(const std::vector<uint8_t>& jpegBytes, int width, int height)
{
    if (jpegBytes.empty()) {
        return false;
    }
    std::lock_guard<std::mutex> lock(frameMutex_);
    lastJpegFrame_ = jpegBytes;
    lastFrameWidth_ = width;
    lastFrameHeight_ = height;
    return true;
}

void WebUiRtServer::broadcastText(const std::string& text)
{
    std::vector<std::shared_ptr<WsClient>> snapshot;
    {
        std::lock_guard<std::mutex> lock(wsMutex_);
        snapshot = wsClients_;
    }

    for (auto& c : snapshot) {
        if (!c || !c->alive.load()) continue;
        std::lock_guard<std::mutex> sendLock(c->sendMutex);
        if (!sendWebSocketText_(c->sock, text)) {
            c->alive.store(false);
            closeSocket_(c->sock);
        }
    }
    removeDeadWebSockets_();
}

void WebUiRtServer::broadcastJsonEnvelope(const std::string& type, const std::string& jsonPayload)
{
    broadcastText(toJsonEnvelope(type, jsonPayload));
}

std::string WebUiRtServer::jsonEscape(const std::string& s)
{
    std::string out;
    out.reserve(s.size() + 8);
    for (char c : s) {
        switch (c) {
        case '"': out += "\\\""; break;
        case '\\': out += "\\\\"; break;
        case '\b': out += "\\b"; break;
        case '\f': out += "\\f"; break;
        case '\n': out += "\\n"; break;
        case '\r': out += "\\r"; break;
        case '\t': out += "\\t"; break;
        default:
            if (static_cast<unsigned char>(c) < 0x20) {
                std::ostringstream oss;
                oss << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                    << static_cast<int>(static_cast<unsigned char>(c));
                out += oss.str();
            }
            else {
                out.push_back(c);
            }
        }
    }
    return out;
}

std::string WebUiRtServer::makeOkJson(bool ok, const std::string& message)
{
    std::ostringstream oss;
    oss << "{\"ok\":" << (ok ? "true" : "false");
    if (!message.empty()) {
        oss << ",\"message\":\"" << jsonEscape(message) << "\"";
    }
    oss << '}';
    return oss.str();
}

void WebUiRtServer::acceptLoop_()
{
    while (running_.load()) {
        if (!waitReadable_(listenSock_, cfg_.acceptTimeoutMs)) {
            continue;
        }

        sockaddr_in addr{};
#if defined(_WIN32)
        int addrLen = sizeof(addr);
#else
        socklen_t addrLen = sizeof(addr);
#endif
        SocketHandle clientSock = static_cast<SocketHandle>(::accept(static_cast<int>(listenSock_), reinterpret_cast<sockaddr*>(&addr), &addrLen));
        if (clientSock == kInvalidSocket) {
            continue;
        }

        char ipBuf[64] = { 0 };
        std::string remoteIp = inet_ntop(AF_INET, &addr.sin_addr, ipBuf, sizeof(ipBuf)) ? ipBuf : std::string("unknown");
        const uint16_t remotePort = ntohs(addr.sin_port);
        std::thread(&WebUiRtServer::handleClient_, this, clientSock, remoteIp, remotePort).detach();
    }
}

void WebUiRtServer::telemetryLoop_()
{
    using namespace std::chrono_literals;
    while (running_.load()) {
        TelemetryProvider provider;
        {
            std::lock_guard<std::mutex> lock(routesMutex_);
            provider = telemetryProvider_;
        }

        if (provider) {
            std::string json;
            try {
                json = provider();
            }
            catch (...) {
                json = "{\"ok\":false,\"error\":\"telemetry provider exception\"}";
            }
            broadcastJsonEnvelope("telemetry", json);
        }

        std::this_thread::sleep_for(std::chrono::milliseconds(std::max(20, cfg_.telemetryPeriodMs)));
    }
}

void WebUiRtServer::handleClient_(SocketHandle clientSock, const std::string& remoteIp, uint16_t remotePort)
{
    HttpRequest req;
    req.remoteIp = remoteIp;
    req.remotePort = remotePort;

    if (!readHttpRequest_(clientSock, req, cfg_.clientTimeoutMs)) {
        closeSocket_(clientSock);
        return;
    }

    if (req.path == cfg_.wsRoute) {
        if (!handleWebSocketUpgrade_(clientSock, req)) {
            closeSocket_(clientSock);
        }
        return;
    }

    if (req.path == cfg_.mjpegRoute) {
        if (!handleMjpegStream_(clientSock)) {
            closeSocket_(clientSock);
        }
        return;
    }

    HttpResponse res = routeHttpRequest_(req);
    sendHttpResponse_(clientSock, res);
    closeSocket_(clientSock);
}

bool WebUiRtServer::createListenSocket_()
{
    closeListenSocket_();

    SocketHandle sock = static_cast<SocketHandle>(::socket(AF_INET, SOCK_STREAM, 0));
    if (sock == kInvalidSocket) {
        return false;
    }

    setSocketReuseAddr_(sock);

    sockaddr_in addr{};
    addr.sin_family = AF_INET;
    addr.sin_port = htons(cfg_.port);
    if (cfg_.bindAddress.empty() || cfg_.bindAddress == "0.0.0.0") {
        addr.sin_addr.s_addr = htonl(INADDR_ANY);
    }
    else if (inet_pton(AF_INET, cfg_.bindAddress.c_str(), &addr.sin_addr) != 1) {
        closeSocket_(sock);
        return false;
    }

    if (::bind(static_cast<int>(sock), reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
        closeSocket_(sock);
        return false;
    }
    if (::listen(static_cast<int>(sock), 16) != 0) {
        closeSocket_(sock);
        return false;
    }

    listenSock_ = sock;
    return true;
}

void WebUiRtServer::closeListenSocket_()
{
    if (listenSock_ != kInvalidSocket) {
        closeSocket_(listenSock_);
        listenSock_ = kInvalidSocket;
    }
}

void WebUiRtServer::registerDefaultRoutes_()
{
    registerGet("/api/ping", [](const HttpRequest&) {
        HttpResponse res;
        res.contentType = "application/json; charset=utf-8";
        res.body = "{\"ok\":true,\"service\":\"jc_webui_rt\"}";
        return res;
    });

    registerGet("/api/telemetry", [this](const HttpRequest&) {
        HttpResponse res;
        res.contentType = "application/json; charset=utf-8";
        TelemetryProvider provider;
        {
            std::lock_guard<std::mutex> lock(routesMutex_);
            provider = telemetryProvider_;
        }
        res.body = provider ? provider() : "{\"ok\":true}";
        return res;
    });
}

HttpResponse WebUiRtServer::routeHttpRequest_(const HttpRequest& req)
{
    HttpHandler handler;

    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        if (req.method == "GET") {
            auto it = getRoutes_.find(req.path);
            if (it != getRoutes_.end()) {
                handler = it->second;
            }
        }
        else if (req.method == "POST") {
            auto it = postRoutes_.find(req.path);
            if (it != postRoutes_.end()) {
                handler = it->second;
            }
        }
    }

    if (handler) {
        try {
            return handler(req);
        }
        catch (const std::exception& e) {
            HttpResponse res;
            res.status = 500;
            res.contentType = "application/json; charset=utf-8";
            res.body = std::string("{\"ok\":false,\"error\":\"handler exception: ")
                + jsonEscape(e.what()) + "\"}";
            return res;
        }
        catch (...) {
            HttpResponse res;
            res.status = 500;
            res.contentType = "application/json; charset=utf-8";
            res.body = "{\"ok\":false,\"error\":\"unknown handler exception\"}";
            return res;
        }
    }

    try {
        if (auto embedded = serveEmbedded_(req.path); embedded.status != 404 || !embedded.body.empty()) {
            return embedded;
        }
        return serveFile_(req.path);
    }
    catch (const std::exception& e) {
        HttpResponse res;
        res.status = 500;
        res.contentType = "application/json; charset=utf-8";
        res.body = std::string("{\"ok\":false,\"error\":\"route exception: ")
            + jsonEscape(e.what()) + "\"}";
        return res;
    }
    catch (...) {
        HttpResponse res;
        res.status = 500;
        res.contentType = "application/json; charset=utf-8";
        res.body = "{\"ok\":false,\"error\":\"unknown route exception\"}";
        return res;
    }
}

HttpResponse WebUiRtServer::serveFile_(const std::string& path)
{
    HttpResponse res;

    std::string rel = sanitizePath_(path == "/" ? ("/" + cfg_.indexFile) : path);
    if (rel.empty()) {
        res.status = 403;
        res.body = "Forbidden";
        return res;
    }

    const fs::path filePath = fs::path(cfg_.documentRoot) / rel.substr(1);
    std::error_code ec;
    if (!fs::exists(filePath, ec) || !fs::is_regular_file(filePath, ec)) {
        res.status = 404;
        res.body = "Not found";
        return res;
    }

    const auto bytes = readFileBinary_(filePath.string());
    res.status = 200;
    res.contentType = contentTypeFromPath_(filePath.string());
    res.body.assign(bytes.begin(), bytes.end());
    return res;
}

HttpResponse WebUiRtServer::serveEmbedded_(const std::string& path)
{
    HttpResponse res;
    std::lock_guard<std::mutex> lock(routesMutex_);
    auto it = staticRoutes_.find(normalizeRoute_(path));
    if (it == staticRoutes_.end()) {
        res.status = 404;
        return res;
    }
    res.status = 200;
    res.contentType = it->second.contentType;
    res.body = it->second.content;
    return res;
}

bool WebUiRtServer::handleWebSocketUpgrade_(SocketHandle sock, const HttpRequest& req)
{
    const auto itUpgrade = req.headers.find("upgrade");
    const auto itKey = req.headers.find("sec-websocket-key");
    if (itUpgrade == req.headers.end() || itKey == req.headers.end()) {
        HttpResponse bad;
        bad.status = 400;
        bad.body = "Missing websocket headers";
        sendHttpResponse_(sock, bad);
        return false;
    }

    if (toLower_(itUpgrade->second) != "websocket") {
        HttpResponse bad;
        bad.status = 400;
        bad.body = "Invalid upgrade";
        sendHttpResponse_(sock, bad);
        return false;
    }

    const std::string accept = websocketAcceptKey_(trim_(itKey->second));
    std::ostringstream oss;
    oss << "HTTP/1.1 101 Switching Protocols\r\n";
    oss << "Upgrade: websocket\r\n";
    oss << "Connection: Upgrade\r\n";
    oss << "Sec-WebSocket-Accept: " << accept << "\r\n\r\n";
    if (!sendRaw_(sock, oss.str().data(), oss.str().size())) {
        return false;
    }

    auto client = std::make_shared<WsClient>();
    client->sock = sock;
    client->remoteIp = req.remoteIp;
    client->remotePort = req.remotePort;
    {
        std::lock_guard<std::mutex> lock(wsMutex_);
        wsClients_.push_back(client);
    }

    TelemetryProvider provider;
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        provider = telemetryProvider_;
    }
    if (provider) {
        try {
            // Protéger aussi l'envoi initial : le thread telemetryLoop_ peut déjà
            // broadcaster sur ce même socket dès que le client est ajouté dans
            // wsClients_. Sans ce verrou, deux frames WebSocket peuvent s'entrelacer
            // et le navigateur ferme immédiatement la connexion avec une erreur
            // protocolaire.
            std::lock_guard<std::mutex> sendLock(client->sendMutex);
            if (!sendWebSocketText_(sock, toJsonEnvelope("telemetry", provider()))) {
                client->alive.store(false);
                closeSocket_(sock);
                removeDeadWebSockets_();
                return false;
            }
        }
        catch (...) {}
    }

    while (running_.load() && client->alive.load()) {
        std::string text;
        int opcode = 0;
        bool isClose = false;
        if (!readWebSocketFrame_(sock, text, opcode, isClose, cfg_.wsPollTimeoutMs)) {
            if (!running_.load()) break;
            continue;
        }

        if (isClose || opcode == 0x8) {
            break;
        }
        if (opcode == 0x9) {
            continue;
        }
        if (opcode != 0x1) {
            continue;
        }

        WebCommandEvent ev;
        ev.sequence = ++commandCounter_;
        ev.remoteIp = req.remoteIp;
        ev.remotePort = req.remotePort;
        ev.rawJson = text;

        //Récupération des commandes
        tryExtractJsonStringField_(text, "type", ev.type);
        tryExtractJsonStringField_(text, "action", ev.action);

        static const char* keys[] = {
            "cmd", "axis", "dir", "button", "source",
            "left_pct", "right_pct", "pct", "steps", "value",
            "setting", "mode", "target", "pan_deg", "tilt_deg",

            // Comms page (V2)
            "transport", "device", "payload", "encoding", "append_nl",
            "expect_reply", "reply_mode", "timeout_ms", "max_bytes", "clear_rx"
        };
        for (const char* k : keys) {
            std::string v;
            if (tryExtractJsonStringField_(text, k, v) || tryExtractJsonNumberField_(text, k, v)) {
                ev.fields[k] = v;
            }
        }

        enqueueCommand_(ev);
        CommandHandler handler;
        {
            std::lock_guard<std::mutex> lock(routesMutex_);
            handler = commandHandler_;
        }
        if (handler) {
            try {
                handler(ev);
            }
            catch (const std::exception& e) {
                broadcastText(std::string("{\"type\":\"error\",\"message\":\"ws handler exception: ")
                    + jsonEscape(e.what()) + "\"}");
            }
            catch (...) {
                broadcastText("{\"type\":\"error\",\"message\":\"unknown ws handler exception\"}");
            }
        }
    }

    client->alive.store(false);
    closeSocket_(sock);
    removeDeadWebSockets_();
    return true;
}

bool WebUiRtServer::handleMjpegStream_(SocketHandle sock)
{
    const std::string header =
        "HTTP/1.1 200 OK\r\n"
        "Connection: close\r\n"
        "Cache-Control: no-cache\r\n"
        "Pragma: no-cache\r\n"
        "Content-Type: multipart/x-mixed-replace; boundary=frame\r\n\r\n";
    if (!sendRaw_(sock, header.data(), header.size())) {
        return false;
    }

    std::vector<uint8_t> frame;
    while (running_.load()) {
        {
            std::lock_guard<std::mutex> lock(frameMutex_);
            frame = lastJpegFrame_;
        }

        if (!frame.empty()) {
            std::ostringstream part;
            part << "--frame\r\n";
            part << "Content-Type: image/jpeg\r\n";
            part << "Content-Length: " << frame.size() << "\r\n\r\n";
            if (!sendRaw_(sock, part.str().data(), part.str().size())) return false;
            if (!sendRaw_(sock, frame.data(), frame.size())) return false;
            if (!sendRaw_(sock, "\r\n", 2)) return false;
        }
        std::this_thread::sleep_for(std::chrono::milliseconds(66));
    }

    return true;
}

void WebUiRtServer::removeDeadWebSockets_()
{
    std::lock_guard<std::mutex> lock(wsMutex_);
    wsClients_.erase(
        std::remove_if(wsClients_.begin(), wsClients_.end(), [](const std::shared_ptr<WsClient>& c) {
            return !c || !c->alive.load();
        }),
        wsClients_.end());
}

void WebUiRtServer::enqueueCommand_(const WebCommandEvent& ev)
{
    std::lock_guard<std::mutex> lock(cmdMutex_);
    cmdQueue_.push(ev);
    if (cmdQueue_.size() > 256) {
        cmdQueue_.pop();
    }
}

bool WebUiRtServer::readHttpRequest_(SocketHandle sock, HttpRequest& req, int timeoutMs)
{
    std::string data;
    char temp[1024];

    while (data.find("\r\n\r\n") == std::string::npos) {
        if (!waitReadable_(sock, timeoutMs)) return false;
        const int n = ::recv(static_cast<int>(sock), temp, static_cast<int>(sizeof(temp)), 0);
        if (n <= 0) return false;
        data.append(temp, temp + n);
        if (data.size() > 64 * 1024) return false;
    }

    const size_t headerEnd = data.find("\r\n\r\n");
    const std::string headerText = data.substr(0, headerEnd);
    std::istringstream iss(headerText);
    std::string line;

    if (!std::getline(iss, line)) return false;
    if (!line.empty() && line.back() == '\r') line.pop_back();
    {
        std::istringstream fl(line);
        fl >> req.method >> req.target >> req.httpVersion;
    }
    if (req.method.empty() || req.target.empty()) return false;

    const size_t qPos = req.target.find('?');
    req.path = (qPos == std::string::npos) ? req.target : req.target.substr(0, qPos);
    req.query = (qPos == std::string::npos) ? std::unordered_map<std::string, std::string>{}
                                            : parseKvEncoded_(req.target.substr(qPos + 1));

    while (std::getline(iss, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const size_t sep = line.find(':');
        if (sep == std::string::npos) continue;
        const std::string k = toLower_(trim_(line.substr(0, sep)));
        const std::string v = trim_(line.substr(sep + 1));
        req.headers[k] = v;
    }

    size_t contentLength = 0;
    auto it = req.headers.find("content-length");
    if (it != req.headers.end()) {
        try { contentLength = static_cast<size_t>(std::stoul(it->second)); }
        catch (...) { contentLength = 0; }
    }

    req.body = data.substr(headerEnd + 4);
    while (req.body.size() < contentLength) {
        if (!waitReadable_(sock, timeoutMs)) return false;
        const int n = ::recv(static_cast<int>(sock), temp, static_cast<int>(sizeof(temp)), 0);
        if (n <= 0) return false;
        req.body.append(temp, temp + n);
    }
    if (req.body.size() > contentLength) {
        req.body.resize(contentLength);
    }

    return true;
}

bool WebUiRtServer::sendHttpResponse_(SocketHandle sock, const HttpResponse& res)
{
    std::ostringstream oss;
    oss << "HTTP/1.1 " << res.status << ' ' << statusText_(res.status) << "\r\n";
    oss << "Content-Type: " << res.contentType << "\r\n";
    oss << "Content-Length: " << res.body.size() << "\r\n";
    oss << "Connection: close\r\n";
    for (const auto& kv : res.headers) {
        oss << kv.first << ": " << kv.second << "\r\n";
    }
    oss << "\r\n";

    const std::string header = oss.str();
    if (!sendRaw_(sock, header.data(), header.size())) return false;
    if (!res.body.empty() && !sendRaw_(sock, res.body.data(), res.body.size())) return false;
    return true;
}

bool WebUiRtServer::sendRaw_(SocketHandle sock, const void* data, size_t size)
{
    const char* ptr = static_cast<const char*>(data);
    size_t sent = 0;
    while (sent < size) {
        if (!waitWritable_(sock, 2000)) return false;
#if defined(_WIN32)
        const int rc = ::send(static_cast<int>(sock), ptr + sent, static_cast<int>(size - sent), 0);
#else
        int flags = 0;
        #ifdef MSG_NOSIGNAL
            flags |= MSG_NOSIGNAL;
        #endif
        const int rc = ::send(static_cast<int>(sock), ptr + sent, static_cast<int>(size - sent), flags);
#endif
        if (rc <= 0) return false;
        sent += static_cast<size_t>(rc);
    }
    return true;
}

bool WebUiRtServer::recvExact_(SocketHandle sock, void* data, size_t size, int timeoutMs)
{
    uint8_t* ptr = static_cast<uint8_t*>(data);
    size_t done = 0;
    while (done < size) {
        if (!waitReadable_(sock, timeoutMs)) return false;
        const int rc = ::recv(static_cast<int>(sock), reinterpret_cast<char*>(ptr + done), static_cast<int>(size - done), 0);
        if (rc <= 0) return false;
        done += static_cast<size_t>(rc);
    }
    return true;
}

bool WebUiRtServer::waitReadable_(SocketHandle sock, int timeoutMs)
{
    if (sock == kInvalidSocket) return false;
    fd_set rfds;
    FD_ZERO(&rfds);
    FD_SET(static_cast<int>(sock), &rfds);
    timeval tv{};
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    const int rc = ::select(static_cast<int>(sock) + 1, &rfds, nullptr, nullptr, &tv);
    return rc > 0 && FD_ISSET(static_cast<int>(sock), &rfds);
}

bool WebUiRtServer::waitWritable_(SocketHandle sock, int timeoutMs)
{
    if (sock == kInvalidSocket) return false;
    fd_set wfds;
    FD_ZERO(&wfds);
    FD_SET(static_cast<int>(sock), &wfds);
    timeval tv{};
    tv.tv_sec = timeoutMs / 1000;
    tv.tv_usec = (timeoutMs % 1000) * 1000;
    const int rc = ::select(static_cast<int>(sock) + 1, nullptr, &wfds, nullptr, &tv);
    return rc > 0 && FD_ISSET(static_cast<int>(sock), &wfds);
}

void WebUiRtServer::closeSocket_(SocketHandle sock)
{
    if (sock == kInvalidSocket) return;
#if defined(_WIN32)
    ::closesocket(static_cast<SOCKET>(sock));
#else
    ::close(static_cast<int>(sock));
#endif
}

bool WebUiRtServer::setSocketReuseAddr_(SocketHandle sock)
{
    const int yes = 1;
    return ::setsockopt(static_cast<int>(sock), SOL_SOCKET, SO_REUSEADDR,
                        reinterpret_cast<const char*>(&yes), sizeof(yes)) == 0;
}

std::string WebUiRtServer::normalizeRoute_(const std::string& route)
{
    if (route.empty()) return "/";
    return route.front() == '/' ? route : "/" + route;
}

std::string WebUiRtServer::sanitizePath_(const std::string& path)
{
    std::string p = normalizeRoute_(path);
    if (p.find("..") != std::string::npos) return {};
    return p;
}

std::string WebUiRtServer::statusText_(int code)
{
    switch (code) {
    case 200: return "OK";
    case 101: return "Switching Protocols";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 500: return "Internal Server Error";
    default: return "Status";
    }
}

std::string WebUiRtServer::contentTypeFromPath_(const std::string& path)
{
    return guessMimeFromExt(path);
}

std::unordered_map<std::string, std::string> WebUiRtServer::parseKvEncoded_(const std::string& s, char pairSep, char kvSep)
{
    std::unordered_map<std::string, std::string> out;
    std::stringstream ss(s);
    std::string pair;
    while (std::getline(ss, pair, pairSep)) {
        const size_t sep = pair.find(kvSep);
        if (sep == std::string::npos) {
            out[urlDecode_(pair)] = "";
        }
        else {
            out[urlDecode_(pair.substr(0, sep))] = urlDecode_(pair.substr(sep + 1));
        }
    }
    return out;
}

std::string WebUiRtServer::urlDecode_(const std::string& s)
{
    std::string out;
    out.reserve(s.size());
    for (size_t i = 0; i < s.size(); ++i) {
        if (s[i] == '%' && i + 2 < s.size()) {
            const std::string hex = s.substr(i + 1, 2);
            char c = static_cast<char>(std::strtol(hex.c_str(), nullptr, 16));
            out.push_back(c);
            i += 2;
        }
        else if (s[i] == '+') {
            out.push_back(' ');
        }
        else {
            out.push_back(s[i]);
        }
    }
    return out;
}

std::string WebUiRtServer::trim_(std::string s)
{
    auto isWs = [](unsigned char c) { return std::isspace(c) != 0; };
    while (!s.empty() && isWs(static_cast<unsigned char>(s.front()))) s.erase(s.begin());
    while (!s.empty() && isWs(static_cast<unsigned char>(s.back()))) s.pop_back();
    return s;
}

std::string WebUiRtServer::toLower_(std::string s)
{
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}

std::string WebUiRtServer::readFileText_(const std::string& path)
{
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) return {};
    std::ostringstream oss;
    oss << ifs.rdbuf();
    return oss.str();
}

std::vector<uint8_t> WebUiRtServer::readFileBinary_(const std::string& path)
{
    std::ifstream ifs(path, std::ios::binary);
    if (!ifs) return {};
    return std::vector<uint8_t>(std::istreambuf_iterator<char>(ifs), std::istreambuf_iterator<char>());
}

bool WebUiRtServer::startsWith_(const std::string& s, const std::string& prefix)
{
    return s.size() >= prefix.size() && s.compare(0, prefix.size(), prefix) == 0;
}

bool WebUiRtServer::tryExtractJsonStringField_(const std::string& json, const std::string& field, std::string& out)
{
    const std::string needle = "\"" + field + "\"";
    const size_t p = json.find(needle);
    if (p == std::string::npos) return false;
    const size_t colon = json.find(':', p + needle.size());
    if (colon == std::string::npos) return false;
    size_t q1 = json.find('"', colon + 1);
    if (q1 == std::string::npos) return false;
    ++q1;
    std::string val;
    bool escape = false;
    for (size_t i = q1; i < json.size(); ++i) {
        const char c = json[i];
        if (escape) {
            val.push_back(c);
            escape = false;
        }
        else if (c == '\\') {
            escape = true;
        }
        else if (c == '"') {
            out = val;
            return true;
        }
        else {
            val.push_back(c);
        }
    }
    return false;
}

bool WebUiRtServer::tryExtractJsonNumberField_(const std::string& json, const std::string& field, std::string& out)
{
    const std::string needle = "\"" + field + "\"";
    const size_t p = json.find(needle);
    if (p == std::string::npos) return false;
    const size_t colon = json.find(':', p + needle.size());
    if (colon == std::string::npos) return false;
    size_t i = colon + 1;
    while (i < json.size() && std::isspace(static_cast<unsigned char>(json[i]))) ++i;
    size_t j = i;
    while (j < json.size() && (std::isdigit(static_cast<unsigned char>(json[j])) || json[j] == '-' || json[j] == '+' || json[j] == '.' || json[j] == 'e' || json[j] == 'E')) ++j;
    if (j == i) return false;
    out = json.substr(i, j - i);
    return true;
}

std::string WebUiRtServer::websocketAcceptKey_(const std::string& clientKey)
{
    static const std::string magic = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    const std::string data = clientKey + magic;
    Sha1Ctx ctx;
    sha1Update(ctx, reinterpret_cast<const uint8_t*>(data.data()), data.size());
    const auto hash = sha1Final(ctx);
    return base64Encode(hash.data(), hash.size());
}

bool WebUiRtServer::sendWebSocketText_(SocketHandle sock, const std::string& text)
{
    std::vector<uint8_t> frame;
    frame.reserve(text.size() + 16);
    frame.push_back(0x81u);

    const uint64_t len = static_cast<uint64_t>(text.size());
    if (len < 126) {
        frame.push_back(static_cast<uint8_t>(len));
    }
    else if (len <= 0xFFFFu) {
        frame.push_back(126u);
        frame.push_back(static_cast<uint8_t>((len >> 8) & 0xFFu));
        frame.push_back(static_cast<uint8_t>(len & 0xFFu));
    }
    else {
        frame.push_back(127u);
        for (int i = 7; i >= 0; --i) {
            frame.push_back(static_cast<uint8_t>((len >> (i * 8)) & 0xFFu));
        }
    }

    frame.insert(frame.end(), text.begin(), text.end());
    return sendRaw_(sock, frame.data(), frame.size());
}

bool WebUiRtServer::sendWebSocketPong_(SocketHandle sock, const std::vector<uint8_t>& payload)
{
    std::vector<uint8_t> frame;
    frame.push_back(0x8Au);
    const uint64_t len = payload.size();
    if (len < 126) {
        frame.push_back(static_cast<uint8_t>(len));
    }
    else if (len <= 0xFFFFu) {
        frame.push_back(126u);
        frame.push_back(static_cast<uint8_t>((len >> 8) & 0xFFu));
        frame.push_back(static_cast<uint8_t>(len & 0xFFu));
    }
    else {
        return false;
    }
    frame.insert(frame.end(), payload.begin(), payload.end());
    return sendRaw_(sock, frame.data(), frame.size());
}

bool WebUiRtServer::readWebSocketFrame_(SocketHandle sock,
                                        std::string& textOut,
                                        int& opcodeOut,
                                        bool& isClose,
                                        int timeoutMs)
{
    textOut.clear();
    opcodeOut = 0;
    isClose = false;

    if (!waitReadable_(sock, timeoutMs)) {
        return false;
    }

    uint8_t hdr[2]{};
    if (!recvExact_(sock, hdr, 2, timeoutMs)) {
        isClose = true;
        return true;
    }

    const bool masked = (hdr[1] & 0x80u) != 0;
    const uint8_t opcode = hdr[0] & 0x0Fu;
    opcodeOut = opcode;
    uint64_t len = hdr[1] & 0x7Fu;

    if (len == 126) {
        uint8_t ext[2]{};
        if (!recvExact_(sock, ext, 2, timeoutMs)) { isClose = true; return true; }
        len = (static_cast<uint64_t>(ext[0]) << 8) | ext[1];
    }
    else if (len == 127) {
        uint8_t ext[8]{};
        if (!recvExact_(sock, ext, 8, timeoutMs)) { isClose = true; return true; }
        len = 0;
        for (int i = 0; i < 8; ++i) len = (len << 8) | ext[i];
    }

    uint8_t mask[4]{};
    if (masked) {
        if (!recvExact_(sock, mask, 4, timeoutMs)) { isClose = true; return true; }
    }

    std::vector<uint8_t> payload(len);
    if (len > 0 && !recvExact_(sock, payload.data(), payload.size(), timeoutMs)) {
        isClose = true;
        return true;
    }

    if (masked) {
        for (uint64_t i = 0; i < len; ++i) payload[static_cast<size_t>(i)] ^= mask[i % 4];
    }

    if (opcode == 0x8) {
        isClose = true;
        return true;
    }
    if (opcode == 0x9) {
        sendWebSocketPong_(sock, payload);
        return true;
    }
    if (opcode == 0xA) {
        return true;
    }
    if (opcode == 0x1) {
        textOut.assign(payload.begin(), payload.end());
        return true;
    }

    return true;
}

} // namespace jc_webui_rt

