#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

#include <opencv2/opencv.hpp>

namespace jc_webui_rt {

struct WebUiRtConfig {
    std::string bindAddress = "0.0.0.0";
    uint16_t port = 8080;
    std::string documentRoot = "./webui_rt_demo";
    std::string indexFile = "index.html";
    std::string wsRoute = "/ws";
    std::string mjpegRoute = "/stream.mjpg";
    int acceptTimeoutMs = 250;
    int clientTimeoutMs = 2000;
    int wsPollTimeoutMs = 100;
    int telemetryPeriodMs = 100;
    int jpegQuality = 80;
    bool allowNetworkControl = true;
};

struct HttpRequest {
    std::string method;
    std::string target;
    std::string path;
    std::string httpVersion;
    std::string body;
    std::unordered_map<std::string, std::string> headers;
    std::unordered_map<std::string, std::string> query;
    std::string remoteIp;
    uint16_t remotePort = 0;
};

struct HttpResponse {
    int status = 200;
    std::string contentType = "text/plain; charset=utf-8";
    std::string body;
    std::unordered_map<std::string, std::string> headers;
};

struct WebCommandEvent {
    uint64_t sequence = 0;
    std::string remoteIp;
    uint16_t remotePort = 0;
    std::string rawJson;
    std::string type;
    std::string action;
    std::unordered_map<std::string, std::string> fields;
};

using HttpHandler = std::function<HttpResponse(const HttpRequest&)>;
using TelemetryProvider = std::function<std::string(void)>;       // doit renvoyer une chaine JSON valide
using CommandHandler = std::function<void(const WebCommandEvent&)>;

class WebUiRtServer {
public:
    WebUiRtServer();
    ~WebUiRtServer();

    WebUiRtServer(const WebUiRtServer&) = delete;
    WebUiRtServer& operator=(const WebUiRtServer&) = delete;

    bool start(const WebUiRtConfig& cfg);
    void stop();
    bool isRunning() const { return running_.load(); }

    const WebUiRtConfig& config() const { return cfg_; }
    void setJpegQuality(int quality);
    int jpegQuality() const;
    std::string baseUrl(const std::string& hostOrIp = "") const;

    void setTelemetryProvider(TelemetryProvider cb);
    void setCommandHandler(CommandHandler cb);

    void registerGet(const std::string& route, HttpHandler cb);
    void registerPost(const std::string& route, HttpHandler cb);
    void addOrUpdateStaticRoute(const std::string& route,
                                const std::string& content,
                                const std::string& contentType = "text/plain; charset=utf-8");

    bool popCommand(WebCommandEvent& outEvent);
    size_t queuedCommandCount() const;

    bool updateFrame(const cv::Mat& frameBgr);
    bool updateFrameJpeg(const std::vector<uint8_t>& jpegBytes, int width = 0, int height = 0);

    void broadcastText(const std::string& text);
    void broadcastJsonEnvelope(const std::string& type, const std::string& jsonPayload);

    static std::string jsonEscape(const std::string& s);
    static std::string makeOkJson(bool ok, const std::string& message = "");

private:
#if defined(_WIN32)
    using SocketHandle = uintptr_t;
    static constexpr SocketHandle kInvalidSocket = static_cast<SocketHandle>(~0ULL);
#else
    using SocketHandle = int;
    static constexpr SocketHandle kInvalidSocket = -1;
#endif

    struct StaticRoute {
        std::string content;
        std::string contentType;
    };

    struct WsClient {
        SocketHandle sock = kInvalidSocket;
        std::string remoteIp;
        uint16_t remotePort = 0;
        std::mutex sendMutex;
        std::atomic<bool> alive{ true };
    };

    WebUiRtConfig cfg_{};
    std::atomic<bool> running_{ false };

    SocketHandle listenSock_ = kInvalidSocket;
    std::thread acceptThread_;
    std::thread telemetryThread_;

    mutable std::mutex routesMutex_;
    std::unordered_map<std::string, HttpHandler> getRoutes_;
    std::unordered_map<std::string, HttpHandler> postRoutes_;
    std::unordered_map<std::string, StaticRoute> staticRoutes_;
    TelemetryProvider telemetryProvider_;
    CommandHandler commandHandler_;

    mutable std::mutex cmdMutex_;
    std::queue<WebCommandEvent> cmdQueue_;
    std::atomic<uint64_t> commandCounter_{ 0 };

    mutable std::mutex wsMutex_;
    std::vector<std::shared_ptr<WsClient>> wsClients_;

    mutable std::mutex frameMutex_;
    std::vector<uint8_t> lastJpegFrame_;
    int lastFrameWidth_ = 0;
    int lastFrameHeight_ = 0;
    std::atomic<int> jpegQualityRuntime_{80};

    void acceptLoop_();
    void telemetryLoop_();
    void handleClient_(SocketHandle clientSock, const std::string& remoteIp, uint16_t remotePort);
    bool createListenSocket_();
    void closeListenSocket_();
    void registerDefaultRoutes_();

    HttpResponse routeHttpRequest_(const HttpRequest& req);
    HttpResponse serveFile_(const std::string& path);
    HttpResponse serveEmbedded_(const std::string& path);

    bool handleWebSocketUpgrade_(SocketHandle sock, const HttpRequest& req);
    bool handleMjpegStream_(SocketHandle sock);
    void removeDeadWebSockets_();
    void enqueueCommand_(const WebCommandEvent& ev);

    static bool readHttpRequest_(SocketHandle sock, HttpRequest& req, int timeoutMs);
    static bool sendHttpResponse_(SocketHandle sock, const HttpResponse& res);
    static bool sendRaw_(SocketHandle sock, const void* data, size_t size);
    static bool recvExact_(SocketHandle sock, void* data, size_t size, int timeoutMs);
    static bool waitReadable_(SocketHandle sock, int timeoutMs);
    static bool waitWritable_(SocketHandle sock, int timeoutMs);
    static void closeSocket_(SocketHandle sock);
    static bool setSocketReuseAddr_(SocketHandle sock);

    static std::string normalizeRoute_(const std::string& route);
    static std::string sanitizePath_(const std::string& path);
    static std::string statusText_(int code);
    static std::string contentTypeFromPath_(const std::string& path);
    static std::unordered_map<std::string, std::string> parseKvEncoded_(const std::string& s, char pairSep = '&', char kvSep = '=');
    static std::string urlDecode_(const std::string& s);
    static std::string trim_(std::string s);
    static std::string toLower_(std::string s);
    static std::string readFileText_(const std::string& path);
    static std::vector<uint8_t> readFileBinary_(const std::string& path);
    static bool startsWith_(const std::string& s, const std::string& prefix);
    static bool tryExtractJsonStringField_(const std::string& json, const std::string& field, std::string& out);
    static bool tryExtractJsonNumberField_(const std::string& json, const std::string& field, std::string& out);

    static std::string websocketAcceptKey_(const std::string& clientKey);
    static bool sendWebSocketText_(SocketHandle sock, const std::string& text);
    static bool sendWebSocketPong_(SocketHandle sock, const std::vector<uint8_t>& payload);
    static bool readWebSocketFrame_(SocketHandle sock,
                                    std::string& textOut,
                                    int& opcodeOut,
                                    bool& isClose,
                                    int timeoutMs);
};

} // namespace jc_webui_rt

