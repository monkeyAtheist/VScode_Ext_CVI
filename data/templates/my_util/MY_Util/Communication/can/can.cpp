#define _DEFAULT_SOURCE
#include "can.h"

#include <algorithm>
#include <cstring>
#include <iomanip>
#include <sstream>

#if defined(__linux__)
#include <cerrno>
#include <net/if.h>
#include <sys/ioctl.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>
#include <linux/can.h>
#include <linux/can/raw.h>
#endif

namespace jc_can
{
    CanFrame CanFrame::Standard(std::uint16_t id11, const std::vector<std::uint8_t>& payload)
    {
        CanFrame frame;
        frame.id = static_cast<std::uint32_t>(id11 & 0x07FFu);
        frame.extended = false;
        frame.setData(payload.data(), payload.size());
        return frame;
    }

    CanFrame CanFrame::Extended(std::uint32_t id29, const std::vector<std::uint8_t>& payload)
    {
        CanFrame frame;
        frame.id = id29 & 0x1FFFFFFFu;
        frame.extended = true;
        frame.setData(payload.data(), payload.size());
        return frame;
    }

    bool CanFrame::setData(const std::uint8_t* payload, std::size_t size)
    {
        if ((payload == nullptr && size > 0) || size > MaxCanData || (!fd && size > 8))
            return false;
        data.fill(0);
        if (size > 0)
            std::copy(payload, payload + size, data.begin());
        dlc = static_cast<std::uint8_t>(size);
        return true;
    }

    std::vector<std::uint8_t> CanFrame::payload() const
    {
        const auto n = std::min<std::size_t>(dlc, MaxCanData);
        return std::vector<std::uint8_t>(data.begin(), data.begin() + static_cast<std::ptrdiff_t>(n));
    }

    std::string CanFrame::toString() const
    {
        std::ostringstream os;
        os << (fd ? "CANFD" : "CAN") << ' ' << std::uppercase << std::hex << std::setw(extended ? 8 : 3)
           << std::setfill('0') << id << " [" << std::dec << static_cast<unsigned>(dlc) << ']';
        for (std::size_t i = 0; i < dlc && i < MaxCanData; ++i)
        {
            os << ' ' << std::uppercase << std::hex << std::setw(2) << std::setfill('0')
               << static_cast<unsigned>(data[i]);
        }
        return os.str();
    }

    CanLink::CanLink() = default;

    CanLink::~CanLink()
    {
        close();
    }

    CanLink::CanLink(CanLink&& other) noexcept
    {
        moveFrom(other);
    }

    CanLink& CanLink::operator=(CanLink&& other) noexcept
    {
        if (this != &other)
        {
            close();
            moveFrom(other);
        }
        return *this;
    }

    void CanLink::moveFrom(CanLink& other) noexcept
    {
        handle_ = other.handle_;
        canFdEnabled_ = other.canFdEnabled_;
        interfaceName_ = std::move(other.interfaceName_);
        lastError_ = std::move(other.lastError_);
        other.handle_ = -1;
        other.canFdEnabled_ = false;
    }

    void CanLink::setLastError(const std::string& message)
    {
        lastError_ = message;
    }

    CanStatus CanLink::open(const std::string& interfaceName, bool enableCanFd)
    {
#if defined(__linux__)
        if (interfaceName.empty())
            return CanStatus::InvalidArgument;

        close();

        const int fd = ::socket(PF_CAN, SOCK_RAW, CAN_RAW);
        if (fd < 0)
        {
            setLastError("socket(PF_CAN, SOCK_RAW, CAN_RAW) failed");
            return CanStatus::SystemError;
        }

        ifreq ifr{};
        std::strncpy(ifr.ifr_name, interfaceName.c_str(), IFNAMSIZ - 1);
        if (::ioctl(fd, SIOCGIFINDEX, &ifr) < 0)
        {
            ::close(fd);
            setLastError("CAN interface lookup failed");
            return CanStatus::SystemError;
        }

        if (enableCanFd)
        {
            int opt = 1;
            if (::setsockopt(fd, SOL_CAN_RAW, CAN_RAW_FD_FRAMES, &opt, sizeof(opt)) < 0)
            {
                ::close(fd);
                setLastError("CAN FD enable failed");
                return CanStatus::SystemError;
            }
        }

        sockaddr_can address{};
        address.can_family = AF_CAN;
        address.can_ifindex = ifr.ifr_ifindex;
        if (::bind(fd, reinterpret_cast<sockaddr*>(&address), sizeof(address)) < 0)
        {
            ::close(fd);
            setLastError("CAN bind failed");
            return CanStatus::SystemError;
        }

        handle_ = fd;
        canFdEnabled_ = enableCanFd;
        interfaceName_ = interfaceName;
        return CanStatus::Ok;
#else
        (void)interfaceName;
        (void)enableCanFd;
        setLastError("SocketCAN is not available on this platform in the default C++ bundle");
        return CanStatus::Unsupported;
#endif
    }

    void CanLink::close()
    {
#if defined(__linux__)
        if (handle_ >= 0)
            ::close(handle_);
#endif
        handle_ = -1;
        canFdEnabled_ = false;
        interfaceName_.clear();
    }

    bool CanLink::isOpen() const
    {
        return handle_ >= 0;
    }

    CanStatus CanLink::setReceiveTimeout(int timeoutMs)
    {
#if defined(__linux__)
        if (!isOpen() || timeoutMs < 0)
            return CanStatus::InvalidArgument;
        timeval timeout{};
        timeout.tv_sec = timeoutMs / 1000;
        timeout.tv_usec = (timeoutMs % 1000) * 1000;
        return ::setsockopt(handle_, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout)) == 0
            ? CanStatus::Ok
            : CanStatus::SystemError;
#else
        (void)timeoutMs;
        return CanStatus::Unsupported;
#endif
    }

    CanStatus CanLink::setLoopback(bool enabled)
    {
#if defined(__linux__)
        if (!isOpen())
            return CanStatus::InvalidArgument;
        int opt = enabled ? 1 : 0;
        return ::setsockopt(handle_, SOL_CAN_RAW, CAN_RAW_LOOPBACK, &opt, sizeof(opt)) == 0
            ? CanStatus::Ok
            : CanStatus::SystemError;
#else
        (void)enabled;
        return CanStatus::Unsupported;
#endif
    }

    CanStatus CanLink::setReceiveOwnMessages(bool enabled)
    {
#if defined(__linux__)
        if (!isOpen())
            return CanStatus::InvalidArgument;
        int opt = enabled ? 1 : 0;
        return ::setsockopt(handle_, SOL_CAN_RAW, CAN_RAW_RECV_OWN_MSGS, &opt, sizeof(opt)) == 0
            ? CanStatus::Ok
            : CanStatus::SystemError;
#else
        (void)enabled;
        return CanStatus::Unsupported;
#endif
    }

    CanStatus CanLink::setFilters(const std::vector<CanFilter>& filters)
    {
#if defined(__linux__)
        if (!isOpen())
            return CanStatus::InvalidArgument;
        if (filters.empty())
            return clearFilters();
        std::vector<can_filter> raw(filters.size());
        for (std::size_t i = 0; i < filters.size(); ++i)
        {
            raw[i].can_id = static_cast<canid_t>(filters[i].id);
            raw[i].can_mask = static_cast<canid_t>(filters[i].mask);
        }
        return ::setsockopt(handle_, SOL_CAN_RAW, CAN_RAW_FILTER, raw.data(), static_cast<socklen_t>(raw.size() * sizeof(raw[0]))) == 0
            ? CanStatus::Ok
            : CanStatus::SystemError;
#else
        (void)filters;
        return CanStatus::Unsupported;
#endif
    }

    CanStatus CanLink::clearFilters()
    {
#if defined(__linux__)
        if (!isOpen())
            return CanStatus::InvalidArgument;
        return ::setsockopt(handle_, SOL_CAN_RAW, CAN_RAW_FILTER, nullptr, 0) == 0
            ? CanStatus::Ok
            : CanStatus::SystemError;
#else
        return CanStatus::Unsupported;
#endif
    }

#if defined(__linux__)
    static canid_t toLinuxId(const CanFrame& frame)
    {
        canid_t id = static_cast<canid_t>(frame.id & (frame.extended ? CAN_EFF_MASK : CAN_SFF_MASK));
        if (frame.extended)
            id |= CAN_EFF_FLAG;
        if (frame.remote)
            id |= CAN_RTR_FLAG;
        if (frame.error)
            id |= CAN_ERR_FLAG;
        return id;
    }

    static void fromLinuxId(CanFrame& frame, canid_t id)
    {
        frame.extended = (id & CAN_EFF_FLAG) != 0;
        frame.remote = (id & CAN_RTR_FLAG) != 0;
        frame.error = (id & CAN_ERR_FLAG) != 0;
        frame.id = frame.extended ? static_cast<std::uint32_t>(id & CAN_EFF_MASK) : static_cast<std::uint32_t>(id & CAN_SFF_MASK);
    }
#endif

    CanStatus CanLink::send(const CanFrame& frame)
    {
#if defined(__linux__)
        if (!isOpen() || frame.dlc > MaxCanData || (!frame.fd && frame.dlc > 8))
            return CanStatus::InvalidArgument;
        if (frame.fd)
        {
            if (!canFdEnabled_)
                return CanStatus::InvalidArgument;
            canfd_frame out{};
            out.can_id = toLinuxId(frame);
            out.len = frame.dlc;
            if (frame.bitrateSwitch)
                out.flags |= CANFD_BRS;
            if (frame.errorStateIndicator)
                out.flags |= CANFD_ESI;
            std::copy(frame.data.begin(), frame.data.begin() + frame.dlc, out.data);
            return ::write(handle_, &out, sizeof(out)) == static_cast<ssize_t>(sizeof(out))
                ? CanStatus::Ok
                : CanStatus::SystemError;
        }

        can_frame out{};
        out.can_id = toLinuxId(frame);
        out.can_dlc = frame.dlc;
        std::copy(frame.data.begin(), frame.data.begin() + frame.dlc, out.data);
        return ::write(handle_, &out, sizeof(out)) == static_cast<ssize_t>(sizeof(out))
            ? CanStatus::Ok
            : CanStatus::SystemError;
#else
        (void)frame;
        return CanStatus::Unsupported;
#endif
    }

    CanStatus CanLink::receive(CanFrame& frame)
    {
#if defined(__linux__)
        std::array<std::uint8_t, sizeof(canfd_frame)> buffer{};
        if (!isOpen())
            return CanStatus::InvalidArgument;
        const ssize_t received = ::read(handle_, buffer.data(), buffer.size());
        if (received < 0)
        {
            if (errno == EAGAIN || errno == EWOULDBLOCK)
                return CanStatus::Timeout;
            return CanStatus::SystemError;
        }

        frame = CanFrame{};
        if (received == static_cast<ssize_t>(sizeof(can_frame)))
        {
            const auto* in = reinterpret_cast<const can_frame*>(buffer.data());
            fromLinuxId(frame, in->can_id);
            frame.dlc = in->can_dlc;
            std::copy(in->data, in->data + frame.dlc, frame.data.begin());
            return CanStatus::Ok;
        }

        if (received == static_cast<ssize_t>(sizeof(canfd_frame)))
        {
            const auto* in = reinterpret_cast<const canfd_frame*>(buffer.data());
            fromLinuxId(frame, in->can_id);
            frame.fd = true;
            frame.dlc = in->len;
            frame.bitrateSwitch = (in->flags & CANFD_BRS) != 0;
            frame.errorStateIndicator = (in->flags & CANFD_ESI) != 0;
            std::copy(in->data, in->data + frame.dlc, frame.data.begin());
            return CanStatus::Ok;
        }

        return CanStatus::Truncated;
#else
        (void)frame;
        return CanStatus::Unsupported;
#endif
    }
}
