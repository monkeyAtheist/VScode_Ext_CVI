# CPM C UART communication

Cross-platform C serial-port wrapper.

## Files

- `cpm_uart.c`
- `cpm_uart.h`

## Main API

- `CpmUart_Open(...)`
- `CpmUart_Read(...)`
- `CpmUart_Write(...)`
- `CpmUart_ReadLine(...)`
- `CpmUart_Close(...)`

On Windows, port names such as `COM10` and above may require the `\\.\COM10` form.
