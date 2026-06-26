#ifndef JC_CAN_LINK_H
#define JC_CAN_LINK_H

#include <array>
#include <cstdint>
#include <string>
#include <vector>

namespace jc_can
{
    constexpr std::size_t MaxCanData = 64;

    enum class CanStatus
    {
        Ok = 0,
        InvalidArgument = -1,
        Unsupported = -2,
        SystemError = -3,
        Timeout = -4,
        Truncated = -5
    };

    struct CanFrame
    {
        std::uint32_t id = 0;
        std::uint8_t dlc = 0;
        std::array<std::uint8_t, MaxCanData> data{};
        bool extended = false;
        bool remote = false;
        bool error = false;
        bool fd = false;
        bool bitrateSwitch = false;
        bool errorStateIndicator = false;

        static CanFrame Standard(std::uint16_t id11, const std::vector<std::uint8_t>& payload = {});
        static CanFrame Extended(std::uint32_t id29, const std::vector<std::uint8_t>& payload = {});
        bool setData(const std::uint8_t* payload, std::size_t size);
        std::vector<std::uint8_t> payload() const;
        std::string toString() const;
    };

    struct CanFilter
    {
        std::uint32_t id = 0;
        std::uint32_t mask = 0;
    };

    class CanLink
    {
    public:
        CanLink();
        ~CanLink();

        CanLink(const CanLink&) = delete;
        CanLink& operator=(const CanLink&) = delete;

        CanLink(CanLink&& other) noexcept;
        CanLink& operator=(CanLink&& other) noexcept;

        CanStatus open(const std::string& interfaceName, bool enableCanFd = false);
        void close();
        bool isOpen() const;

        CanStatus setReceiveTimeout(int timeoutMs);
        CanStatus setLoopback(bool enabled);
        CanStatus setReceiveOwnMessages(bool enabled);
        CanStatus setFilters(const std::vector<CanFilter>& filters);
        CanStatus clearFilters();

        CanStatus send(const CanFrame& frame);
        CanStatus receive(CanFrame& frame);

        const std::string& interfaceName() const { return interfaceName_; }
        bool canFdEnabled() const { return canFdEnabled_; }
        const std::string& lastError() const { return lastError_; }

    private:
        int handle_ = -1;
        bool canFdEnabled_ = false;
        std::string interfaceName_;
        std::string lastError_;

        void setLastError(const std::string& message);
        void moveFrom(CanLink& other) noexcept;
    };
}

#endif // JC_CAN_LINK_H
