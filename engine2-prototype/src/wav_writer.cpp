#include "wav_writer.h"

#include <bit>
#include <fstream>

namespace engine2 {
namespace {
template <typename T>
void write(std::ofstream& out, T value) {
    out.write(reinterpret_cast<const char*>(&value), sizeof(value));
}
}

bool writeFloat32Wav(const std::filesystem::path& path, std::span<const float> samples,
                     std::uint32_t sampleRate, std::uint16_t channels, std::string& error) {
    std::error_code ec;
    std::filesystem::create_directories(path.parent_path(), ec);
    if (ec) { error = "cannot create WAV directory: " + ec.message(); return false; }
    std::ofstream out(path, std::ios::binary | std::ios::trunc);
    if (!out) { error = "cannot open WAV output: " + path.string(); return false; }
    const auto dataBytes = static_cast<std::uint32_t>(samples.size_bytes());
    const std::uint32_t riffBytes = 36 + dataBytes;
    const std::uint16_t format = 3; // IEEE 754 float, preserves graph samples exactly.
    const std::uint16_t bits = 32;
    const std::uint16_t blockAlign = static_cast<std::uint16_t>(channels * sizeof(float));
    const std::uint32_t bytesPerSecond = sampleRate * blockAlign;
    out.write("RIFF", 4); write(out, riffBytes); out.write("WAVE", 4);
    out.write("fmt ", 4); write(out, std::uint32_t {16}); write(out, format);
    write(out, channels); write(out, sampleRate); write(out, bytesPerSecond);
    write(out, blockAlign); write(out, bits);
    out.write("data", 4); write(out, dataBytes);
    out.write(reinterpret_cast<const char*>(samples.data()), dataBytes);
    if (!out) { error = "failed while writing WAV data"; return false; }
    return true;
}

std::uint64_t pcmHash(std::span<const float> samples) noexcept {
    std::uint64_t hash = 1469598103934665603ULL;
    for (float sample : samples) {
        const auto bits = std::bit_cast<std::uint32_t>(sample);
        for (int shift = 0; shift < 32; shift += 8) {
            hash ^= static_cast<std::uint8_t>((bits >> shift) & 0xffU);
            hash *= 1099511628211ULL;
        }
    }
    return hash;
}

} // namespace engine2
