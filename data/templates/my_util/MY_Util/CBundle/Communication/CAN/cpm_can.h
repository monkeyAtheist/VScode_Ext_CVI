/**
 * @file cpm_can.h
 * @brief CPM C CAN and SocketCAN communication API.
 *
 * @details
 * This bundle is intended to be readable immediately after insertion into a
 * CPM project. The comments below summarize what the module provides, when it
 * is useful and how to start using the public API.
 *
 * @par Main features
 * - opens a CAN interface and optionally enables CAN FD;
 * - builds standard and extended frame identifiers;
 * - sends and receives classic CAN or CAN FD frames;
 * - configures timeouts, loopback, own-message reception and filters;
 * - formats frames for diagnostics and logs.
 *
 * @par Typical applications
 * - Linux SocketCAN test utilities;
 * - communication with ECUs, embedded boards and CAN sensors;
 * - bench diagnostics where a small C wrapper is preferable to vendor tooling.
 *
 * @par Usage notes
 * - The default backend targets Linux SocketCAN interfaces such as "can0".
 * - Configure bitrate and bring the interface up outside the program, for example with ip link.
 * - Windows adapters normally require vendor-specific SDK glue code.
 *
 * @par Example of use
 * @code{.c}
 * #include "cpm_can.h"
 * 
 * CpmCanBus bus;
 * CpmCanFrame frame;
 * uint8_t payload[] = { 0x11, 0x22 };
 * CpmCan_InitBus(&bus);
 * CpmCan_InitFrame(&frame);
 * if (CpmCan_Open(&bus, "can0", 0) == 0)
 * {
 *     frame.id = CpmCan_MakeStandardId(0x123);
 *     CpmCan_SetData(&frame, payload, sizeof(payload));
 *     CpmCan_Send(&bus, &frame);
 *     CpmCan_Close(&bus);
 * }
 * @endcode
 */
#ifndef CPM_CAN_H
#define CPM_CAN_H

#ifdef __cplusplus
extern "C" {
#endif

#include <stddef.h>
#include <stdint.h>

#define CPM_CAN_MAX_DATA 64u

#define CPM_CAN_OK 0
#define CPM_CAN_ERROR_INVALID_ARGUMENT (-1)
#define CPM_CAN_ERROR_UNSUPPORTED (-2)
#define CPM_CAN_ERROR_SYSTEM (-3)
#define CPM_CAN_ERROR_TIMEOUT (-4)
#define CPM_CAN_ERROR_TRUNCATED (-5)

typedef struct CpmCanBus
{
    int handle;
    int canFdEnabled;
    char interfaceName[32];
} CpmCanBus;

typedef struct CpmCanFrame
{
    uint32_t id;
    uint8_t dlc;
    uint8_t data[CPM_CAN_MAX_DATA];
    uint8_t isExtended;
    uint8_t isRemote;
    uint8_t isError;
    uint8_t isFd;
    uint8_t bitrateSwitch;
    uint8_t errorStateIndicator;
} CpmCanFrame;

void CpmCan_InitBus(CpmCanBus *bus);
void CpmCan_InitFrame(CpmCanFrame *frame);
int CpmCan_SetData(CpmCanFrame *frame, const uint8_t *data, size_t size);

int CpmCan_Open(CpmCanBus *bus, const char *interfaceName, int enableCanFd);
void CpmCan_Close(CpmCanBus *bus);
int CpmCan_IsOpen(const CpmCanBus *bus);

int CpmCan_SetReceiveTimeout(CpmCanBus *bus, int timeoutMs);
int CpmCan_SetLoopback(CpmCanBus *bus, int enabled);
int CpmCan_SetReceiveOwnMessages(CpmCanBus *bus, int enabled);
int CpmCan_SetFilters(CpmCanBus *bus, const uint32_t *ids, const uint32_t *masks, size_t count);
int CpmCan_ClearFilters(CpmCanBus *bus);

int CpmCan_Send(CpmCanBus *bus, const CpmCanFrame *frame);
int CpmCan_Receive(CpmCanBus *bus, CpmCanFrame *frame);

uint32_t CpmCan_MakeStandardId(uint16_t id11);
uint32_t CpmCan_MakeExtendedId(uint32_t id29);
int CpmCan_FormatFrame(const CpmCanFrame *frame, char *buffer, size_t bufferSize);
const char *CpmCan_LastError(void);

#ifdef __cplusplus
}
#endif

#endif /* CPM_CAN_H */
