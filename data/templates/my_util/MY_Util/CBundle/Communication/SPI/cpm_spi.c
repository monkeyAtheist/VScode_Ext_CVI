/**
 * @file cpm_spi.c
 * @brief Implementation of the cpm_spi C bundle.
 *
 * Generated bundle implementation. Public API semantics are documented in the matching header file.
 */
#include "cpm_spi.h"

#include <stdlib.h>
#include <string.h>

#if defined(__linux__)
#include <fcntl.h>
#include <sys/ioctl.h>
#include <unistd.h>
#if defined(__has_include)
#  if __has_include(<linux/spi/spidev.h>)
#    include <linux/spi/spidev.h>
#  else
#    error "linux/spi/spidev.h is required for Linux SPI support"
#  endif
#else
#  include <linux/spi/spidev.h>
#endif
#endif

/**
 * @brief Implements the CpmSpi_Init operation.
 * @param device See the matching header for semantic details.
 */
void CpmSpi_Init(CpmSpiDevice *device)
{
    if (device != NULL)
    {
        device->handle = -1;
        device->speedHz = 1000000U;
        device->mode = 0;
        device->bitsPerWord = 8;
    }
}

/**
 * @brief Implements the CpmSpi_Open operation.
 * @param device See the matching header for semantic details.
 * @param devicePath See the matching header for semantic details.
 * @param speedHz See the matching header for semantic details.
 * @param mode See the matching header for semantic details.
 * @param bitsPerWord See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_Open(CpmSpiDevice *device, const char *devicePath, uint32_t speedHz, uint8_t mode, uint8_t bitsPerWord)
{
#if defined(__linux__)
    if (device == NULL || devicePath == NULL)
    {
        return -1;
    }
    CpmSpi_Close(device);
    device->handle = open(devicePath, O_RDWR);
    if (device->handle < 0)
    {
        return -1;
    }
    if (CpmSpi_SetMode(device, mode) < 0 ||
        CpmSpi_SetBitsPerWord(device, bitsPerWord) < 0 ||
        CpmSpi_SetSpeed(device, speedHz) < 0)
    {
        CpmSpi_Close(device);
        return -1;
    }
    return 0;
#else
    (void)device;
    (void)devicePath;
    (void)speedHz;
    (void)mode;
    (void)bitsPerWord;
    return -2;
#endif
}

/**
 * @brief Implements the CpmSpi_Close operation.
 * @param device See the matching header for semantic details.
 */
void CpmSpi_Close(CpmSpiDevice *device)
{
    if (device == NULL)
    {
        return;
    }
#if defined(__linux__)
    if (device->handle >= 0)
    {
        close(device->handle);
    }
#endif
    device->handle = -1;
}

/**
 * @brief Implements the CpmSpi_SetMode operation.
 * @param device See the matching header for semantic details.
 * @param mode See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_SetMode(CpmSpiDevice *device, uint8_t mode)
{
#if defined(__linux__)
    if (device == NULL || device->handle < 0)
    {
        return -1;
    }
    if (ioctl(device->handle, SPI_IOC_WR_MODE, &mode) < 0)
    {
        return -1;
    }
    device->mode = mode;
    return 0;
#else
    (void)device;
    (void)mode;
    return -2;
#endif
}

/**
 * @brief Implements the CpmSpi_SetSpeed operation.
 * @param device See the matching header for semantic details.
 * @param speedHz See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_SetSpeed(CpmSpiDevice *device, uint32_t speedHz)
{
#if defined(__linux__)
    if (device == NULL || device->handle < 0)
    {
        return -1;
    }
    if (ioctl(device->handle, SPI_IOC_WR_MAX_SPEED_HZ, &speedHz) < 0)
    {
        return -1;
    }
    device->speedHz = speedHz;
    return 0;
#else
    (void)device;
    (void)speedHz;
    return -2;
#endif
}

/**
 * @brief Implements the CpmSpi_SetBitsPerWord operation.
 * @param device See the matching header for semantic details.
 * @param bitsPerWord See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_SetBitsPerWord(CpmSpiDevice *device, uint8_t bitsPerWord)
{
#if defined(__linux__)
    if (device == NULL || device->handle < 0)
    {
        return -1;
    }
    if (ioctl(device->handle, SPI_IOC_WR_BITS_PER_WORD, &bitsPerWord) < 0)
    {
        return -1;
    }
    device->bitsPerWord = bitsPerWord;
    return 0;
#else
    (void)device;
    (void)bitsPerWord;
    return -2;
#endif
}

/**
 * @brief Implements the CpmSpi_Transfer operation.
 * @param device See the matching header for semantic details.
 * @param txData See the matching header for semantic details.
 * @param rxData See the matching header for semantic details.
 * @param size See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_Transfer(CpmSpiDevice *device, const uint8_t *txData, uint8_t *rxData, size_t size)
{
#if defined(__linux__)
    struct spi_ioc_transfer transfer;

    if (device == NULL || device->handle < 0 || size == 0)
    {
        return -1;
    }

    memset(&transfer, 0, sizeof(transfer));
    transfer.tx_buf = (unsigned long)txData;
    transfer.rx_buf = (unsigned long)rxData;
    transfer.len = (uint32_t)size;
    transfer.speed_hz = device->speedHz;
    transfer.bits_per_word = device->bitsPerWord;

    return ioctl(device->handle, SPI_IOC_MESSAGE(1), &transfer) >= 0 ? 0 : -1;
#else
    (void)device;
    (void)txData;
    (void)rxData;
    (void)size;
    return -2;
#endif
}

/**
 * @brief Implements the CpmSpi_Write operation.
 * @param device See the matching header for semantic details.
 * @param data See the matching header for semantic details.
 * @param size See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_Write(CpmSpiDevice *device, const uint8_t *data, size_t size)
{
    return CpmSpi_Transfer(device, data, NULL, size);
}

/**
 * @brief Implements the CpmSpi_Read operation.
 * @param device See the matching header for semantic details.
 * @param fillByte See the matching header for semantic details.
 * @param data See the matching header for semantic details.
 * @param size See the matching header for semantic details.
 * @return See the matching header for status code or value semantics.
 */
int CpmSpi_Read(CpmSpiDevice *device, uint8_t fillByte, uint8_t *data, size_t size)
{
    uint8_t *txBuffer;
    int status;

    if (data == NULL || size == 0)
    {
        return -1;
    }

    txBuffer = (uint8_t *)malloc(size);
    if (txBuffer == NULL)
    {
        return -1;
    }
    memset(txBuffer, fillByte, size);
    status = CpmSpi_Transfer(device, txBuffer, data, size);
    free(txBuffer);
    return status;
}
