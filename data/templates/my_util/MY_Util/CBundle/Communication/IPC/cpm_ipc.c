#include "cpm_ipc.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#ifndef _WIN32
#  include <fcntl.h>
#  include <sys/stat.h>
#  include <sys/types.h>
#  include <unistd.h>
#endif

static char g_cpmIpcLastError[256] = "";

static void CpmIpc_SetLastErrorText(const char *message)
{
    if (message == NULL)
        message = "ipc error";
    strncpy(g_cpmIpcLastError, message, sizeof(g_cpmIpcLastError) - 1);
    g_cpmIpcLastError[sizeof(g_cpmIpcLastError) - 1] = '\0';
}

static void CpmIpc_CopyName(char *dst, size_t dstSize, const char *name)
{
    if (dst == NULL || dstSize == 0)
        return;
    if (name == NULL)
        name = "";
    strncpy(dst, name, dstSize - 1);
    dst[dstSize - 1] = '\0';
}

#ifdef _WIN32
static void CpmIpc_FormatPipeName(const char *name, char *buffer, size_t bufferSize)
{
    if (strncmp(name, "\\\\.\\pipe\\", 9) == 0)
        snprintf(buffer, bufferSize, "%s", name);
    else
        snprintf(buffer, bufferSize, "\\\\.\\pipe\\%s", name);
}
#endif

void CpmIpc_Init(CpmIpcPipe *pipeObj)
{
    if (pipeObj == NULL)
        return;
#ifdef _WIN32
    pipeObj->handle = INVALID_HANDLE_VALUE;
#else
    pipeObj->handle = -1;
#endif
    pipeObj->isOpen = 0;
    pipeObj->isServer = 0;
    pipeObj->name[0] = '\0';
}

int CpmIpc_CreateServer(CpmIpcPipe *pipeObj, const char *name)
{
    if (pipeObj == NULL || name == NULL || name[0] == '\0')
        return -1;
    CpmIpc_Close(pipeObj);
#ifdef _WIN32
    char fullName[CPM_IPC_NAME_SIZE];
    CpmIpc_FormatPipeName(name, fullName, sizeof(fullName));
    HANDLE handle = CreateNamedPipeA(fullName, PIPE_ACCESS_DUPLEX, PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 4096, 4096, 0, NULL);
    if (handle == INVALID_HANDLE_VALUE)
    {
        CpmIpc_SetLastErrorText("CreateNamedPipeA failed");
        return -2;
    }
    pipeObj->handle = handle;
#else
    unlink(name);
    if (mkfifo(name, 0600) != 0 && errno != EEXIST)
    {
        CpmIpc_SetLastErrorText(strerror(errno));
        return -2;
    }
    int fd = open(name, O_RDWR | O_NONBLOCK);
    if (fd < 0)
    {
        CpmIpc_SetLastErrorText(strerror(errno));
        return -3;
    }
    pipeObj->handle = fd;
#endif
    pipeObj->isOpen = 1;
    pipeObj->isServer = 1;
    CpmIpc_CopyName(pipeObj->name, sizeof(pipeObj->name), name);
    return 0;
}

int CpmIpc_WaitClient(CpmIpcPipe *pipeObj, unsigned int timeoutMs)
{
    if (!CpmIpc_IsOpen(pipeObj) || !pipeObj->isServer)
        return -1;
#ifdef _WIN32
    (void)timeoutMs;
    if (!ConnectNamedPipe(pipeObj->handle, NULL))
    {
        DWORD err = GetLastError();
        if (err != ERROR_PIPE_CONNECTED)
        {
            CpmIpc_SetLastErrorText("ConnectNamedPipe failed");
            return -2;
        }
    }
#else
    (void)timeoutMs;
#endif
    return 0;
}

int CpmIpc_ConnectClient(CpmIpcPipe *pipeObj, const char *name, unsigned int timeoutMs)
{
    if (pipeObj == NULL || name == NULL || name[0] == '\0')
        return -1;
    CpmIpc_Close(pipeObj);
#ifdef _WIN32
    char fullName[CPM_IPC_NAME_SIZE];
    CpmIpc_FormatPipeName(name, fullName, sizeof(fullName));
    DWORD start = GetTickCount();
    HANDLE handle = INVALID_HANDLE_VALUE;
    do
    {
        handle = CreateFileA(fullName, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
        if (handle != INVALID_HANDLE_VALUE)
            break;
        Sleep(10);
    } while (timeoutMs == 0 || GetTickCount() - start < timeoutMs);
    if (handle == INVALID_HANDLE_VALUE)
    {
        CpmIpc_SetLastErrorText("CreateFileA pipe client failed");
        return -2;
    }
    pipeObj->handle = handle;
#else
    (void)timeoutMs;
    int fd = open(name, O_RDWR);
    if (fd < 0)
    {
        CpmIpc_SetLastErrorText(strerror(errno));
        return -2;
    }
    pipeObj->handle = fd;
#endif
    pipeObj->isOpen = 1;
    pipeObj->isServer = 0;
    CpmIpc_CopyName(pipeObj->name, sizeof(pipeObj->name), name);
    return 0;
}

int CpmIpc_Write(CpmIpcPipe *pipeObj, const void *data, size_t size, size_t *written)
{
    if (written != NULL)
        *written = 0;
    if (!CpmIpc_IsOpen(pipeObj) || data == NULL)
        return -1;
#ifdef _WIN32
    DWORD count = 0;
    if (!WriteFile(pipeObj->handle, data, (DWORD)size, &count, NULL))
    {
        CpmIpc_SetLastErrorText("WriteFile failed");
        return -2;
    }
    if (written != NULL)
        *written = (size_t)count;
#else
    ssize_t count = write(pipeObj->handle, data, size);
    if (count < 0)
    {
        CpmIpc_SetLastErrorText(strerror(errno));
        return -2;
    }
    if (written != NULL)
        *written = (size_t)count;
#endif
    return 0;
}

int CpmIpc_Read(CpmIpcPipe *pipeObj, void *buffer, size_t bufferSize, size_t *received)
{
    if (received != NULL)
        *received = 0;
    if (!CpmIpc_IsOpen(pipeObj) || buffer == NULL || bufferSize == 0)
        return -1;
#ifdef _WIN32
    DWORD count = 0;
    if (!ReadFile(pipeObj->handle, buffer, (DWORD)bufferSize, &count, NULL))
    {
        CpmIpc_SetLastErrorText("ReadFile failed");
        return -2;
    }
    if (received != NULL)
        *received = (size_t)count;
#else
    ssize_t count = read(pipeObj->handle, buffer, bufferSize);
    if (count < 0)
    {
        CpmIpc_SetLastErrorText(strerror(errno));
        return -2;
    }
    if (received != NULL)
        *received = (size_t)count;
#endif
    return 0;
}

void CpmIpc_Close(CpmIpcPipe *pipeObj)
{
    if (pipeObj == NULL || !pipeObj->isOpen)
        return;
#ifdef _WIN32
    if (pipeObj->isServer)
        DisconnectNamedPipe(pipeObj->handle);
    CloseHandle(pipeObj->handle);
    pipeObj->handle = INVALID_HANDLE_VALUE;
#else
    close(pipeObj->handle);
    pipeObj->handle = -1;
    if (pipeObj->isServer && pipeObj->name[0] != '\0')
        unlink(pipeObj->name);
#endif
    pipeObj->isOpen = 0;
}

int CpmIpc_IsOpen(const CpmIpcPipe *pipeObj)
{
    return pipeObj != NULL && pipeObj->isOpen;
}

const char *CpmIpc_LastError(void)
{
    return g_cpmIpcLastError;
}
