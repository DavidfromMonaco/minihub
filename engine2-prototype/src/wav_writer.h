#pragma once

#include <cstdint>
#include <filesystem>
#include <span>
#include <string>

namespace engine2 {

bool writeFloat32Wav(const std::filesystem::path& path, std::span<const float> interleaved,
                     std::uint32_t sampleRate, std::uint16_t channels, std::string& error);
std::uint64_t pcmHash(std::span<const float> samples) noexcept;

} // namespace engine2

