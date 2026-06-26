#include "cpm_wifi.h"

#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#  include <ws2tcpip.h>
#else
#  include <arpa/inet.h>
#  include <netdb.h>
#  include <netinet/in.h>
#  include <sys/socket.h>
#  include <unistd.h>
#  define INVALID_SOCKET (-1)
#  define SOCKET_ERROR (-1)
#endif

static char g_cpmWifiLastError[256] = "";

static void CpmWifi_SetLastError(const char *message)
{
    if (message == NULL)
        message = "Wi-Fi/socket error";
    strncpy(g_cpmWifiLastError, message, sizeof(g_cpmWifiLastError) - 1);
    g_cpmWifiLastError[sizeof(g_cpmWifiLastError) - 1] = '\0';
}

static int CpmWifi_FillIpv4Address(const char *host, unsigned short port, struct sockaddr_in *address)
{
    if (address == NULL)
        return -1;
    memset(address, 0, sizeof(*address));
    address->sin_family = AF_INET;
    address->sin_port = htons(port);
    if (host == NULL || host[0] == '\0')
    {
        address->sin_addr.s_addr = htonl(INADDR_ANY);
        return 0;
    }
    if (inet_pton(AF_INET, host, &address->sin_addr) == 1)
        return 0;
    struct hostent *entry = gethostbyname(host);
    if (entry == NULL || entry->h_addr_list == NULL || entry->h_addr_list[0] == NULL)
    {
        CpmWifi_SetLastError("host resolution failed");
        return -2;
    }
    memcpy(&address->sin_addr, entry->h_addr_list[0], (size_t)entry->h_length);
    return 0;
}

int CpmWifi_InitLibrary(void)
{
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
    {
        CpmWifi_SetLastError("WSAStartup failed");
        return -1;
    }
#endif
    return 0;
}

void CpmWifi_ShutdownLibrary(void)
{
#ifdef _WIN32
    WSACleanup();
#endif
}

void CpmWifi_Init(CpmWifiLink *link)
{
    if (link == NULL)
        return;
    link->handle = INVALID_SOCKET;
    link->protocol = CPM_WIFI_PROTOCOL_TCP;
    link->isOpen = 0;
}

int CpmWifi_OpenTcpClient(CpmWifiLink *link, const char *host, unsigned short port)
{
    if (link == NULL)
        return -1;
    CpmWifi_Close(link);
    struct sockaddr_in address;
    if (CpmWifi_FillIpv4Address(host, port, &address) != 0)
        return -2;
    CpmWifiNativeHandle s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET)
    {
        CpmWifi_SetLastError("socket failed");
        return -3;
    }
    if (connect(s, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR)
    {
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        CpmWifi_SetLastError("connect failed");
        return -4;
    }
    link->handle = s;
    link->protocol = CPM_WIFI_PROTOCOL_TCP;
    link->isOpen = 1;
    return 0;
}

int CpmWifi_OpenTcpServer(CpmWifiLink *link, const char *bindAddress, unsigned short port, int backlog)
{
    if (link == NULL)
        return -1;
    CpmWifi_Close(link);
    struct sockaddr_in address;
    if (CpmWifi_FillIpv4Address(bindAddress, port, &address) != 0)
        return -2;
    CpmWifiNativeHandle s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET)
        return -3;
    int reuse = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, (const char *)&reuse, sizeof(reuse));
    if (bind(s, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR || listen(s, backlog <= 0 ? 1 : backlog) == SOCKET_ERROR)
    {
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        CpmWifi_SetLastError("bind/listen failed");
        return -4;
    }
    link->handle = s;
    link->protocol = CPM_WIFI_PROTOCOL_TCP;
    link->isOpen = 1;
    return 0;
}

int CpmWifi_AcceptClient(CpmWifiLink *server, CpmWifiLink *client)
{
    if (!CpmWifi_IsOpen(server) || client == NULL)
        return -1;
    CpmWifi_Init(client);
    CpmWifiNativeHandle s = accept(server->handle, NULL, NULL);
    if (s == INVALID_SOCKET)
        return -2;
    client->handle = s;
    client->protocol = CPM_WIFI_PROTOCOL_TCP;
    client->isOpen = 1;
    return 0;
}

int CpmWifi_OpenUdp(CpmWifiLink *link, const char *bindAddress, unsigned short port)
{
    if (link == NULL)
        return -1;
    CpmWifi_Close(link);
    CpmWifiNativeHandle s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET)
        return -2;
    if (port != 0 || (bindAddress != NULL && bindAddress[0] != '\0'))
    {
        struct sockaddr_in address;
        if (CpmWifi_FillIpv4Address(bindAddress, port, &address) != 0 || bind(s, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR)
        {
#ifdef _WIN32
            closesocket(s);
#else
            close(s);
#endif
            CpmWifi_SetLastError("udp bind failed");
            return -3;
        }
    }
    link->handle = s;
    link->protocol = CPM_WIFI_PROTOCOL_UDP;
    link->isOpen = 1;
    return 0;
}

int CpmWifi_Send(CpmWifiLink *link, const void *data, size_t size, size_t *sent)
{
    if (!CpmWifi_IsOpen(link) || data == NULL)
        return -1;
    int ret = send(link->handle, (const char *)data, (int)size, 0);
    if (ret < 0)
        return -2;
    if (sent != NULL)
        *sent = (size_t)ret;
    return 0;
}

int CpmWifi_Receive(CpmWifiLink *link, void *buffer, size_t bufferSize, size_t *received)
{
    if (!CpmWifi_IsOpen(link) || buffer == NULL || bufferSize == 0)
        return -1;
    int ret = recv(link->handle, (char *)buffer, (int)bufferSize, 0);
    if (ret < 0)
        return -2;
    if (received != NULL)
        *received = (size_t)ret;
    return ret == 0 ? 1 : 0;
}

int CpmWifi_SendTo(CpmWifiLink *link, const char *host, unsigned short port, const void *data, size_t size, size_t *sent)
{
    if (!CpmWifi_IsOpen(link) || data == NULL)
        return -1;
    struct sockaddr_in address;
    if (CpmWifi_FillIpv4Address(host, port, &address) != 0)
        return -2;
    int ret = sendto(link->handle, (const char *)data, (int)size, 0, (struct sockaddr *)&address, sizeof(address));
    if (ret < 0)
        return -3;
    if (sent != NULL)
        *sent = (size_t)ret;
    return 0;
}

int CpmWifi_ReceiveFrom(CpmWifiLink *link, void *buffer, size_t bufferSize, size_t *received, CpmWifiEndpoint *remoteEndpoint)
{
    if (!CpmWifi_IsOpen(link) || buffer == NULL || bufferSize == 0)
        return -1;
    struct sockaddr_in remote;
#ifdef _WIN32
    int remoteSize = sizeof(remote);
#else
    socklen_t remoteSize = sizeof(remote);
#endif
    int ret = recvfrom(link->handle, (char *)buffer, (int)bufferSize, 0, (struct sockaddr *)&remote, &remoteSize);
    if (ret < 0)
        return -2;
    if (received != NULL)
        *received = (size_t)ret;
    if (remoteEndpoint != NULL)
    {
        const char *text = inet_ntoa(remote.sin_addr);
        strncpy(remoteEndpoint->host, text != NULL ? text : "", sizeof(remoteEndpoint->host) - 1);
        remoteEndpoint->host[sizeof(remoteEndpoint->host) - 1] = '\0';
        remoteEndpoint->port = ntohs(remote.sin_port);
    }
    return 0;
}

void CpmWifi_Close(CpmWifiLink *link)
{
    if (link == NULL || !link->isOpen)
        return;
#ifdef _WIN32
    closesocket(link->handle);
#else
    close(link->handle);
#endif
    link->handle = INVALID_SOCKET;
    link->isOpen = 0;
}

int CpmWifi_IsOpen(const CpmWifiLink *link)
{
    return link != NULL && link->isOpen;
}

const char *CpmWifi_LastError(void)
{
    return g_cpmWifiLastError;
}
