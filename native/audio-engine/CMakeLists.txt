cmake_minimum_required(VERSION 3.22)

project(mlh_audio_engine
    VERSION 1.0.0
    DESCRIPTION "MiniLab Hub native audio engine (VST3 + WASAPI)"
    LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# --- JUCE ---------------------------------------------------------------------
set(JUCE_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/JUCE")
if(NOT EXISTS "${JUCE_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR "JUCE not found at ${JUCE_ROOT}. "
        "Download JUCE 9 and extract it to native/third_party/JUCE.")
endif()
add_subdirectory(${JUCE_ROOT} juce_build)

# --- Native audio engine executable -------------------------------------------
add_executable(mlh_audio_engine
    src/main.cpp
    src/ipc.h
    src/ipc.cpp
    src/vst3_scanner.h
    src/vst3_scanner.cpp
    src/plugin_host.h
    src/plugin_host.cpp
    src/chain.h
    src/chain.cpp
    src/engine.h
    src/engine.cpp
    src/var_util.h
)

target_link_libraries(mlh_audio_engine PRIVATE
    juce::juce_audio_basics
    juce::juce_audio_devices
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_core
    juce::juce_events
    juce::juce_graphics
    juce::juce_gui_basics
    juce::juce_gui_extra
)

# Console subsystem so we can talk over stdin/stdout (IPC boundary).
# JUCE still provides a GUI message loop for native plugin editors.
set_target_properties(mlh_audio_engine PROPERTIES
    OUTPUT_NAME "mlh-audio-engine"
    WIN32_EXECUTABLE OFF
)

# Enable VST3 plugin hosting (the VST3 SDK ships inside JUCE).
# This is a console app (stdin/stdout IPC), so force JUCE to generate `int main`
# rather than WinMain by defining _CONSOLE.
target_compile_definitions(mlh_audio_engine PRIVATE
    JUCE_PLUGINHOST_VST3=1
    _CONSOLE
)

if(MSVC)
    target_compile_options(mlh_audio_engine PRIVATE /W3)
endif()
