/**
 * @file cpm_wifi.h
 * @brief CPM C Wi-Fi TCP/UDP application communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - uses normal TCP/UDP sockets once the operating system is connected to Wi-Fi;
 * - supports client/server modes, UDP endpoints and peer tracking;
 * - provides text, byte and small packet helpers;
 * - keeps Wi-Fi transport code separate from SSID/password association logic.
 *
 * @par Typical applications
 * - wireless communication with ESP32/Raspberry Pi services;
 * - test tools that talk to a Wi-Fi instrument over TCP or UDP;
 * - local wireless telemetry channels.
 *
 * @par Usage notes
 * - This module does not connect the PC to an SSID; configure Wi-Fi with the OS first.
 * - On Windows, link with ws2_32; CPM adds it automatically for this bundle.
 * - For reliable messages over TCP, add delimiters or use the packet helpers.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_wifi.h"
 * 
 * CpmWifiLink link;
 * CpmWifi_InitLibrary();
 * CpmWifi_Init(&link);
 * if (CpmWifi_OpenTcpClient(&link, "192.168.1.42", 5000) == 0)
 * {
 *     CpmWifi_Send(&link, "PING\n", 5, NULL);
 *     CpmWifi_Close(&link);
 * }
 * CpmWifi_ShutdownLibrary();
 * @endcode
 */
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
