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
