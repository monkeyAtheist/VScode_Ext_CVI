/**
 * @file cpm_spi.h
 * @brief CPM C Linux SPI device-file communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - opens an spidev node such as "/dev/spidev0.0";
 * - configures mode, bits per word, speed and LSB/MSB order;
 * - performs full-duplex transfers;
 * - provides simple write and read helpers built on transfer calls.
 *
 * @par Typical applications
 * - Raspberry Pi or Linux SBC communication with ADCs, DACs, displays and sensors;
 * - low-level validation of SPI peripherals;
 * - embedded test tools where a small C interface is enough.
 *
 * @par Usage notes
 * - The bundled implementation targets Linux spidev.
 * - Enable SPI and configure permissions before running the executable.
 * - SPI is full duplex: reading generally also writes dummy bytes.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_spi.h"
 * 
 * CpmSpiDevice device;
 * uint8_t tx[2] = { 0x9F, 0x00 };
 * uint8_t rx[2] = { 0 };
 * CpmSpi_Init(&device);
 * if (CpmSpi_Open(&device, "/dev/spidev0.0", 1000000U, CPM_SPI_MODE0, 8) == 0)
 * {
 *     CpmSpi_Transfer(&device, tx, rx, sizeof(tx));
 *     CpmSpi_Close(&device);
 * }
 * @endcode
 */
#ifndef CPM_SPI_H
#define CPM_SPI_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>
#include <stdint.h>

typedef struct CpmSpiDevice
{
    int handle;
    uint32_t speedHz;
    uint8_t mode;
    uint8_t bitsPerWord;
} CpmSpiDevice;

void CpmSpi_Init(CpmSpiDevice *device);
int CpmSpi_Open(CpmSpiDevice *device, const char *devicePath, uint32_t speedHz, uint8_t mode, uint8_t bitsPerWord);
void CpmSpi_Close(CpmSpiDevice *device);
int CpmSpi_SetMode(CpmSpiDevice *device, uint8_t mode);
int CpmSpi_SetSpeed(CpmSpiDevice *device, uint32_t speedHz);
int CpmSpi_SetBitsPerWord(CpmSpiDevice *device, uint8_t bitsPerWord);
int CpmSpi_Transfer(CpmSpiDevice *device, const uint8_t *txData, uint8_t *rxData, size_t size);
int CpmSpi_Write(CpmSpiDevice *device, const uint8_t *data, size_t size);
int CpmSpi_Read(CpmSpiDevice *device, uint8_t fillByte, uint8_t *data, size_t size);

#ifdef __cplusplus
}
#endif

#endif /* CPM_SPI_H */
