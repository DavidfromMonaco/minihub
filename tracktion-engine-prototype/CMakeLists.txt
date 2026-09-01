cmake_minimum_required(VERSION 3.22)

project(MiniHubTracktionPrototype VERSION 0.1.0 LANGUAGES C CXX)

set(TRACKTION_ENGINE_ROOT
    "${CMAKE_CURRENT_SOURCE_DIR}/third_party/tracktion_engine"
    CACHE PATH "Path to an official Tracktion Engine checkout")

if(NOT EXISTS "${TRACKTION_ENGINE_ROOT}/modules/tracktion_engine/tracktion_engine.h")
    message(FATAL_ERROR
        "Tracktion Engine was not found at ${TRACKTION_ENGINE_ROOT}. "
        "Run scripts/fetch-dependencies.ps1 first.")
endif()

file(STRINGS "${TRACKTION_ENGINE_ROOT}/VERSION.md" TRACKTION_ENGINE_SOURCE_VERSION
     LIMIT_COUNT 1)

execute_process(
    COMMAND git rev-parse HEAD
    WORKING_DIRECTORY "${TRACKTION_ENGINE_ROOT}"
    OUTPUT_VARIABLE TRACKTION_ENGINE_GIT_REVISION
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)

execute_process(
    COMMAND git rev-parse HEAD
    WORKING_DIRECTORY "${TRACKTION_ENGINE_ROOT}/modules/juce"
    OUTPUT_VARIABLE JUCE_GIT_REVISION
    OUTPUT_STRIP_TRAILING_WHITESPACE
    ERROR_QUIET)

if(MSVC)
    set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")
endif()

set_property(GLOBAL PROPERTY USE_FOLDERS YES)
option(JUCE_ENABLE_MODULE_SOURCE_GROUPS "Group JUCE module sources in IDEs" OFF)

add_subdirectory("${TRACKTION_ENGINE_ROOT}/modules/juce" juce)
add_subdirectory("${TRACKTION_ENGINE_ROOT}/modules" tracktion)

juce_add_console_app(minihub_tracktion_probe
    PRODUCT_NAME "MiniHub Tracktion Probe"
    COMPANY_NAME "MiniHub Prototype"
    BUNDLE_ID "com.minihub.tracktion-prototype"
    NEEDS_CURL FALSE
    NEEDS_WEB_BROWSER FALSE)

juce_generate_juce_header(minihub_tracktion_probe)

target_sources(minihub_tracktion_probe PRIVATE
    src/main.cpp)

target_compile_features(minihub_tracktion_probe PRIVATE cxx_std_20)

target_compile_definitions(minihub_tracktion_probe PRIVATE
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_VST=0
    JUCE_PLUGINHOST_AU=0
    JUCE_PLUGINHOST_LADSPA=0
    JUCE_STRICT_REFCOUNTEDPOINTER=1
    JUCE_MODAL_LOOPS_PERMITTED=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_REPORT_APP_USAGE=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_ASIO=0
    JUCE_DIRECTSOUND=0
    JUCE_WASAPI=1
    TRACKTION_ENABLE_ARA=0
    TRACKTION_ENABLE_REWIRE=0
    TRACKTION_ENABLE_CONTROL_SURFACES=0
    TRACKTION_ENABLE_TIMESTRETCH_SOUNDTOUCH=0
    TRACKTION_ENABLE_TIMESTRETCH_RUBBERBAND=0
    TRACKTION_ENABLE_TIMESTRETCH_SIGNALSMITH=0
    TRACKTION_LOG_DEVICES=0
    MINIHUB_TE_SOURCE_VERSION="${TRACKTION_ENGINE_SOURCE_VERSION}"
    MINIHUB_TE_GIT_REVISION="${TRACKTION_ENGINE_GIT_REVISION}"
    MINIHUB_JUCE_GIT_REVISION="${JUCE_GIT_REVISION}")

target_link_libraries(minihub_tracktion_probe PRIVATE
    tracktion::tracktion_core
    tracktion::tracktion_engine
    tracktion::tracktion_graph
    juce::juce_audio_devices
    juce::juce_audio_formats
    juce::juce_audio_processors
    juce::juce_audio_utils)

if(WIN32)
    target_link_libraries(minihub_tracktion_probe PRIVATE psapi)
endif()

if(MSVC)
    target_compile_options(minihub_tracktion_probe PRIVATE /W4 /bigobj /permissive-)
endif()

set_target_properties(minihub_tracktion_probe PROPERTIES
    C_VISIBILITY_PRESET hidden
    CXX_VISIBILITY_PRESET hidden)
