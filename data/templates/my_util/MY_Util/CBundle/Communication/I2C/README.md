# CPM C I2C module

Minimal C wrapper for Linux I2C devices such as `/dev/i2c-1`.

Typical usage:

```c
CpmI2cBus bus;
uint8_t value = 0;

CpmI2c_Init(&bus);
if (CpmI2c_Open(&bus, "/dev/i2c-1") == 0)
{
    CpmI2c_SetAddress(&bus, 0x40);
    CpmI2c_ReadRegister8(&bus, 0x00, &value);
    CpmI2c_Close(&bus);
}
```

The module returns `-2` on platforms where the low-level I2C backend is not implemented.
