# CPM CAN communication bundle

Pure C CAN helper focused on Linux SocketCAN.

Generated files:

- `cpm_can.c`
- `cpm_can.h`

Main features:

- Open a SocketCAN interface such as `can0`, `vcan0` or `can1`.
- Send and receive classical CAN frames.
- Optional CAN FD support through `CAN_RAW_FD_FRAMES`.
- Standard and extended identifiers.
- Remote/error frame flags.
- Receive timeout, loopback, own-message reception and ID filters.
- Small diagnostic formatter for logs.

Typical Linux setup for a virtual CAN interface:

```sh
sudo modprobe vcan
sudo ip link add dev vcan0 type vcan
sudo ip link set up vcan0
```

Typical physical CAN setup:

```sh
sudo ip link set can0 down
sudo ip link set can0 type can bitrate 500000
sudo ip link set can0 up
```

Unsupported platforms return `CPM_CAN_ERROR_UNSUPPORTED` by default. For Windows CAN adapters, prefer adding a thin adapter around the vendor SDK, because PCAN, Kvaser, NI-XNET and Vector XL use different APIs.
