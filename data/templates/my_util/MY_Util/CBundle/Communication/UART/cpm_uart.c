#include "cpm_uart.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
static char g_cpmUartLastError[256] = "";

static void CpmUart_SetLastErrorText(const char *message)
{
    if (message == NULL)
        message = "unknown error";
    strncpy(g_cpmUartLastError, message, sizeof(g_cpmUartLastError) - 1);
    g_cpmUartLastError[sizeof(g_cpmUartLastError) - 1] = '\0';
}

static DWORD CpmUart_ToWindowsBaud(unsigned int baudRate)
{
    return (DWORD)baudRate;
}

static char CpmUart_ToWindowsParity(CpmUartParity parity)
{
    switch (parity)
    {
        case CPM_UART_PARITY_ODD: return ODDPARITY;
        case CPM_UART_PARITY_EVEN: return EVENPARITY;
        case CPM_UART_PARITY_NONE:
        default: return NOPARITY;
    }
}

#else
#  include <fcntl.h>
#  include <sys/select.h>
#  include <termios.h>
#  include <unistd.h>

static char g_cpmUartLastError[256] = "";

static void CpmUart_SetLastErrorText(const char *message)
{
    if (message == NULL)
        message = strerror(errno);
    strncpy(g_cpmUartLastError, message, sizeof(g_cpmUartLastError) - 1);
    g_cpmUartLastError[sizeof(g_cpmUartLastError) - 1] = '\0';
}

static speed_t CpmUart_ToPosixBaud(unsigned int baudRate)
{
    switch (baudRate)
    {
        case 1200: return B1200;
        case 2400: return B2400;
        case 4800: return B4800;
        case 9600: return B9600;
        case 19200: return B19200;
        case 38400: return B38400;
#ifdef B57600
        case 57600: return B57600;
#endif
#ifdef B115200
        case 115200: return B115200;
#endif
#ifdef B230400
        case 230400: return B230400;
#endif
        default: return B9600;
    }
}
#endif

void CpmUart_Init(CpmUartPort *port)
{
    if (port == NULL)
        return;
#ifdef _WIN32
    port->handle = INVALID_HANDLE_VALUE;
#else
    port->handle = -1;
#endif
    port->isOpen = 0;
}

int CpmUart_Open(CpmUartPort *port, const char *deviceName, unsigned int baudRate)
{
    return CpmUart_OpenEx(port, deviceName, baudRate, 8, 1, CPM_UART_PARITY_NONE);
}

int CpmUart_OpenEx(CpmUartPort *port, const char *deviceName, unsigned int baudRate,
                   int dataBits, int stopBits, CpmUartParity parity)
{
    if (port == NULL || deviceName == NULL || deviceName[0] == '\0')
        return -1;

    CpmUart_Close(port);

#ifdef _WIN32
    char fullName[128];
    if (strncmp(deviceName, "\\\\.\\", 4) == 0)
        snprintf(fullName, sizeof(fullName), "%s", deviceName);
    else
        snprintf(fullName, sizeof(fullName), "\\\\.\\%s", deviceName);

    HANDLE handle = CreateFileA(fullName, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
    if (handle == INVALID_HANDLE_VALUE)
    {
        CpmUart_SetLastErrorText("CreateFileA failed");
        return -2;
    }

    DCB dcb;
    SecureZeroMemory(&dcb, sizeof(dcb));
    dcb.DCBlength = sizeof(dcb);
    if (!GetCommState(handle, &dcb))
    {
        CloseHandle(handle);
        CpmUart_SetLastErrorText("GetCommState failed");
        return -3;
    }
    dcb.BaudRate = CpmUart_ToWindowsBaud(baudRate);
    dcb.ByteSize = (BYTE)dataBits;
    dcb.StopBits = (stopBits == 2) ? TWOSTOPBITS : ONESTOPBIT;
    dcb.Parity = CpmUart_ToWindowsParity(parity);
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;

    if (!SetCommState(handle, &dcb))
    {
        CloseHandle(handle);
        CpmUart_SetLastErrorText("SetCommState failed");
        return -4;
    }

    COMMTIMEOUTS timeouts;
    SecureZeroMemory(&timeouts, sizeof(timeouts));
    timeouts.ReadIntervalTimeout = 50;
    timeouts.ReadTotalTimeoutConstant = 50;
    timeouts.ReadTotalTimeoutMultiplier = 10;
    timeouts.WriteTotalTimeoutConstant = 1000;
    timeouts.WriteTotalTimeoutMultiplier = 10;
    SetCommTimeouts(handle, &timeouts);

    port->handle = handle;
    port->isOpen = 1;
    return 0;
#else
    int fd = open(deviceName, O_RDWR | O_NOCTTY | O_SYNC);
    if (fd < 0)
    {
        CpmUart_SetLastErrorText(NULL);
        return -2;
    }

    struct termios tty;
    memset(&tty, 0, sizeof(tty));
    if (tcgetattr(fd, &tty) != 0)
    {
        close(fd);
        CpmUart_SetLastErrorText(NULL);
        return -3;
    }

    cfsetospeed(&tty, CpmUart_ToPosixBaud(baudRate));
    cfsetispeed(&tty, CpmUart_ToPosixBaud(baudRate));

    tty.c_cflag = (tty.c_cflag & ~CSIZE);
    switch (dataBits)
    {
        case 5: tty.c_cflag |= CS5; break;
        case 6: tty.c_cflag |= CS6; break;
        case 7: tty.c_cflag |= CS7; break;
        case 8:
        default: tty.c_cflag |= CS8; break;
    }
    tty.c_cflag |= CLOCAL | CREAD;
    if (parity == CPM_UART_PARITY_NONE)
        tty.c_cflag &= ~PARENB;
    else
    {
        tty.c_cflag |= PARENB;
        if (parity == CPM_UART_PARITY_ODD)
            tty.c_cflag |= PARODD;
        else
            tty.c_cflag &= ~PARODD;
    }
    if (stopBits == 2)
        tty.c_cflag |= CSTOPB;
    else
        tty.c_cflag &= ~CSTOPB;

    tty.c_iflag &= ~(IXON | IXOFF | IXANY);
    tty.c_lflag = 0;
    tty.c_oflag = 0;
    tty.c_cc[VMIN] = 0;
    tty.c_cc[VTIME] = 1;

    if (tcsetattr(fd, TCSANOW, &tty) != 0)
    {
        close(fd);
        CpmUart_SetLastErrorText(NULL);
        return -4;
    }

    port->handle = fd;
    port->isOpen = 1;
    return 0;
#endif
}

int CpmUart_IsOpen(const CpmUartPort *port)
{
    return port != NULL && port->isOpen;
}

int CpmUart_Write(CpmUartPort *port, const void *data, size_t size, size_t *written)
{
    if (written != NULL)
        *written = 0;
    if (!CpmUart_IsOpen(port) || data == NULL)
        return -1;
#ifdef _WIN32
    DWORD count = 0;
    if (!WriteFile(port->handle, data, (DWORD)size, &count, NULL))
    {
        CpmUart_SetLastErrorText("WriteFile failed");
        return -2;
    }
    if (written != NULL)
        *written = (size_t)count;
#else
    ssize_t count = write(port->handle, data, size);
    if (count < 0)
    {
        CpmUart_SetLastErrorText(NULL);
        return -2;
    }
    if (written != NULL)
        *written = (size_t)count;
#endif
    return 0;
}

int CpmUart_WriteText(CpmUartPort *port, const char *text)
{
    if (text == NULL)
        return -1;
    return CpmUart_Write(port, text, strlen(text), NULL);
}

int CpmUart_Read(CpmUartPort *port, void *buffer, size_t bufferSize, size_t *received, unsigned int timeoutMs)
{
    if (received != NULL)
        *received = 0;
    if (!CpmUart_IsOpen(port) || buffer == NULL || bufferSize == 0)
        return -1;
#ifdef _WIN32
    (void)timeoutMs;
    DWORD count = 0;
    if (!ReadFile(port->handle, buffer, (DWORD)bufferSize, &count, NULL))
    {
        CpmUart_SetLastErrorText("ReadFile failed");
        return -2;
    }
    if (received != NULL)
        *received = (size_t)count;
#else
    fd_set set;
    struct timeval timeout;
    FD_ZERO(&set);
    FD_SET(port->handle, &set);
    timeout.tv_sec = (long)(timeoutMs / 1000u);
    timeout.tv_usec = (long)((timeoutMs % 1000u) * 1000u);
    int ready = select(port->handle + 1, &set, NULL, NULL, timeoutMs == 0 ? NULL : &timeout);
    if (ready < 0)
    {
        CpmUart_SetLastErrorText(NULL);
        return -2;
    }
    if (ready == 0)
        return 1;
    ssize_t count = read(port->handle, buffer, bufferSize);
    if (count < 0)
    {
        CpmUart_SetLastErrorText(NULL);
        return -3;
    }
    if (received != NULL)
        *received = (size_t)count;
#endif
    return 0;
}

int CpmUart_ReadLine(CpmUartPort *port, char *buffer, size_t bufferSize, unsigned int timeoutMs)
{
    if (buffer == NULL || bufferSize == 0)
        return -1;
    size_t index = 0;
    buffer[0] = '\0';
    while (index + 1 < bufferSize)
    {
        char ch = '\0';
        size_t received = 0;
        int rc = CpmUart_Read(port, &ch, 1, &received, timeoutMs);
        if (rc != 0)
            return rc;
        if (received == 0)
            continue;
        if (ch == '\n')
            break;
        if (ch != '\r')
            buffer[index++] = ch;
    }
    buffer[index] = '\0';
    return 0;
}

void CpmUart_Close(CpmUartPort *port)
{
    if (port == NULL || !port->isOpen)
        return;
#ifdef _WIN32
    CloseHandle(port->handle);
    port->handle = INVALID_HANDLE_VALUE;
#else
    close(port->handle);
    port->handle = -1;
#endif
    port->isOpen = 0;
}

const char *CpmUart_LastError(void)
{
    return g_cpmUartLastError;
}
