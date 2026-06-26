# CPM C communication stack

This bundle groups pure C communication helpers converted or rewritten from the MY_Util C++ communication modules.

Included modules:

- `UART/`: serial port wrapper for Windows and POSIX.
- `IPC/`: local named-pipe / FIFO wrapper.
- `Ethernet/`: TCP client/server and UDP socket wrapper.
- `WiFi/`: TCP/UDP socket wrapper for applications running on systems already connected to Wi-Fi.
- `Bluetooth/`: Bluetooth Classic RFCOMM client wrapper, implemented for Windows by default.
- `CAN/`: Linux SocketCAN wrapper for classical CAN, CAN FD, filters and timeouts.
- `I2C/`: Linux `/dev/i2c-*` wrapper with register helpers.
- `SPI/`: Linux spidev wrapper with full-duplex transfer helpers.

Windows projects using `Ethernet/`, `WiFi/` or `Bluetooth/` require `ws2_32`; CPM adds it automatically when this bundle is inserted.

The CAN, I2C and SPI modules deliberately return `-2` on unsupported platforms instead of silently compiling into non-working code. The CAN module targets SocketCAN on Linux. Windows CAN adapters usually require a vendor SDK adapter layer. The Bluetooth C module also returns an unsupported status on non-Windows platforms unless you extend it with a platform-specific BlueZ backend.
