/**
 * @file cpm_uart.h
 * @brief CPM C UART/serial-port communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - opens and configures a serial port or COM port;
 * - supports baud rate, data bits, stop bits and parity configuration;
 * - provides byte, text and line-oriented read/write helpers;
 * - uses timeout-aware reads and exposes the last transport error.
 *
 * @par Typical applications
 * - communication with microcontrollers, Arduino/ESP32 boards, modems and instruments;
 * - simple debug consoles and command protocols over RS-232/RS-485/USB-serial;
 * - bench-test tools requiring a procedural C serial API.
 *
 * @par Usage notes
 * - On Windows, pass names such as "COM3"; high COM numbers are normalized internally when required.
 * - On Linux, pass device files such as "/dev/ttyUSB0" or "/dev/ttyS0".
 * - Always close the port with CpmUart_Close before rebuilding or disconnecting the device.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_uart.h"
 * 
 * CpmUartPort port;
 * CpmUart_Init(&port);
 * if (CpmUart_OpenEx(&port, "COM3", 115200, 8, 1, CPM_UART_PARITY_NONE) == 0)
 * {
 *     char line[128];
 *     CpmUart_WriteText(&port, "MEAS?\n");
 *     if (CpmUart_ReadLine(&port, line, sizeof(line), 1000) == 0)
 *     {
 *         printf("Device answered: %s\n", line);
 *     }
 *     CpmUart_Close(&port);
 * }
 * @endcode
 */
#ifndef CPM_UART_H
#define CPM_UART_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>

#ifdef _WIN32
#  ifndef WIN32_LEAN_AND_MEAN
#    define WIN32_LEAN_AND_MEAN
#  endif
#  include <windows.h>
typedef HANDLE CpmUartNativeHandle;
#else
typedef int CpmUartNativeHandle;
#endif

typedef enum CpmUartParity
{
    CPM_UART_PARITY_NONE = 0,
    CPM_UART_PARITY_ODD = 1,
    CPM_UART_PARITY_EVEN = 2
} CpmUartParity;

typedef struct CpmUartPort
{
    CpmUartNativeHandle handle;
    int isOpen;
} CpmUartPort;

void CpmUart_Init(CpmUartPort *port);
int CpmUart_Open(CpmUartPort *port, const char *deviceName, unsigned int baudRate);
int CpmUart_OpenEx(CpmUartPort *port, const char *deviceName, unsigned int baudRate,
                   int dataBits, int stopBits, CpmUartParity parity);
int CpmUart_IsOpen(const CpmUartPort *port);
int CpmUart_Write(CpmUartPort *port, const void *data, size_t size, size_t *written);
int CpmUart_WriteText(CpmUartPort *port, const char *text);
int CpmUart_Read(CpmUartPort *port, void *buffer, size_t bufferSize, size_t *received, unsigned int timeoutMs);
int CpmUart_ReadLine(CpmUartPort *port, char *buffer, size_t bufferSize, unsigned int timeoutMs);
void CpmUart_Close(CpmUartPort *port);
const char *CpmUart_LastError(void);

#ifdef __cplusplus
}
#endif

#endif /* CPM_UART_H */
