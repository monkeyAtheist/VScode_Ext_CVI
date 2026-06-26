#ifndef CPM_I2C_H
#define CPM_I2C_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>
#include <stdint.h>

typedef struct CpmI2cBus
{
    int handle;
    int currentAddress;
} CpmI2cBus;

void CpmI2c_Init(CpmI2cBus *bus);
int CpmI2c_Open(CpmI2cBus *bus, const char *devicePath);
void CpmI2c_Close(CpmI2cBus *bus);
int CpmI2c_SetAddress(CpmI2cBus *bus, uint8_t address);
int CpmI2c_Write(CpmI2cBus *bus, const uint8_t *data, size_t size);
int CpmI2c_Read(CpmI2cBus *bus, uint8_t *data, size_t size);
int CpmI2c_WriteRead(CpmI2cBus *bus,
                     const uint8_t *txData,
                     size_t txSize,
                     uint8_t *rxData,
                     size_t rxSize);
int CpmI2c_WriteRegister8(CpmI2cBus *bus, uint8_t registerAddress, uint8_t value);
int CpmI2c_ReadRegister8(CpmI2cBus *bus, uint8_t registerAddress, uint8_t *value);
int CpmI2c_ReadRegisters(CpmI2cBus *bus, uint8_t startRegister, uint8_t *data, size_t size);

#ifdef __cplusplus
}
#endif

#endif /* CPM_I2C_H */
