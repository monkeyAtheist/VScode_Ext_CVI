/**
 * @file cpm_bluetooth.c
 * @brief Implementation of the cpm_bluetooth C bundle.
 *
 * Generated bundle implementation. Public API semantics are documented in the matching header file.
 */
#include "cpm_bluetooth.h"

#include <stdio.h>
#include <string.h>

#ifndef _WIN32
#  include <unistd.h>
#  define INVALID_SOCKET (-1)
#  define SOCKET_ERROR (-1)
#endif

static char g_cpmBluetoothLastError[256] = "";

/**
 * @brief Implements the CpmBluetooth_SetLastError operation.
 * @param message See the matching header for semantic details.
 */
static void CpmBluetooth_SetLastError(const char *message)
{
    if (message == NULL)
        message = "Bluetooth error";
    strncpy(g_cpmBluetoothLastError, message, sizeof(g_cpmBluetoothLastError) - 1);
    g_cpmBluetoothLastError[sizeof(g_cpmBluetoothLastError) - 1] = '\0';
}

/**
 * @brief Implements the CpmBluetooth_Init operation.
 * @param link See the matching header for semantic details.
 */
void CpmBluetooth_Init(CpmBluetoothLink *link)
{
    if (link == NULL)
        return;
    link->handle = INVALID_SOCKET;
    link->isOpen = 0;
}

/**
 * @brief Implements the CpmBluetooth_InitLibrary operation.
 * @return See the matching header for status code or value semantics.
 */
int CpmBluetooth_InitLibrary(void)
{
#ifdef _WIN32
    WSADATA data;
    if (WSAStartup(MAKEWORD(2, 2), &data) != 0)
    {
        CpmBluetooth_SetLastError("WSAStartup failed");
        return -1;
    }
#endif
    return 0;
}

/**
 * @brief Implements the CpmBluetooth_ShutdownLibrary operation.
 */
void CpmBluetooth_ShutdownLibrary(void)
{
#ifdef _WIN32
    WSACleanup();
#endif
}

#ifdef _WIN32
/**
 * @brief Implements the CpmBluetooth_ParseAddress operation.
 * @param text See the matching header for semantic details.
 * @param address See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
static int CpmBluetooth_ParseAddress(const char *text, BTH_ADDR *address)
{
    if (text == NULL || address == NULL)
        return -1;
    unsigned int b[6] = {0, 0, 0, 0, 0, 0};
    int count = sscanf(text, "%x:%x:%x:%x:%x:%x", &b[5], &b[4], &b[3], &b[2], &b[1], &b[0]);
    if (count != 6)
        count = sscanf(text, "%2x%2x%2x%2x%2x%2x", &b[5], &b[4], &b[3], &b[2], &b[1], &b[0]);
    if (count != 6)
        return -2;
    *address = 0;
    for (int i = 0; i < 6; ++i)
        *address |= ((BTH_ADDR)(b[i] & 0xFFu)) << (8 * i);
    return 0;
}
#endif

/**
 * @brief Implements the CpmBluetooth_OpenRfcommClient operation.
 * @param link See the matching header for semantic details.
 * @param address See the matching header for semantic details.
 * @param channel See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmBluetooth_OpenRfcommClient(CpmBluetoothLink *link, const char *address, unsigned int channel)
{
    if (link == NULL)
        return -1;
    CpmBluetooth_Close(link);
#ifdef _WIN32
    BTH_ADDR remoteAddress = 0;
    if (CpmBluetooth_ParseAddress(address, &remoteAddress) != 0)
    {
        CpmBluetooth_SetLastError("invalid Bluetooth address");
        return -2;
    }
    SOCKET s = socket(AF_BTH, SOCK_STREAM, BTHPROTO_RFCOMM);
    if (s == INVALID_SOCKET)
    {
        CpmBluetooth_SetLastError("Bluetooth socket failed");
        return -3;
    }
    SOCKADDR_BTH remote;
    memset(&remote, 0, sizeof(remote));
    remote.addressFamily = AF_BTH;
    remote.btAddr = remoteAddress;
    remote.port = channel;
    if (connect(s, (const struct sockaddr *)&remote, sizeof(remote)) == SOCKET_ERROR)
    {
        closesocket(s);
        CpmBluetooth_SetLastError("Bluetooth RFCOMM connect failed");
        return -4;
    }
    link->handle = s;
    link->isOpen = 1;
    return 0;
#else
    (void)address;
    (void)channel;
    CpmBluetooth_SetLastError("Bluetooth RFCOMM is not implemented on this platform in the default C bundle");
    return -2;
#endif
}

/**
 * @brief Implements the CpmBluetooth_Send operation.
 * @param link See the matching header for semantic details.
 * @param data See the matching header for semantic details.
 * @param size See the matching header for semantic details.
 * @param sent See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmBluetooth_Send(CpmBluetoothLink *link, const void *data, size_t size, size_t *sent)
{
    if (!CpmBluetooth_IsOpen(link) || data == NULL)
        return -1;
#ifdef _WIN32
    int ret = send(link->handle, (const char *)data, (int)size, 0);
#else
    int ret = (int)write(link->handle, data, size);
#endif
    if (ret < 0)
        return -2;
    if (sent != NULL)
        *sent = (size_t)ret;
    return 0;
}

/**
 * @brief Implements the CpmBluetooth_Receive operation.
 * @param link See the matching header for semantic details.
 * @param buffer See the matching header for semantic details.
 * @param bufferSize See the matching header for semantic details.
 * @param received See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmBluetooth_Receive(CpmBluetoothLink *link, void *buffer, size_t bufferSize, size_t *received)
{
    if (!CpmBluetooth_IsOpen(link) || buffer == NULL || bufferSize == 0)
        return -1;
#ifdef _WIN32
    int ret = recv(link->handle, (char *)buffer, (int)bufferSize, 0);
#else
    int ret = (int)read(link->handle, buffer, bufferSize);
#endif
    if (ret < 0)
        return -2;
    if (received != NULL)
        *received = (size_t)ret;
    return ret == 0 ? 1 : 0;
}

/**
 * @brief Implements the CpmBluetooth_Close operation.
 * @param link See the matching header for semantic details.
 */
void CpmBluetooth_Close(CpmBluetoothLink *link)
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

/**
 * @brief Implements the CpmBluetooth_IsOpen operation.
 * @param link See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmBluetooth_IsOpen(const CpmBluetoothLink *link)
{
    return link != NULL && link->isOpen;
}

/**
 * @brief Implements the CpmBluetooth_LastError operation.
 * @return See the matching header for status code or value semantics.
 */
const char *CpmBluetooth_LastError(void)
{
    return g_cpmBluetoothLastError;
}
