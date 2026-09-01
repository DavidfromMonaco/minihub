cmake_minimum_required(VERSION 3.22)

project(mlh_audio_engine
    VERSION 1.0.0
    DESCRIPTION "MiniLab Hub native audio engine (VST3 + WASAPI)"
    LANGUAGES C CXX)

include(CTest)

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

if(BUILD_TESTING)
    juce_add_plugin(mlh_deterministic_test_instrument
        COMPANY_NAME "MiniHub Tests"
        BUNDLE_ID "com.minihub.tests.deterministic-instrument"
        IS_SYNTH TRUE
        NEEDS_MIDI_INPUT TRUE
        NEEDS_MIDI_OUTPUT FALSE
        COPY_PLUGIN_AFTER_BUILD FALSE
        PLUGIN_MANUFACTURER_CODE Mlhb
        PLUGIN_CODE Mtst
        FORMATS VST3
        PRODUCT_NAME "MiniHub Deterministic Test Instrument"
        NEEDS_WEB_BROWSER FALSE
        NEEDS_CURL FALSE)
    target_sources(mlh_deterministic_test_instrument PRIVATE
        test/deterministic_test_instrument.cpp)
    target_compile_definitions(mlh_deterministic_test_instrument PUBLIC
        JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
    target_link_libraries(mlh_deterministic_test_instrument PRIVATE
        juce::juce_audio_processors)

    juce_add_plugin(mlh_deterministic_test_effect
        COMPANY_NAME "MiniHub Tests"
        BUNDLE_ID "com.minihub.tests.deterministic-effect"
        IS_SYNTH FALSE
        NEEDS_MIDI_INPUT FALSE
        NEEDS_MIDI_OUTPUT FALSE
        COPY_PLUGIN_AFTER_BUILD FALSE
        PLUGIN_MANUFACTURER_CODE Mlhb
        PLUGIN_CODE Mfx1
        FORMATS VST3
        PRODUCT_NAME "MiniHub Deterministic Test Effect"
        NEEDS_WEB_BROWSER FALSE
        NEEDS_CURL FALSE)
    target_sources(mlh_deterministic_test_effect PRIVATE
        test/deterministic_test_effect.cpp)
    target_compile_definitions(mlh_deterministic_test_effect PUBLIC
        JUCE_WEB_BROWSER=0 JUCE_USE_CURL=0 JUCE_VST3_CAN_REPLACE_VST2=0)
    target_link_libraries(mlh_deterministic_test_effect PRIVATE
        juce::juce_audio_processors)
endif()

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
    src/gesture_learn_state.h
    src/transport.h
    src/audio_graph.h
    src/audio_graph.cpp
    src/audio_take_writer.h
    src/audio_take_writer.cpp
    src/audio_signal_meter.h
    src/audio_signal_meter.cpp
    src/master_output.h
    src/master_output.cpp
    src/sequencer.h
    src/sequencer.cpp
    src/midi_graph.h
    src/midi_graph.cpp
    src/midi_output.h
    src/midi_output.cpp
)

# Disposable metadata helper. It deliberately does not compile engine.cpp and
# does not link juce_audio_devices, so scanning a VST3 cannot create a host-owned
# WASAPI/ASIO client or masquerade as a second mlh-audio-engine process.
add_executable(mlh_vst3_scanner
    src/scanner_main.cpp
    src/vst3_scanner.h
    src/vst3_scanner.cpp)
target_include_directories(mlh_vst3_scanner PRIVATE src)
target_link_libraries(mlh_vst3_scanner PRIVATE
    juce::juce_audio_processors
    juce::juce_gui_basics)
target_compile_definitions(mlh_vst3_scanner PRIVATE
    JUCE_PLUGINHOST_VST3=1
    _CONSOLE)
set_target_properties(mlh_vst3_scanner PROPERTIES
    OUTPUT_NAME "mlh-vst3-scanner"
    WIN32_EXECUTABLE OFF)
add_dependencies(mlh_audio_engine mlh_vst3_scanner)

if(BUILD_TESTING)
    add_executable(mlh_native_tests
        test/native_tests.cpp
        src/gesture_learn_state.h
        src/transport.h
        src/audio_graph.h
        src/audio_graph.cpp
        src/audio_take_writer.h
        src/audio_take_writer.cpp
        src/audio_signal_meter.h
        src/audio_signal_meter.cpp
        src/master_output.h
        src/master_output.cpp
        src/sequencer.h
        src/sequencer.cpp
        src/midi_graph.h
        src/midi_graph.cpp
        src/chain.h
        src/chain.cpp
        src/plugin_host.h
        src/plugin_host.cpp
        src/vst3_scanner.h
        src/vst3_scanner.cpp
    )
    target_include_directories(mlh_native_tests PRIVATE src)
    target_link_libraries(mlh_native_tests PRIVATE juce::juce_audio_processors juce::juce_audio_formats)
    target_compile_definitions(mlh_native_tests PRIVATE
        JUCE_PLUGINHOST_VST3=1
        JUCE_USE_OGGVORBIS=1
        JUCE_USE_LAME_AUDIO_FORMAT=1
        _CONSOLE)
    add_dependencies(mlh_native_tests
        mlh_deterministic_test_instrument_VST3
        mlh_deterministic_test_effect_VST3
        mlh_vst3_scanner)
    if(WIN32)
        add_custom_command(TARGET mlh_native_tests POST_BUILD
            COMMAND ${CMAKE_COMMAND} -E copy_if_different
                "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/lame/bin/lame.exe"
                "$<TARGET_FILE_DIR:mlh_native_tests>/lame.exe"
            VERBATIM)
    endif()
    add_test(NAME mlh_native_core_tests COMMAND mlh_native_tests --core)
    add_test(NAME mlh_vst3_e2e_tests COMMAND mlh_native_tests --vst3-e2e)
    set_tests_properties(mlh_native_core_tests PROPERTIES TIMEOUT 60)
    set_tests_properties(mlh_vst3_e2e_tests PROPERTIES TIMEOUT 60)
endif()

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

# JUCE 9 writes OGG Vorbis in-process. MP3 writing is provided by JUCE's
# LAMEEncoderAudioFormat, backed by the LAME executable built and shipped with
# MiniHub (never by a machine-wide FFmpeg/LAME installation).
target_compile_definitions(mlh_audio_engine PRIVATE
    JUCE_USE_OGGVORBIS=1
    JUCE_USE_LAME_AUDIO_FORMAT=1
)

set(MLH_LAME_EXECUTABLE "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/lame/bin/lame.exe")
if(WIN32)
    if(NOT EXISTS "${MLH_LAME_EXECUTABLE}")
        message(FATAL_ERROR "Bundled LAME executable not found at ${MLH_LAME_EXECUTABLE}")
    endif()
    add_custom_command(TARGET mlh_audio_engine POST_BUILD
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${MLH_LAME_EXECUTABLE}" "$<TARGET_FILE_DIR:mlh_audio_engine>/lame.exe"
        COMMAND ${CMAKE_COMMAND} -E copy_if_different
            "${CMAKE_CURRENT_SOURCE_DIR}/../third_party/lame/COPYING"
            "$<TARGET_FILE_DIR:mlh_audio_engine>/LAME-COPYING.txt"
        VERBATIM)
endif()

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
    # First-party sources are UTF-8. Keep MSVC's source/execution encoding
    # deterministic; non-ASCII JUCE strings still use String::fromUTF8
    # explicitly because String(const char*) deliberately assumes ASCII.
    target_compile_options(mlh_audio_engine PRIVATE /W3 /utf-8)
    target_compile_options(mlh_vst3_scanner PRIVATE /W3 /utf-8)
    if(BUILD_TESTING)
        target_compile_options(mlh_native_tests PRIVATE /utf-8)
    endif()
endif()
