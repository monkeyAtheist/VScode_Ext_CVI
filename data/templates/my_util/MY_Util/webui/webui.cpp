#include "webui.h"

#include <algorithm>
#include <chrono>
#include <cstring>
#include <fstream>
#include <filesystem>
#include <sstream>
#include <stdexcept>
#include <vector>

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

namespace jc_webui {

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

    WebUiServer::WebUiServer() = default;

    WebUiServer::~WebUiServer()
    {
        stop();
    }

    bool WebUiServer::start(const WebUiConfig& cfg)
    {
        stop();
        cfg_ = cfg;

#if !defined(_WIN32)
        // Prevent process termination on send() to a closed socket.
        ::signal(SIGPIPE, SIG_IGN);
#endif

        if (!createListenSocket_()) {
            return false;
        }

        registerDefaultRoutes_();
        running_.store(true);
        acceptThread_ = std::thread(&WebUiServer::acceptLoop_, this);
        return true;
    }

    void WebUiServer::stop()
    {
        const bool wasRunning = running_.exchange(false);
        (void)wasRunning;

        closeListenSocket_();

        if (acceptThread_.joinable()) {
            acceptThread_.join();
        }
    }

    std::string WebUiServer::baseUrl(const std::string& hostOrIp) const
    {
        std::ostringstream oss;
        oss << "http://" << (hostOrIp.empty() ? cfg_.bindAddress : hostOrIp) << ":" << cfg_.port;
        return oss.str();
    }

    void WebUiServer::setStateProvider(StateProvider cb)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        stateProvider_ = std::move(cb);
    }

    void WebUiServer::setActionHandler(ActionHandler cb)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        actionHandler_ = std::move(cb);
    }

    void WebUiServer::registerGet(const std::string& route, ApiHandler cb)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        getRoutes_[normalizeRoute_(route)] = std::move(cb);
    }

    void WebUiServer::registerPost(const std::string& route, ApiHandler cb)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        postRoutes_[normalizeRoute_(route)] = std::move(cb);
    }

    void WebUiServer::unregisterGet(const std::string& route)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        getRoutes_.erase(normalizeRoute_(route));
    }

    void WebUiServer::unregisterPost(const std::string& route)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        postRoutes_.erase(normalizeRoute_(route));
    }

    void WebUiServer::addOrUpdateStaticRoute(const std::string& route,
                                             const std::string& content,
                                             const std::string& contentType)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        staticRoutes_[normalizeRoute_(route)] = { content, contentType };
    }

    void WebUiServer::removeStaticRoute(const std::string& route)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        staticRoutes_.erase(normalizeRoute_(route));
    }

    bool WebUiServer::popEvent(UiEvent& outEvent)
    {
        std::lock_guard<std::mutex> lock(eventMutex_);
        if (eventQueue_.empty()) {
            return false;
        }
        outEvent = eventQueue_.front();
        eventQueue_.pop();
        return true;
    }

    size_t WebUiServer::queuedEventCount() const
    {
        std::lock_guard<std::mutex> lock(eventMutex_);
        return eventQueue_.size();
    }

    std::string WebUiServer::jsonEscape(const std::string& s)
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
                    oss << "\\u" << std::hex;
                    oss.width(4);
                    oss.fill('0');
                    oss << (int)(unsigned char)c;
                    out += oss.str();
                }
                else {
                    out.push_back(c);
                }
                break;
            }
        }
        return out;
    }

    std::string WebUiServer::makeOkJson(bool ok, const std::string& message)
    {
        std::ostringstream oss;
        oss << "{\"ok\":" << (ok ? "true" : "false");
        if (!message.empty()) {
            oss << ",\"message\":\"" << jsonEscape(message) << "\"";
        }
        oss << "}";
        return oss.str();
    }

    void WebUiServer::acceptLoop_()
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
            uint16_t remotePort = ntohs(addr.sin_port);

            std::thread(&WebUiServer::handleClient_, this, clientSock, remoteIp, remotePort).detach();
        }
    }

    void WebUiServer::handleClient_(SocketHandle clientSock, const std::string& remoteIp, uint16_t remotePort)
    {
        HttpRequest req;
        req.remoteIp = remoteIp;
        req.remotePort = remotePort;

        if (!readHttpRequest_(clientSock, req, cfg_.clientTimeoutMs)) {
            closeSocket_(clientSock);
            return;
        }

        HttpResponse res = routeRequest_(req);
        sendHttpResponse_(clientSock, res);
        closeSocket_(clientSock);
    }

    bool WebUiServer::createListenSocket_()
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
        else {
            if (inet_pton(AF_INET, cfg_.bindAddress.c_str(), &addr.sin_addr) != 1) {
                closeSocket_(sock);
                return false;
            }
        }

        if (::bind(static_cast<int>(sock), reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) < 0) {
            closeSocket_(sock);
            return false;
        }

        if (::listen(static_cast<int>(sock), 16) < 0) {
            closeSocket_(sock);
            return false;
        }

        listenSock_ = sock;
        return true;
    }

    void WebUiServer::closeListenSocket_()
    {
        if (listenSock_ != kInvalidSocket) {
            closeSocket_(listenSock_);
            listenSock_ = kInvalidSocket;
        }
    }

    void WebUiServer::registerDefaultRoutes_()
    {
        registerGet("/api/ping", [](const HttpRequest&) {
            HttpResponse res;
            res.contentType = "application/json; charset=utf-8";
            res.body = "{\"ok\":true,\"service\":\"jc_webui\"}";
            return res;
        });

        registerGet("/api/state", [this](const HttpRequest&) {
            HttpResponse res;
            res.contentType = "application/json; charset=utf-8";

            StateProvider provider;
            {
                std::lock_guard<std::mutex> lock(routesMutex_);
                provider = stateProvider_;
            }

            res.body = provider ? provider() : std::string("{}");
            if (res.body.empty()) res.body = "{}";
            return res;
        });

        registerPost("/api/action", [this](const HttpRequest& req) {
            UiEvent ev;
            ev.rawBody = req.body;
            ev.params = req.form;
            ev.remoteIp = req.remoteIp;
            ev.remotePort = req.remotePort;

            auto itAction = ev.params.find("action");
            if (itAction != ev.params.end()) {
                ev.action = itAction->second;
            }
            else {
                tryExtractJsonStringField_(req.body, "action", ev.action);
            }

            ActionHandler handler;
            {
                std::lock_guard<std::mutex> lock(routesMutex_);
                handler = actionHandler_;
            }

            {
                std::lock_guard<std::mutex> lock(eventMutex_);
                ev.sequence = ++eventCounter_;
                eventQueue_.push(ev);
            }

            if (handler) {
                handler(ev);
            }

            HttpResponse res;
            res.contentType = "application/json; charset=utf-8";
            res.body = makeOkJson(true, ev.action.empty() ? "event received" : ("action=" + ev.action));
            return res;
        });
    }

    HttpResponse WebUiServer::routeRequest_(const HttpRequest& req)
    {
        if (req.method == "GET") {
            ApiHandler handler;
            {
                std::lock_guard<std::mutex> lock(routesMutex_);
                auto it = getRoutes_.find(req.path);
                if (it != getRoutes_.end()) {
                    handler = it->second;
                }
            }
            if (handler) {
                return handler(req);
            }
        }
        else if (req.method == "POST") {
            ApiHandler handler;
            {
                std::lock_guard<std::mutex> lock(routesMutex_);
                auto it = postRoutes_.find(req.path);
                if (it != postRoutes_.end()) {
                    handler = it->second;
                }
            }
            if (handler) {
                return handler(req);
            }
        }

        HttpResponse embedded = serveEmbeddedRoute_(req.path);
        if (embedded.status != 404) {
            return embedded;
        }

        if (req.method == "GET") {
            return serveStaticFile_(req.path);
        }

        HttpResponse res;
        res.status = 404;
        res.body = "Not found";
        return res;
    }

    HttpResponse WebUiServer::serveEmbeddedRoute_(const std::string& path)
    {
        std::lock_guard<std::mutex> lock(routesMutex_);
        auto it = staticRoutes_.find(path);
        if (it == staticRoutes_.end()) {
            return { 404, "text/plain; charset=utf-8", "Not found", {} };
        }

        HttpResponse res;
        res.status = 200;
        res.contentType = it->second.contentType;
        res.body = it->second.content;
        return res;
    }

    HttpResponse WebUiServer::serveStaticFile_(const std::string& path)
    {
        std::string fixedPath = path;
        if (fixedPath.empty() || fixedPath == "/") {
            fixedPath = "/" + cfg_.indexFile;
        }

        std::string localRel = sanitizePath_(fixedPath);
        fs::path fullPath = fs::path(cfg_.documentRoot) / localRel;

        HttpResponse res;
        if (!fs::exists(fullPath)) {
            res.status = 404;
            res.body = "Not found";
            return res;
        }

        if (fs::is_directory(fullPath)) {
            if (!cfg_.allowDirectoryListing) {
                res.status = 403;
                res.body = "Directory listing disabled";
                return res;
            }
            std::ostringstream oss;
            oss << "<html><body><ul>";
            for (const auto& e : fs::directory_iterator(fullPath)) {
                oss << "<li>" << e.path().filename().string() << "</li>";
            }
            oss << "</ul></body></html>";
            res.contentType = "text/html; charset=utf-8";
            res.body = oss.str();
            return res;
        }

        std::ifstream ifs(fullPath, std::ios::binary);
        if (!ifs) {
            res.status = 500;
            res.body = "File open failed";
            return res;
        }

        std::ostringstream oss;
        oss << ifs.rdbuf();
        res.status = 200;
        res.contentType = contentTypeFromPath_(fullPath.string());
        res.body = oss.str();
        return res;
    }

    std::string WebUiServer::statusText_(int code)
    {
        switch (code) {
        case 200: return "OK";
        case 201: return "Created";
        case 204: return "No Content";
        case 400: return "Bad Request";
        case 403: return "Forbidden";
        case 404: return "Not Found";
        case 405: return "Method Not Allowed";
        case 500: return "Internal Server Error";
        default:  return "Status";
        }
    }

    std::string WebUiServer::contentTypeFromPath_(const std::string& path)
    {
        std::string ext = fs::path(path).extension().string();
        std::transform(ext.begin(), ext.end(), ext.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });

        if (ext == ".html" || ext == ".htm") return "text/html; charset=utf-8";
        if (ext == ".css") return "text/css; charset=utf-8";
        if (ext == ".js") return "application/javascript; charset=utf-8";
        if (ext == ".json") return "application/json; charset=utf-8";
        if (ext == ".svg") return "image/svg+xml";
        if (ext == ".png") return "image/png";
        if (ext == ".jpg" || ext == ".jpeg") return "image/jpeg";
        if (ext == ".gif") return "image/gif";
        if (ext == ".ico") return "image/x-icon";
        if (ext == ".txt") return "text/plain; charset=utf-8";
        return "application/octet-stream";
    }

    std::string WebUiServer::urlDecode_(const std::string& s)
    {
        std::string out;
        out.reserve(s.size());

        for (size_t i = 0; i < s.size(); ++i) {
            char c = s[i];
            if (c == '+') {
                out.push_back(' ');
            }
            else if (c == '%' && i + 2 < s.size()) {
                auto hexVal = [](char h) -> int {
                    if (h >= '0' && h <= '9') return h - '0';
                    if (h >= 'a' && h <= 'f') return h - 'a' + 10;
                    if (h >= 'A' && h <= 'F') return h - 'A' + 10;
                    return -1;
                };
                int hi = hexVal(s[i + 1]);
                int lo = hexVal(s[i + 2]);
                if (hi >= 0 && lo >= 0) {
                    out.push_back(static_cast<char>((hi << 4) | lo));
                    i += 2;
                }
                else {
                    out.push_back(c);
                }
            }
            else {
                out.push_back(c);
            }
        }
        return out;
    }

    std::string WebUiServer::trim_(std::string s)
    {
        while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front()))) s.erase(s.begin());
        while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.pop_back();
        return s;
    }

    std::string WebUiServer::toLower_(std::string s)
    {
        std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        return s;
    }

    bool WebUiServer::readHttpRequest_(SocketHandle sock, HttpRequest& req, int timeoutMs)
    {
        std::string raw;
        raw.reserve(4096);
        char buf[1024];

        while (raw.find("\r\n\r\n") == std::string::npos) {
            if (!waitReadable_(sock, timeoutMs)) {
                return false;
            }

#if defined(_WIN32)
            int n = ::recv(static_cast<SOCKET>(sock), buf, static_cast<int>(sizeof(buf)), 0);
#else
            int n = static_cast<int>(::recv(sock, buf, sizeof(buf), 0));
#endif
            if (n <= 0) {
                return false;
            }
            raw.append(buf, buf + n);
            if (raw.size() > 1024 * 1024) {
                return false;
            }
        }

        const size_t hdrEnd = raw.find("\r\n\r\n");
        std::string hdr = raw.substr(0, hdrEnd);
        std::string remaining = raw.substr(hdrEnd + 4);

        std::istringstream iss(hdr);
        std::string line;
        if (!std::getline(iss, line)) {
            return false;
        }
        if (!line.empty() && line.back() == '\r') line.pop_back();

        {
            std::istringstream rls(line);
            rls >> req.method >> req.target >> req.httpVersion;
            if (req.method.empty() || req.target.empty()) {
                return false;
            }
        }

        size_t qm = req.target.find('?');
        req.path = normalizeRoute_(qm == std::string::npos ? req.target : req.target.substr(0, qm));
        if (qm != std::string::npos) {
            req.query = parseKvEncoded_(req.target.substr(qm + 1));
        }

        while (std::getline(iss, line)) {
            if (!line.empty() && line.back() == '\r') line.pop_back();
            size_t colon = line.find(':');
            if (colon == std::string::npos) continue;
            std::string key = toLower_(trim_(line.substr(0, colon)));
            std::string value = trim_(line.substr(colon + 1));
            req.headers[key] = value;
        }

        size_t contentLen = 0;
        auto itCl = req.headers.find("content-length");
        if (itCl != req.headers.end()) {
            try {
                contentLen = static_cast<size_t>(std::stoul(itCl->second));
            }
            catch (...) {
                return false;
            }
        }

        req.body = remaining;
        while (req.body.size() < contentLen) {
            if (!waitReadable_(sock, timeoutMs)) {
                return false;
            }
#if defined(_WIN32)
            int n = ::recv(static_cast<SOCKET>(sock), buf, static_cast<int>(sizeof(buf)), 0);
#else
            int n = static_cast<int>(::recv(sock, buf, sizeof(buf), 0));
#endif
            if (n <= 0) {
                return false;
            }
            req.body.append(buf, buf + n);
        }
        if (req.body.size() > contentLen) {
            req.body.resize(contentLen);
        }

        auto itCt = req.headers.find("content-type");
        if (itCt != req.headers.end()) {
            const std::string ct = toLower_(itCt->second);
            if (ct.find("application/x-www-form-urlencoded") != std::string::npos) {
                req.form = parseKvEncoded_(req.body);
            }
        }

        return true;
    }

    bool WebUiServer::sendHttpResponse_(SocketHandle sock, const HttpResponse& res)
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

        const std::string hdr = oss.str();
        std::string all = hdr + res.body;

        size_t sent = 0;
        while (sent < all.size()) {
            if (!waitWritable_(sock, 2000)) {
                return false;
            }
#if defined(_WIN32)
            int n = ::send(static_cast<SOCKET>(sock), all.data() + sent, static_cast<int>(all.size() - sent), 0);
#else
            int flags = 0;
            #ifdef MSG_NOSIGNAL
                flags |= MSG_NOSIGNAL;
            #endif
            int n = static_cast<int>(::send(sock, all.data() + sent, all.size() - sent, flags));
#endif
            if (n <= 0) {
                return false;
            }
            sent += static_cast<size_t>(n);
        }
        return true;
    }

    void WebUiServer::closeSocket_(SocketHandle sock)
    {
        if (sock == kInvalidSocket) return;
#if defined(_WIN32)
        ::closesocket(static_cast<SOCKET>(sock));
#else
        ::close(sock);
#endif
    }

    bool WebUiServer::setSocketReuseAddr_(SocketHandle sock)
    {
        int yes = 1;
#if defined(_WIN32)
        return ::setsockopt(static_cast<SOCKET>(sock), SOL_SOCKET, SO_REUSEADDR, reinterpret_cast<const char*>(&yes), sizeof(yes)) == 0;
#else
        return ::setsockopt(sock, SOL_SOCKET, SO_REUSEADDR, &yes, sizeof(yes)) == 0;
#endif
    }

    bool WebUiServer::waitReadable_(SocketHandle sock, int timeoutMs)
    {
        if (sock == kInvalidSocket) return false;

        fd_set rfds;
        FD_ZERO(&rfds);
        FD_SET(static_cast<int>(sock), &rfds);

        timeval tv{};
        tv.tv_sec = timeoutMs / 1000;
        tv.tv_usec = (timeoutMs % 1000) * 1000;

#if defined(_WIN32)
        int rc = ::select(0, &rfds, nullptr, nullptr, &tv);
#else
        int rc = ::select(static_cast<int>(sock) + 1, &rfds, nullptr, nullptr, &tv);
#endif
        return rc > 0;
    }

    bool WebUiServer::waitWritable_(SocketHandle sock, int timeoutMs)
    {
        if (sock == kInvalidSocket) return false;

        fd_set wfds;
        FD_ZERO(&wfds);
        FD_SET(static_cast<int>(sock), &wfds);

        timeval tv{};
        tv.tv_sec = timeoutMs / 1000;
        tv.tv_usec = (timeoutMs % 1000) * 1000;

#if defined(_WIN32)
        int rc = ::select(0, nullptr, &wfds, nullptr, &tv);
#else
        int rc = ::select(static_cast<int>(sock) + 1, nullptr, &wfds, nullptr, &tv);
#endif
        return rc > 0;
    }

    std::unordered_map<std::string, std::string> WebUiServer::parseKvEncoded_(const std::string& s, char pairSep, char kvSep)
    {
        std::unordered_map<std::string, std::string> out;
        std::stringstream ss(s);
        std::string item;

        while (std::getline(ss, item, pairSep)) {
            if (item.empty()) continue;
            size_t eq = item.find(kvSep);
            std::string key = eq == std::string::npos ? item : item.substr(0, eq);
            std::string value = eq == std::string::npos ? std::string() : item.substr(eq + 1);
            out[urlDecode_(key)] = urlDecode_(value);
        }
        return out;
    }

    std::string WebUiServer::normalizeRoute_(const std::string& route)
    {
        if (route.empty()) return "/";
        std::string out = route;
        if (out.front() != '/') out.insert(out.begin(), '/');
        while (out.size() > 1 && out.back() == '/') out.pop_back();
        return out;
    }

    std::string WebUiServer::sanitizePath_(const std::string& path)
    {
        std::string p = normalizeRoute_(path);
        std::vector<std::string> parts;
        std::stringstream ss(p);
        std::string token;
        while (std::getline(ss, token, '/')) {
            if (token.empty() || token == ".") continue;
            if (token == "..") continue;
            parts.push_back(token);
        }

        std::ostringstream oss;
        for (size_t i = 0; i < parts.size(); ++i) {
            if (i) oss << '/';
            oss << parts[i];
        }
        return oss.str();
    }

    bool WebUiServer::tryExtractJsonStringField_(const std::string& json, const std::string& field, std::string& out)
    {
        const std::string key = "\"" + field + "\"";
        size_t pos = json.find(key);
        if (pos == std::string::npos) return false;
        pos = json.find(':', pos + key.size());
        if (pos == std::string::npos) return false;
        ++pos;
        while (pos < json.size() && std::isspace(static_cast<unsigned char>(json[pos]))) ++pos;
        if (pos >= json.size() || json[pos] != '"') return false;
        ++pos;

        std::string result;
        bool escape = false;
        while (pos < json.size()) {
            char c = json[pos++];
            if (escape) {
                result.push_back(c);
                escape = false;
            }
            else if (c == '\\') {
                escape = true;
            }
            else if (c == '"') {
                out = result;
                return true;
            }
            else {
                result.push_back(c);
            }
        }
        return false;
    }

    std::string WebUiServer::readFileText_(const std::string& path)
    {
        std::ifstream ifs(path, std::ios::binary);
        if (!ifs) return {};
        std::ostringstream oss;
        oss << ifs.rdbuf();
        return oss.str();
    }

} // namespace jc_webui

