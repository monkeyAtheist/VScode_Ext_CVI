# CPM C Wi-Fi communication bundle

This module intentionally handles the **application IP layer** only. Once the operating system is connected to a Wi-Fi network, an application normally uses the same TCP/UDP socket APIs as Ethernet.

Included API:

- `CpmWifi_OpenTcpClient`
- `CpmWifi_OpenTcpServer`
- `CpmWifi_AcceptClient`
- `CpmWifi_OpenUdp`
- `CpmWifi_Send` / `CpmWifi_Receive`
- `CpmWifi_SendTo` / `CpmWifi_ReceiveFrom`

The module does not join Wi-Fi networks, manage SSIDs, or scan adapters. Those operations are platform-specific system administration tasks.

Windows link dependency: `ws2_32`.
