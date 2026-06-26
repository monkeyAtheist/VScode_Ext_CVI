#ifndef CPM_IPC_H
#define CPM_IPC_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
typedef HANDLE CpmIpcNativeHandle;
#else
typedef int CpmIpcNativeHandle;
#endif

#ifndef CPM_IPC_NAME_SIZE
#define CPM_IPC_NAME_SIZE 260
#endif

typedef struct CpmIpcPipe
{
    CpmIpcNativeHandle handle;
    int isOpen;
    int isServer;
    char name[CPM_IPC_NAME_SIZE];
} CpmIpcPipe;

void CpmIpc_Init(CpmIpcPipe *pipeObj);
int CpmIpc_CreateServer(CpmIpcPipe *pipeObj, const char *name);
int CpmIpc_WaitClient(CpmIpcPipe *pipeObj, unsigned int timeoutMs);
int CpmIpc_ConnectClient(CpmIpcPipe *pipeObj, const char *name, unsigned int timeoutMs);
int CpmIpc_Write(CpmIpcPipe *pipeObj, const void *data, size_t size, size_t *written);
int CpmIpc_Read(CpmIpcPipe *pipeObj, void *buffer, size_t bufferSize, size_t *received);
void CpmIpc_Close(CpmIpcPipe *pipeObj);
int CpmIpc_IsOpen(const CpmIpcPipe *pipeObj);
const char *CpmIpc_LastError(void);

#ifdef __cplusplus
}
#endif

#endif /* CPM_IPC_H */
