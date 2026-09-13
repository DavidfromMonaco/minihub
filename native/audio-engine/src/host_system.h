#pragma once

#include <map>
#include <string>
#include <vector>

namespace mlh {

/**
 * Two facts the operating system holds about this process.
 *
 * WHY A FILE OF ITS OWN
 * ---------------------
 * Both need Windows headers that only compile in one order (`winsock2.h` before
 * `windows.h`), and `plugin_host.cpp` already includes `windows.h` on its own
 * terms. Kept here, no translation unit that sees JUCE has to get that order
 * right, and none of these headers leaks into one that does.
 */

/**
 * The package family this process runs under, or empty.
 *
 * Empty is the normal case: MiniHub is not a packaged application. It is NOT
 * empty when a packaged application -- Codex Desktop is one -- launched MiniHub
 * itself, because a child inherits its parent's package identity. Windows then
 * files every folder a plugin creates in AppData inside that application's
 * private storage, so a plugin logged in there is logged out everywhere else,
 * and nothing on screen says why.
 */
std::string currentPackageFamilyName();

/**
 * Every TCP port listening on the loopback interface, by owning process id.
 *
 * Asked for rarely and on demand: it walks the whole machine's table.
 */
std::map<long long, std::vector<int>> loopbackTcpListeners();

} // namespace mlh
