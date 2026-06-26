# CPM C Bluetooth RFCOMM bundle

This module provides a small C interface for Bluetooth Classic RFCOMM client communication.

Current scope:

- Windows RFCOMM client through Winsock Bluetooth (`AF_BTH`, `BTHPROTO_RFCOMM`)
- Send/receive helpers once connected
- Clear unsupported return code on non-Windows platforms in the default template

Bluetooth Low Energy is not included because BLE uses a GATT/service/characteristic model that is substantially different from RFCOMM streams.

Windows link dependency: `ws2_32`.
