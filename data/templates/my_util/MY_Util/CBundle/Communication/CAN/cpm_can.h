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
