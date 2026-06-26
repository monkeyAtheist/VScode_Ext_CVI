#define _DEFAULT_SOURCE
#include "cpm_can.h"

#include <stdio.h>
#include <string.h>

#if defined(__linux__)
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#endif

static char g_cpmCanLastError[256] = "";

static void CpmCan_SetLastErrorText(const char *message)
{
    if (message == NULL)
        message = "CAN error";
    strncpy(g_cpmCanLastError, message, sizeof(g_cpmCanLastError) - 1u);
    g_cpmCanLastError[sizeof(g_cpmCanLastError) - 1u] = '\0';
}

static void CpmCan_CopyName(char *dst, size_t dstSize, const char *src)
{
    if (dst == NULL || dstSize == 0u)
        return;
    if (src == NULL)
        src = "";
    strncpy(dst, src, dstSize - 1u);
    dst[dstSize - 1u] = '\0';
}

void CpmCan_InitBus(CpmCanBus *bus)
{
    if (bus == NULL)
        return;
    bus->handle = -1;
    bus->canFdEnabled = 0;
    bus->interfaceName[0] = '\0';
}

void CpmCan_InitFrame(CpmCanFrame *frame)
{
    if (frame == NULL)
        return;
    memset(frame, 0, sizeof(*frame));
}

int CpmCan_SetData(CpmCanFrame *frame, const uint8_t *data, size_t size)
{
    if (frame == NULL || (data == NULL && size > 0u))
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    if (size > CPM_CAN_MAX_DATA)
        return CPM_CAN_ERROR_TRUNCATED;
    if (!frame->isFd && size > 8u)
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    if (size > 0u)
        memcpy(frame->data, data, size);
    frame->dlc = (uint8_t)size;
    return CPM_CAN_OK;
}

uint32_t CpmCan_MakeStandardId(uint16_t id11)
{
    return (uint32_t)(id11 & 0x07FFu);
}

uint32_t CpmCan_MakeExtendedId(uint32_t id29)
{
    return (uint32_t)(id29 & 0x1FFFFFFFu);
}

int CpmCan_Open(CpmCanBus *bus, const char *interfaceName, int enableCanFd)
{
#if defined(__linux__)
    struct ifreq ifr;
    struct sockaddr_can address;
    int fd;
    int opt;

    if (bus == NULL || interfaceName == NULL || interfaceName[0] == '\0')
        return CPM_CAN_ERROR_INVALID_ARGUMENT;

    CpmCan_Close(bus);

    fd = socket(PF_CAN, SOCK_RAW, CAN_RAW);
    if (fd < 0)
    {
        CpmCan_SetLastErrorText("socket(PF_CAN, SOCK_RAW, CAN_RAW) failed");
        return CPM_CAN_ERROR_SYSTEM;
    }

    memset(&ifr, 0, sizeof(ifr));
    strncpy(ifr.ifr_name, interfaceName, IFNAMSIZ - 1u);
    if (ioctl(fd, SIOCGIFINDEX, &ifr) < 0)
    {
        close(fd);
        CpmCan_SetLastErrorText("CAN interface lookup failed");
        return CPM_CAN_ERROR_SYSTEM;
    }

    if (enableCanFd)
    {
        opt = 1;
        if (setsockopt(fd, SOL_CAN_RAW, CAN_RAW_FD_FRAMES, &opt, sizeof(opt)) < 0)
        {
            close(fd);
            CpmCan_SetLastErrorText("CAN FD enable failed");
            return CPM_CAN_ERROR_SYSTEM;
        }
    }

    memset(&address, 0, sizeof(address));
    address.can_family = AF_CAN;
    address.can_ifindex = ifr.ifr_ifindex;

    if (bind(fd, (struct sockaddr *)&address, sizeof(address)) < 0)
    {
        close(fd);
        CpmCan_SetLastErrorText("CAN bind failed");
        return CPM_CAN_ERROR_SYSTEM;
    }

    bus->handle = fd;
    bus->canFdEnabled = enableCanFd ? 1 : 0;
    CpmCan_CopyName(bus->interfaceName, sizeof(bus->interfaceName), interfaceName);
    return CPM_CAN_OK;
#else
    (void)bus;
    (void)interfaceName;
    (void)enableCanFd;
    CpmCan_SetLastErrorText("SocketCAN is not available on this platform in the default C bundle");
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

void CpmCan_Close(CpmCanBus *bus)
{
    if (bus == NULL)
        return;
#if defined(__linux__)
    if (bus->handle >= 0)
        close(bus->handle);
#endif
    bus->handle = -1;
    bus->canFdEnabled = 0;
    bus->interfaceName[0] = '\0';
}

int CpmCan_IsOpen(const CpmCanBus *bus)
{
    return bus != NULL && bus->handle >= 0;
}

int CpmCan_SetReceiveTimeout(CpmCanBus *bus, int timeoutMs)
{
#if defined(__linux__)
    struct timeval timeout;
    if (!CpmCan_IsOpen(bus) || timeoutMs < 0)
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    timeout.tv_sec = timeoutMs / 1000;
    timeout.tv_usec = (timeoutMs % 1000) * 1000;
    if (setsockopt(bus->handle, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) < 0)
        return CPM_CAN_ERROR_SYSTEM;
    return CPM_CAN_OK;
#else
    (void)bus;
    (void)timeoutMs;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

int CpmCan_SetLoopback(CpmCanBus *bus, int enabled)
{
#if defined(__linux__)
    int opt;
    if (!CpmCan_IsOpen(bus))
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    opt = enabled ? 1 : 0;
    return setsockopt(bus->handle, SOL_CAN_RAW, CAN_RAW_LOOPBACK, &opt, sizeof(opt)) == 0
        ? CPM_CAN_OK
        : CPM_CAN_ERROR_SYSTEM;
#else
    (void)bus;
    (void)enabled;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

int CpmCan_SetReceiveOwnMessages(CpmCanBus *bus, int enabled)
{
#if defined(__linux__)
    int opt;
    if (!CpmCan_IsOpen(bus))
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    opt = enabled ? 1 : 0;
    return setsockopt(bus->handle, SOL_CAN_RAW, CAN_RAW_RECV_OWN_MSGS, &opt, sizeof(opt)) == 0
        ? CPM_CAN_OK
        : CPM_CAN_ERROR_SYSTEM;
#else
    (void)bus;
    (void)enabled;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

int CpmCan_SetFilters(CpmCanBus *bus, const uint32_t *ids, const uint32_t *masks, size_t count)
{
#if defined(__linux__)
    struct can_filter localFilters[32];
    size_t i;
    if (!CpmCan_IsOpen(bus) || ids == NULL || masks == NULL || count > 32u)
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    for (i = 0; i < count; ++i)
    {
        localFilters[i].can_id = (canid_t)ids[i];
        localFilters[i].can_mask = (canid_t)masks[i];
    }
    if (setsockopt(bus->handle, SOL_CAN_RAW, CAN_RAW_FILTER, localFilters, (socklen_t)(count * sizeof(localFilters[0]))) < 0)
        return CPM_CAN_ERROR_SYSTEM;
    return CPM_CAN_OK;
#else
    (void)bus;
    (void)ids;
    (void)masks;
    (void)count;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

int CpmCan_ClearFilters(CpmCanBus *bus)
{
#if defined(__linux__)
    if (!CpmCan_IsOpen(bus))
        return CPM_CAN_ERROR_INVALID_ARGUMENT;
    if (setsockopt(bus->handle, SOL_CAN_RAW, CAN_RAW_FILTER, NULL, 0) < 0)
        return CPM_CAN_ERROR_SYSTEM;
    return CPM_CAN_OK;
#else
    (void)bus;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

#if defined(__linux__)
static canid_t CpmCan_ToLinuxId(const CpmCanFrame *frame)
{
    canid_t id = (canid_t)(frame->id & (frame->isExtended ? CAN_EFF_MASK : CAN_SFF_MASK));
    if (frame->isExtended)
        id |= CAN_EFF_FLAG;
    if (frame->isRemote)
        id |= CAN_RTR_FLAG;
    if (frame->isError)
        id |= CAN_ERR_FLAG;
    return id;
}

static void CpmCan_FromLinuxId(CpmCanFrame *frame, canid_t id)
{
    frame->isExtended = (id & CAN_EFF_FLAG) ? 1u : 0u;
    frame->isRemote = (id & CAN_RTR_FLAG) ? 1u : 0u;
    frame->isError = (id & CAN_ERR_FLAG) ? 1u : 0u;
    frame->id = frame->isExtended ? (uint32_t)(id & CAN_EFF_MASK) : (uint32_t)(id & CAN_SFF_MASK);
}
#endif

int CpmCan_Send(CpmCanBus *bus, const CpmCanFrame *frame)
{
#if defined(__linux__)
    ssize_t written;
    if (!CpmCan_IsOpen(bus) || frame == NULL || frame->dlc > CPM_CAN_MAX_DATA || (!frame->isFd && frame->dlc > 8u))
        return CPM_CAN_ERROR_INVALID_ARGUMENT;

    if (frame->isFd)
    {
        struct canfd_frame out;
        if (!bus->canFdEnabled)
            return CPM_CAN_ERROR_INVALID_ARGUMENT;
        memset(&out, 0, sizeof(out));
        out.can_id = CpmCan_ToLinuxId(frame);
        out.len = frame->dlc;
        if (frame->bitrateSwitch)
            out.flags |= CANFD_BRS;
        if (frame->errorStateIndicator)
            out.flags |= CANFD_ESI;
        memcpy(out.data, frame->data, frame->dlc);
        written = write(bus->handle, &out, sizeof(out));
        return written == (ssize_t)sizeof(out) ? CPM_CAN_OK : CPM_CAN_ERROR_SYSTEM;
    }
    else
    {
        struct can_frame out;
        memset(&out, 0, sizeof(out));
        out.can_id = CpmCan_ToLinuxId(frame);
        out.can_dlc = frame->dlc;
        memcpy(out.data, frame->data, frame->dlc);
        written = write(bus->handle, &out, sizeof(out));
        return written == (ssize_t)sizeof(out) ? CPM_CAN_OK : CPM_CAN_ERROR_SYSTEM;
    }
#else
    (void)bus;
    (void)frame;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

int CpmCan_Receive(CpmCanBus *bus, CpmCanFrame *frame)
{
#if defined(__linux__)
    uint8_t buffer[sizeof(struct canfd_frame)];
    ssize_t received;
    if (!CpmCan_IsOpen(bus) || frame == NULL)
        return CPM_CAN_ERROR_INVALID_ARGUMENT;

    memset(buffer, 0, sizeof(buffer));
    received = read(bus->handle, buffer, sizeof(buffer));
    if (received < 0)
    {
        if (errno == EAGAIN || errno == EWOULDBLOCK)
            return CPM_CAN_ERROR_TIMEOUT;
        return CPM_CAN_ERROR_SYSTEM;
    }

    CpmCan_InitFrame(frame);
    if (received == (ssize_t)sizeof(struct can_frame))
    {
        const struct can_frame *in = (const struct can_frame *)buffer;
        CpmCan_FromLinuxId(frame, in->can_id);
        frame->dlc = in->can_dlc;
        memcpy(frame->data, in->data, frame->dlc);
        return CPM_CAN_OK;
    }
    if (received == (ssize_t)sizeof(struct canfd_frame))
    {
        const struct canfd_frame *in = (const struct canfd_frame *)buffer;
        CpmCan_FromLinuxId(frame, in->can_id);
        frame->isFd = 1u;
        frame->dlc = in->len;
        frame->bitrateSwitch = (in->flags & CANFD_BRS) ? 1u : 0u;
        frame->errorStateIndicator = (in->flags & CANFD_ESI) ? 1u : 0u;
        memcpy(frame->data, in->data, frame->dlc);
        return CPM_CAN_OK;
    }
    return CPM_CAN_ERROR_TRUNCATED;
#else
    (void)bus;
    (void)frame;
    return CPM_CAN_ERROR_UNSUPPORTED;
#endif
}

int CpmCan_FormatFrame(const CpmCanFrame *frame, char *buffer, size_t bufferSize)
{
    size_t offset;
    size_t i;
    int written;

    if (frame == NULL || buffer == NULL || bufferSize == 0u)
        return CPM_CAN_ERROR_INVALID_ARGUMENT;

    written = snprintf(buffer, bufferSize, "%s %08lX [%u]",
                       frame->isFd ? "CANFD" : "CAN",
                       (unsigned long)frame->id,
                       (unsigned int)frame->dlc);
    if (written < 0 || (size_t)written >= bufferSize)
        return CPM_CAN_ERROR_TRUNCATED;
    offset = (size_t)written;

    for (i = 0u; i < frame->dlc && i < CPM_CAN_MAX_DATA; ++i)
    {
        written = snprintf(buffer + offset, bufferSize - offset, " %02X", (unsigned int)frame->data[i]);
        if (written < 0 || (size_t)written >= bufferSize - offset)
            return CPM_CAN_ERROR_TRUNCATED;
        offset += (size_t)written;
    }

    return CPM_CAN_OK;
}

const char *CpmCan_LastError(void)
{
    return g_cpmCanLastError;
}
