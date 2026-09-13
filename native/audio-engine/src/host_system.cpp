#include "host_system.h"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <appmodel.h>
#include <iphlpapi.h>
#endif

namespace mlh {

std::string currentPackageFamilyName()
{
#if defined(_WIN32)
    UINT32 length = 0;
    // Anything but "the buffer is too small" means there is no package to name:
    // APPMODEL_ERROR_NO_PACKAGE is what an ordinary launch answers.
    if (::GetCurrentPackageFamilyName(&length, nullptr) != ERROR_INSUFFICIENT_BUFFER || length == 0)
        return {};
    std::wstring name(length, L'\0');
    if (::GetCurrentPackageFamilyName(&length, name.data()) != ERROR_SUCCESS)
        return {};
    name.resize(length > 0 ? length - 1 : 0); // the length counts the terminator
    const int bytes = ::WideCharToMultiByte(CP_UTF8, 0, name.c_str(), static_cast<int>(name.size()),
                                            nullptr, 0, nullptr, nullptr);
    if (bytes <= 0)
        return {};
    std::string utf8(static_cast<size_t>(bytes), '\0');
    ::WideCharToMultiByte(CP_UTF8, 0, name.c_str(), static_cast<int>(name.size()),
                          utf8.data(), bytes, nullptr, nullptr);
    return utf8;
#else
    return {};
#endif
}

std::map<long long, std::vector<int>> loopbackTcpListeners()
{
    std::map<long long, std::vector<int>> listeners;
#if defined(_WIN32)
    std::vector<unsigned char> buffer;
    ULONG size = 0;
    DWORD status = ERROR_INSUFFICIENT_BUFFER;
    // A connection can open between asking for the table's size and reading
    // it, so a second "too small" is a race to retry, not a failure.
    for (int attempt = 0; attempt < 4 && status == ERROR_INSUFFICIENT_BUFFER; ++attempt)
    {
        buffer.resize(size);
        status = ::GetExtendedTcpTable(buffer.empty() ? nullptr : buffer.data(), &size, FALSE,
                                       AF_INET, TCP_TABLE_OWNER_PID_LISTENER, 0);
    }
    if (status != NO_ERROR || buffer.size() < sizeof(MIB_TCPTABLE_OWNER_PID))
        return listeners;

    const auto* table = reinterpret_cast<const MIB_TCPTABLE_OWNER_PID*>(buffer.data());
    for (DWORD index = 0; index < table->dwNumEntries; ++index)
    {
        const auto& row = table->table[index];
        // Both fields hold network byte order. The first byte of the address is
        // 127 for loopback whatever the host's endianness; the port is the low
        // sixteen bits with its two bytes swapped.
        const auto* address = reinterpret_cast<const unsigned char*>(&row.dwLocalAddr);
        if (address[0] != 127)
            continue;
        const int port = static_cast<int>(((row.dwLocalPort & 0xFFu) << 8) | ((row.dwLocalPort >> 8) & 0xFFu));
        listeners[static_cast<long long>(row.dwOwningPid)].push_back(port);
    }
#endif
    return listeners;
}

} // namespace mlh
