#include "cpm_i2c.h"

#include <string.h>

#if defined(__linux__)
#include <errno.h>
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#if defined(__has_include)
#  if __has_include(<linux/i2c-dev.h>)
#    include <linux/i2c-dev.h>
#  else
#    define I2C_SLAVE 0x0703
#  endif
#else
#  include <linux/i2c-dev.h>
#endif
#endif

void CpmI2c_Init(CpmI2cBus *bus)
{
    if (bus != NULL)
    {
        bus->handle = -1;
        bus->currentAddress = -1;
    }
}

int CpmI2c_Open(CpmI2cBus *bus, const char *devicePath)
{
#if defined(__linux__)
    if (bus == NULL || devicePath == NULL)
    {
        return -1;
    }
    CpmI2c_Close(bus);
    bus->handle = open(devicePath, O_RDWR);
    bus->currentAddress = -1;
    return bus->handle >= 0 ? 0 : -1;
#else
    (void)bus;
    (void)devicePath;
    return -2;
#endif
}

void CpmI2c_Close(CpmI2cBus *bus)
{
    if (bus == NULL)
    {
        return;
    }
#if defined(__linux__)
    if (bus->handle >= 0)
    {
        close(bus->handle);
    }
#endif
    bus->handle = -1;
    bus->currentAddress = -1;
}

int CpmI2c_SetAddress(CpmI2cBus *bus, uint8_t address)
{
#if defined(__linux__)
    if (bus == NULL || bus->handle < 0)
    {
        return -1;
    }
    if (bus->currentAddress == (int)address)
    {
        return 0;
    }
    if (ioctl(bus->handle, I2C_SLAVE, address) < 0)
    {
        return -1;
    }
    bus->currentAddress = (int)address;
    return 0;
#else
    (void)bus;
    (void)address;
    return -2;
#endif
}

int CpmI2c_Write(CpmI2cBus *bus, const uint8_t *data, size_t size)
{
#if defined(__linux__)
    ssize_t written;
    if (bus == NULL || bus->handle < 0 || data == NULL)
    {
        return -1;
    }
    written = write(bus->handle, data, size);
    return written == (ssize_t)size ? 0 : -1;
#else
    (void)bus;
    (void)data;
    (void)size;
    return -2;
#endif
}

int CpmI2c_Read(CpmI2cBus *bus, uint8_t *data, size_t size)
{
#if defined(__linux__)
    ssize_t received;
    if (bus == NULL || bus->handle < 0 || data == NULL)
    {
        return -1;
    }
    received = read(bus->handle, data, size);
    return received == (ssize_t)size ? 0 : -1;
#else
    (void)bus;
    (void)data;
    (void)size;
    return -2;
#endif
}

int CpmI2c_WriteRead(CpmI2cBus *bus,
                     const uint8_t *txData,
                     size_t txSize,
                     uint8_t *rxData,
                     size_t rxSize)
{
    if (txSize > 0 && CpmI2c_Write(bus, txData, txSize) < 0)
    {
        return -1;
    }
    if (rxSize > 0 && CpmI2c_Read(bus, rxData, rxSize) < 0)
    {
        return -1;
    }
    return 0;
}

int CpmI2c_WriteRegister8(CpmI2cBus *bus, uint8_t registerAddress, uint8_t value)
{
    uint8_t frame[2];
    frame[0] = registerAddress;
    frame[1] = value;
    return CpmI2c_Write(bus, frame, sizeof(frame));
}

int CpmI2c_ReadRegister8(CpmI2cBus *bus, uint8_t registerAddress, uint8_t *value)
{
    if (value == NULL)
    {
        return -1;
    }
    return CpmI2c_WriteRead(bus, &registerAddress, 1, value, 1);
}

int CpmI2c_ReadRegisters(CpmI2cBus *bus, uint8_t startRegister, uint8_t *data, size_t size)
{
    return CpmI2c_WriteRead(bus, &startRegister, 1, data, size);
}
