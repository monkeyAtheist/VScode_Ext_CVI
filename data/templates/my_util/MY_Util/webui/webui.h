#pragma once

#include <atomic>
#include <cstdint>
#include <functional>
#include <mutex>
#include <queue>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace jc_webui {

    struct WebUiConfig {
        std::string bindAddress = "0.0.0.0";
        uint16_t port = 8080;
        std::string documentRoot = "./webui";
        std::string indexFile = "index.html";
        int acceptTimeoutMs = 250;
        int clientTimeoutMs = 2000;
        bool allowDirectoryListing = false;
    };

    struct HttpRequest {
        std::string method;
        std::string target;
        std::string path;
        std::string httpVersion;
        std::string body;
        std::unordered_map<std::string, std::string> query;
        std::unordered_map<std::string, std::string> form;
        std::unordered_map<std::string, std::string> headers;
        std::string remoteIp;
        uint16_t remotePort = 0;
    };

    struct HttpResponse {
        int status = 200;
        std::string contentType = "text/plain; charset=utf-8";
        std::string body;
        std::unordered_map<std::string, std::string> headers;
    };

    struct UiEvent {
        uint64_t sequence = 0;
        std::string action;
        std::unordered_map<std::string, std::string> params;
        std::string rawBody;
        std::string remoteIp;
        uint16_t remotePort = 0;
    };

    using ApiHandler = std::function<HttpResponse(const HttpRequest&)>;
    using StateProvider = std::function<std::string(void)>;   // doit renvoyer une chaine JSON
    using ActionHandler = std::function<void(const UiEvent&)>;

    class WebUiServer {
    public:
        WebUiServer();
        ~WebUiServer();

        WebUiServer(const WebUiServer&) = delete;
        WebUiServer& operator=(const WebUiServer&) = delete;

        WebUiServer(WebUiServer&&) = delete;
        WebUiServer& operator=(WebUiServer&&) = delete;

        bool start(const WebUiConfig& cfg);
        void stop();
        bool isRunning() const { return running_.load(); }

        const WebUiConfig& config() const { return cfg_; }
        std::string baseUrl(const std::string& hostOrIp = "") const;

        void setStateProvider(StateProvider cb);
        void setActionHandler(ActionHandler cb);

        void registerGet(const std::string& route, ApiHandler cb);
        void registerPost(const std::string& route, ApiHandler cb);
        void unregisterGet(const std::string& route);
        void unregisterPost(const std::string& route);

        void addOrUpdateStaticRoute(const std::string& route,
                                    const std::string& content,
                                    const std::string& contentType = "text/plain; charset=utf-8");
        void removeStaticRoute(const std::string& route);

        bool popEvent(UiEvent& outEvent);
        size_t queuedEventCount() const;

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

        struct StaticPage {
            std::string content;
            std::string contentType;
        };

        WebUiConfig cfg_{};
        std::atomic<bool> running_{ false };
        std::thread acceptThread_;
        SocketHandle listenSock_ = kInvalidSocket;

        mutable std::mutex routesMutex_;
        std::unordered_map<std::string, ApiHandler> getRoutes_;
        std::unordered_map<std::string, ApiHandler> postRoutes_;
        std::unordered_map<std::string, StaticPage> staticRoutes_;
        StateProvider stateProvider_;
        ActionHandler actionHandler_;

        mutable std::mutex eventMutex_;
        std::queue<UiEvent> eventQueue_;
        uint64_t eventCounter_ = 0;

        void acceptLoop_();
        void handleClient_(SocketHandle clientSock, const std::string& remoteIp, uint16_t remotePort);

        bool createListenSocket_();
        void closeListenSocket_();
        void registerDefaultRoutes_();

        HttpResponse routeRequest_(const HttpRequest& req);
        HttpResponse serveStaticFile_(const std::string& path);
        HttpResponse serveEmbeddedRoute_(const std::string& path);

        static std::string statusText_(int code);
        static std::string contentTypeFromPath_(const std::string& path);
        static std::string urlDecode_(const std::string& s);
        static std::string trim_(std::string s);
        static std::string toLower_(std::string s);
        static bool readHttpRequest_(SocketHandle sock, HttpRequest& req, int timeoutMs);
        static bool sendHttpResponse_(SocketHandle sock, const HttpResponse& res);
        static void closeSocket_(SocketHandle sock);
        static bool setSocketReuseAddr_(SocketHandle sock);
        static bool waitReadable_(SocketHandle sock, int timeoutMs);
        static bool waitWritable_(SocketHandle sock, int timeoutMs);
        static std::unordered_map<std::string, std::string> parseKvEncoded_(const std::string& s, char pairSep = '&', char kvSep = '=');
        static std::string normalizeRoute_(const std::string& route);
        static std::string sanitizePath_(const std::string& path);
        static bool tryExtractJsonStringField_(const std::string& json, const std::string& field, std::string& out);
        static std::string readFileText_(const std::string& path);
    };

} // namespace jc_webui

