/**
 * @file cpm_socket.c
 * @brief Implementation of the cpm_socket C bundle.
 *
 * Generated bundle implementation. Public API semantics are documented in the matching header file.
 */
#include "cpm_socket.h"

#include <errno.h>
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

static char g_cpmSocketLastError[256] = "";

/**
 * @brief Implements the CpmSocket_SetLastErrorText operation.
 * @param message See the matching header for semantic details.
 */
static void CpmSocket_SetLastErrorText(const char *message)
{
    if (message == NULL)
        message = "socket error";
    strncpy(g_cpmSocketLastError, message, sizeof(g_cpmSocketLastError) - 1);
    g_cpmSocketLastError[sizeof(g_cpmSocketLastError) - 1] = '\0';
}

/**
 * @brief Implements the CpmSocket_FillAddress operation.
 * @param host See the matching header for semantic details.
 * @param port See the matching header for semantic details.
 * @param address See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
static int CpmSocket_FillAddress(const char *host, unsigned short port, struct sockaddr_in *address)
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
        return -2;
    memcpy(&address->sin_addr, entry->h_addr_list[0], (size_t)entry->h_length);
    return 0;
}

/**
 * @brief Implements the CpmSocket_InitLibrary operation.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_InitLibrary(void)
{
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
    {
        CpmSocket_SetLastErrorText("WSAStartup failed");
        return -1;
    }
#endif
    return 0;
}

/**
 * @brief Implements the CpmSocket_ShutdownLibrary operation.
 */
void CpmSocket_ShutdownLibrary(void)
{
#ifdef _WIN32
    WSACleanup();
#endif
}

/**
 * @brief Implements the CpmSocket_Init operation.
 * @param socketObj See the matching header for semantic details.
 */
void CpmSocket_Init(CpmSocket *socketObj)
{
    if (socketObj == NULL)
        return;
    socketObj->handle = INVALID_SOCKET;
    socketObj->type = 0;
    socketObj->isOpen = 0;
}

/**
 * @brief Implements the CpmSocket_TcpConnect operation.
 * @param socketObj See the matching header for semantic details.
 * @param host See the matching header for semantic details.
 * @param port See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_TcpConnect(CpmSocket *socketObj, const char *host, unsigned short port)
{
    if (socketObj == NULL)
        return -1;
    CpmSocket_Close(socketObj);
    struct sockaddr_in address;
    if (CpmSocket_FillAddress(host, port, &address) != 0)
        return -2;
    CpmSocketNativeHandle s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (s == INVALID_SOCKET)
        return -3;
    if (connect(s, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR)
    {
#ifdef _WIN32
        closesocket(s);
#else
        close(s);
#endif
        CpmSocket_SetLastErrorText("connect failed");
        return -4;
    }
    socketObj->handle = s;
    socketObj->type = SOCK_STREAM;
    socketObj->isOpen = 1;
    return 0;
}

/**
 * @brief Implements the CpmSocket_TcpListen operation.
 * @param socketObj See the matching header for semantic details.
 * @param bindAddress See the matching header for semantic details.
 * @param port See the matching header for semantic details.
 * @param backlog See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_TcpListen(CpmSocket *socketObj, const char *bindAddress, unsigned short port, int backlog)
{
    if (socketObj == NULL)
        return -1;
    CpmSocket_Close(socketObj);
    struct sockaddr_in address;
    if (CpmSocket_FillAddress(bindAddress, port, &address) != 0)
        return -2;
    CpmSocketNativeHandle s = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
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
        CpmSocket_SetLastErrorText("bind/listen failed");
        return -4;
    }
    socketObj->handle = s;
    socketObj->type = SOCK_STREAM;
    socketObj->isOpen = 1;
    return 0;
}

/**
 * @brief Implements the CpmSocket_TcpAccept operation.
 * @param server See the matching header for semantic details.
 * @param client See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_TcpAccept(CpmSocket *server, CpmSocket *client)
{
    if (!CpmSocket_IsOpen(server) || client == NULL)
        return -1;
    CpmSocket_Init(client);
    CpmSocketNativeHandle s = accept(server->handle, NULL, NULL);
    if (s == INVALID_SOCKET)
    {
        CpmSocket_SetLastErrorText("accept failed");
        return -2;
    }
    client->handle = s;
    client->type = SOCK_STREAM;
    client->isOpen = 1;
    return 0;
}

/**
 * @brief Implements the CpmSocket_UdpOpen operation.
 * @param socketObj See the matching header for semantic details.
 * @param bindAddress See the matching header for semantic details.
 * @param port See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_UdpOpen(CpmSocket *socketObj, const char *bindAddress, unsigned short port)
{
    if (socketObj == NULL)
        return -1;
    CpmSocket_Close(socketObj);
    CpmSocketNativeHandle s = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (s == INVALID_SOCKET)
        return -2;
    if (port != 0 || (bindAddress != NULL && bindAddress[0] != '\0'))
    {
        struct sockaddr_in address;
        if (CpmSocket_FillAddress(bindAddress, port, &address) != 0 || bind(s, (struct sockaddr *)&address, sizeof(address)) == SOCKET_ERROR)
        {
#ifdef _WIN32
            closesocket(s);
#else
            close(s);
#endif
            CpmSocket_SetLastErrorText("udp bind failed");
            return -3;
        }
    }
    socketObj->handle = s;
    socketObj->type = SOCK_DGRAM;
    socketObj->isOpen = 1;
    return 0;
}

/**
 * @brief Implements the CpmSocket_Send operation.
 * @param socketObj See the matching header for semantic details.
 * @param data See the matching header for semantic details.
 * @param size See the matching header for semantic details.
 * @param sent See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_Send(CpmSocket *socketObj, const void *data, size_t size, size_t *sent)
{
    if (sent != NULL)
        *sent = 0;
    if (!CpmSocket_IsOpen(socketObj) || data == NULL)
        return -1;
    int result = send(socketObj->handle, (const char *)data, (int)size, 0);
    if (result == SOCKET_ERROR)
    {
        CpmSocket_SetLastErrorText("send failed");
        return -2;
    }
    if (sent != NULL)
        *sent = (size_t)result;
    return 0;
}

/**
 * @brief Implements the CpmSocket_Recv operation.
 * @param socketObj See the matching header for semantic details.
 * @param buffer See the matching header for semantic details.
 * @param bufferSize See the matching header for semantic details.
 * @param received See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_Recv(CpmSocket *socketObj, void *buffer, size_t bufferSize, size_t *received)
{
    if (received != NULL)
        *received = 0;
    if (!CpmSocket_IsOpen(socketObj) || buffer == NULL || bufferSize == 0)
        return -1;
    int result = recv(socketObj->handle, (char *)buffer, (int)bufferSize, 0);
    if (result == SOCKET_ERROR)
    {
        CpmSocket_SetLastErrorText("recv failed");
        return -2;
    }
    if (received != NULL)
        *received = (size_t)result;
    return 0;
}

/**
 * @brief Implements the CpmSocket_UdpSendTo operation.
 * @param socketObj See the matching header for semantic details.
 * @param host See the matching header for semantic details.
 * @param port See the matching header for semantic details.
 * @param data See the matching header for semantic details.
 * @param size See the matching header for semantic details.
 * @param sent See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_UdpSendTo(CpmSocket *socketObj, const char *host, unsigned short port, const void *data, size_t size, size_t *sent)
{
    if (sent != NULL)
        *sent = 0;
    if (!CpmSocket_IsOpen(socketObj) || data == NULL)
        return -1;
    struct sockaddr_in address;
    if (CpmSocket_FillAddress(host, port, &address) != 0)
        return -2;
    int result = sendto(socketObj->handle, (const char *)data, (int)size, 0, (struct sockaddr *)&address, sizeof(address));
    if (result == SOCKET_ERROR)
    {
        CpmSocket_SetLastErrorText("sendto failed");
        return -3;
    }
    if (sent != NULL)
        *sent = (size_t)result;
    return 0;
}

/**
 * @brief Implements the CpmSocket_UdpRecvFrom operation.
 * @param socketObj See the matching header for semantic details.
 * @param buffer See the matching header for semantic details.
 * @param bufferSize See the matching header for semantic details.
 * @param received See the matching header for semantic details.
 * @param remoteHost See the matching header for semantic details.
 * @param remoteHostSize See the matching header for semantic details.
 * @param remotePort See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_UdpRecvFrom(CpmSocket *socketObj, void *buffer, size_t bufferSize, size_t *received, char *remoteHost, size_t remoteHostSize, unsigned short *remotePort)
{
    if (received != NULL)
        *received = 0;
    if (!CpmSocket_IsOpen(socketObj) || buffer == NULL || bufferSize == 0)
        return -1;
    struct sockaddr_in address;
#ifdef _WIN32
    int addressSize = sizeof(address);
#else
    socklen_t addressSize = sizeof(address);
#endif
    int result = recvfrom(socketObj->handle, (char *)buffer, (int)bufferSize, 0, (struct sockaddr *)&address, &addressSize);
    if (result == SOCKET_ERROR)
    {
        CpmSocket_SetLastErrorText("recvfrom failed");
        return -2;
    }
    if (received != NULL)
        *received = (size_t)result;
    if (remoteHost != NULL && remoteHostSize > 0)
    {
        const char *text = inet_ntoa(address.sin_addr);
        strncpy(remoteHost, text != NULL ? text : "", remoteHostSize - 1);
        remoteHost[remoteHostSize - 1] = '\0';
    }
    if (remotePort != NULL)
        *remotePort = ntohs(address.sin_port);
    return 0;
}

/**
 * @brief Implements the CpmSocket_Close operation.
 * @param socketObj See the matching header for semantic details.
 */
void CpmSocket_Close(CpmSocket *socketObj)
{
    if (socketObj == NULL || !socketObj->isOpen)
        return;
#ifdef _WIN32
    closesocket(socketObj->handle);
#else
    close(socketObj->handle);
#endif
    socketObj->handle = INVALID_SOCKET;
    socketObj->isOpen = 0;
}

/**
 * @brief Implements the CpmSocket_IsOpen operation.
 * @param socketObj See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSocket_IsOpen(const CpmSocket *socketObj)
{
    return socketObj != NULL && socketObj->isOpen;
}

/**
 * @brief Implements the CpmSocket_LastError operation.
 * @return See the matching header for status code or value semantics.
 */
const char *CpmSocket_LastError(void)
{
    return g_cpmSocketLastError;
}
