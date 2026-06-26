#ifndef CPM_WIFI_H
#define CPM_WIFI_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
typedef SOCKET CpmWifiNativeHandle;
#else
typedef int CpmWifiNativeHandle;
#endif

typedef enum CpmWifiProtocol
{
    CPM_WIFI_PROTOCOL_TCP = 1,
    CPM_WIFI_PROTOCOL_UDP = 2
} CpmWifiProtocol;

typedef struct CpmWifiEndpoint
{
    char host[128];
    unsigned short port;
} CpmWifiEndpoint;

typedef struct CpmWifiLink
{
    CpmWifiNativeHandle handle;
    CpmWifiProtocol protocol;
    int isOpen;
} CpmWifiLink;

int CpmWifi_InitLibrary(void);
void CpmWifi_ShutdownLibrary(void);
void CpmWifi_Init(CpmWifiLink *link);
int CpmWifi_OpenTcpClient(CpmWifiLink *link, const char *host, unsigned short port);
int CpmWifi_OpenTcpServer(CpmWifiLink *link, const char *bindAddress, unsigned short port, int backlog);
int CpmWifi_AcceptClient(CpmWifiLink *server, CpmWifiLink *client);
int CpmWifi_OpenUdp(CpmWifiLink *link, const char *bindAddress, unsigned short port);
int CpmWifi_Send(CpmWifiLink *link, const void *data, size_t size, size_t *sent);
int CpmWifi_Receive(CpmWifiLink *link, void *buffer, size_t bufferSize, size_t *received);
int CpmWifi_SendTo(CpmWifiLink *link, const char *host, unsigned short port, const void *data, size_t size, size_t *sent);
int CpmWifi_ReceiveFrom(CpmWifiLink *link, void *buffer, size_t bufferSize, size_t *received, CpmWifiEndpoint *remoteEndpoint);
void CpmWifi_Close(CpmWifiLink *link);
int CpmWifi_IsOpen(const CpmWifiLink *link);
const char *CpmWifi_LastError(void);

#ifdef __cplusplus
}
#endif

#endif /* CPM_WIFI_H */
