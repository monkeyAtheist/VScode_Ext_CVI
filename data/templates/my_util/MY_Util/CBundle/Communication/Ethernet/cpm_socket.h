/**
 * @file cpm_socket.h
 * @brief CPM C TCP/UDP socket communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - initializes and shuts down the socket library where required;
 * - opens TCP clients, TCP servers and UDP sockets;
 * - accepts TCP clients and exchanges byte or text payloads;
 * - provides endpoint helpers for UDP send/receive operations.
 *
 * @par Typical applications
 * - Ethernet-connected instruments, PLCs, embedded boards and simulators;
 * - local TCP servers for test automation;
 * - UDP telemetry or command channels.
 *
 * @par Usage notes
 * - On Windows, link with ws2_32; CPM adds it automatically when this bundle is inserted.
 * - TCP is stream-oriented: add your own delimiter or length field for packets.
 * - Use the timeout functions to avoid blocking a test sequence indefinitely.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_socket.h"
 * 
 * CpmSocket socketObj;
 * CpmSocket_InitLibrary();
 * CpmSocket_Init(&socketObj);
 * if (CpmSocket_TcpConnect(&socketObj, "192.168.1.50", 5025) == 0)
 * {
 *     CpmSocket_Send(&socketObj, "*IDN?\n", 6, NULL);
 *     CpmSocket_Close(&socketObj);
 * }
 * CpmSocket_ShutdownLibrary();
 * @endcode
 */
#ifndef CPM_SOCKET_H
#define CPM_SOCKET_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
typedef SOCKET CpmSocketNativeHandle;
#else
typedef int CpmSocketNativeHandle;
#endif

typedef struct CpmSocket
{
    CpmSocketNativeHandle handle;
    int type;
    int isOpen;
} CpmSocket;

int CpmSocket_InitLibrary(void);
void CpmSocket_ShutdownLibrary(void);
void CpmSocket_Init(CpmSocket *socketObj);
int CpmSocket_TcpConnect(CpmSocket *socketObj, const char *host, unsigned short port);
int CpmSocket_TcpListen(CpmSocket *socketObj, const char *bindAddress, unsigned short port, int backlog);
int CpmSocket_TcpAccept(CpmSocket *server, CpmSocket *client);
int CpmSocket_UdpOpen(CpmSocket *socketObj, const char *bindAddress, unsigned short port);
int CpmSocket_Send(CpmSocket *socketObj, const void *data, size_t size, size_t *sent);
int CpmSocket_Recv(CpmSocket *socketObj, void *buffer, size_t bufferSize, size_t *received);
int CpmSocket_UdpSendTo(CpmSocket *socketObj, const char *host, unsigned short port, const void *data, size_t size, size_t *sent);
int CpmSocket_UdpRecvFrom(CpmSocket *socketObj, void *buffer, size_t bufferSize, size_t *received, char *remoteHost, size_t remoteHostSize, unsigned short *remotePort);
void CpmSocket_Close(CpmSocket *socketObj);
int CpmSocket_IsOpen(const CpmSocket *socketObj);
const char *CpmSocket_LastError(void);

#ifdef __cplusplus
}
#endif

#endif /* CPM_SOCKET_H */
