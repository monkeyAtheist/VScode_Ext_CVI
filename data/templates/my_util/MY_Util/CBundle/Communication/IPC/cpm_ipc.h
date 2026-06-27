/**
 * @file cpm_ipc.h
 * @brief CPM C named-pipe/FIFO inter-process communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - creates a local server endpoint and waits for a client;
 * - connects to an existing endpoint as a client;
 * - exchanges raw bytes with simple read/write calls;
 * - wraps Windows named pipes and POSIX FIFO-style handles behind one C structure.
 *
 * @par Typical applications
 * - communication between a C test executable and a helper process;
 * - local supervision channels for GUIs, workers or test sequencers;
 * - small command/reply protocols when sockets are unnecessary.
 *
 * @par Usage notes
 * - Use the same pipe name on the server and client side.
 * - Frame your own messages when several commands can be sent on the same connection.
 * - Close both sides cleanly to release the pipe handle before rebuilding.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_ipc.h"
 * 
 * CpmIpcPipe pipeObj;
 * CpmIpc_Init(&pipeObj);
 * if (CpmIpc_ConnectClient(&pipeObj, "demo_pipe", 5000) == 0)
 * {
 *     CpmIpc_Write(&pipeObj, "PING", 4, NULL);
 *     CpmIpc_Close(&pipeObj);
 * }
 * @endcode
 */
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
