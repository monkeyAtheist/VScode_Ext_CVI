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
