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
