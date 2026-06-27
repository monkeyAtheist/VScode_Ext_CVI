/**
 * @file cpm_i2c.h
 * @brief CPM C Linux I2C device-file communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - opens an I2C bus device such as "/dev/i2c-1";
 * - selects the slave address for the active transaction;
 * - reads and writes raw buffers;
 * - provides register read/write helpers for 8-bit register maps.
 *
 * @par Typical applications
 * - Raspberry Pi or Linux SBC communication with sensors, EEPROMs and expanders;
 * - quick validation of I2C peripherals from C;
 * - test benches that need deterministic low-level I2C access.
 *
 * @par Usage notes
 * - The bundled implementation targets Linux i2c-dev.
 * - Enable I2C and configure permissions before running the executable.
 * - For 16-bit registers or special protocols, build a small wrapper above the raw read/write calls.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_i2c.h"
 * 
 * CpmI2cBus bus;
 * uint8_t value = 0;
 * CpmI2c_Init(&bus);
 * if (CpmI2c_Open(&bus, "/dev/i2c-1") == 0)
 * {
 *     CpmI2c_SetAddress(&bus, 0x48);
 *     CpmI2c_ReadRegister8(&bus, 0x00, &value);
 *     CpmI2c_Close(&bus);
 * }
 * @endcode
 */
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
