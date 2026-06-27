/**
 * @file cpm_bluetooth.h
 * @brief CPM C Bluetooth Classic RFCOMM communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - initializes the Bluetooth socket backend;
 * - opens an RFCOMM client connection to a paired device;
 * - sends and receives raw byte payloads;
 * - reports unsupported status on platforms without a backend implementation.
 *
 * @par Typical applications
 * - serial-like communication with Bluetooth Classic modules such as HC-05/HC-06;
 * - wireless bench debug links when BLE is not required;
 * - small command protocols over RFCOMM.
 *
 * @par Usage notes
 * - The bundled implementation is Windows RFCOMM-oriented.
 * - Pair the remote device in the operating system before opening the RFCOMM channel.
 * - Use the device MAC address and RFCOMM channel configured by the remote service.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_bluetooth.h"
 * 
 * CpmBluetoothLink link;
 * CpmBluetooth_InitLibrary();
 * CpmBluetooth_Init(&link);
 * if (CpmBluetooth_OpenRfcommClient(&link, "00:11:22:33:44:55", 1) == 0)
 * {
 *     CpmBluetooth_Send(&link, "PING", 4, NULL);
 *     CpmBluetooth_Close(&link);
 * }
 * CpmBluetooth_ShutdownLibrary();
 * @endcode
 */
#ifndef CPM_BLUETOOTH_H
#define CPM_BLUETOOTH_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <winsock2.h>
#  include <ws2bth.h>
typedef SOCKET CpmBluetoothNativeHandle;
#else
typedef int CpmBluetoothNativeHandle;
#endif

typedef struct CpmBluetoothLink
{
    CpmBluetoothNativeHandle handle;
    int isOpen;
} CpmBluetoothLink;

void CpmBluetooth_Init(CpmBluetoothLink *link);
int CpmBluetooth_InitLibrary(void);
void CpmBluetooth_ShutdownLibrary(void);
int CpmBluetooth_OpenRfcommClient(CpmBluetoothLink *link, const char *address, unsigned int channel);
int CpmBluetooth_Send(CpmBluetoothLink *link, const void *data, size_t size, size_t *sent);
int CpmBluetooth_Receive(CpmBluetoothLink *link, void *buffer, size_t bufferSize, size_t *received);
void CpmBluetooth_Close(CpmBluetoothLink *link);
int CpmBluetooth_IsOpen(const CpmBluetoothLink *link);
const char *CpmBluetooth_LastError(void);

#ifdef __cplusplus
}
#endif

#endif /* CPM_BLUETOOTH_H */
