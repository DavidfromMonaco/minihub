cmake_minimum_required(VERSION 3.25)

project(MiniHubEngine2Prototype VERSION 0.1.0 LANGUAGES C CXX)

# PortAudio 19.7.0 still declares an old CMake policy baseline. CMake 4 needs
# the compatibility floor stated by the parent project.
set(CMAKE_POLICY_VERSION_MINIMUM 3.5)

if(NOT WIN32)
    message(FATAL_ERROR "Engine 2 prototype currently targets Windows/WASAPI only")
endif()

set(VST3_SDK_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/vst3sdk" CACHE PATH "Steinberg VST3 SDK checkout")
set(PORTAUDIO_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/third_party/portaudio" CACHE PATH "PortAudio checkout")

if(NOT EXISTS "${VST3_SDK_ROOT}/pluginterfaces/vst/ivstaudioprocessor.h")
    message(FATAL_ERROR "VST3 SDK missing. Run scripts/fetch-dependencies.ps1")
endif()
if(NOT EXISTS "${PORTAUDIO_ROOT}/include/portaudio.h")
    message(FATAL_ERROR "PortAudio missing. Run scripts/fetch-dependencies.ps1")
endif()

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>DLL")

# Build only the official SDK hosting support. No JUCE, Tracktion, GUI, examples,
# other Windows audio APIs, or PortAudio test programs are part of this target.
set(SMTG_ENABLE_VST3_PLUGIN_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VST3_HOSTING_EXAMPLES OFF CACHE BOOL "" FORCE)
set(SMTG_ENABLE_VSTGUI_SUPPORT OFF CACHE BOOL "" FORCE)
set(SMTG_CREATE_PLUGIN_LINK OFF CACHE BOOL "" FORCE)
add_subdirectory("${VST3_SDK_ROOT}" vst3sdk EXCLUDE_FROM_ALL)

set(PA_BUILD_SHARED OFF CACHE BOOL "" FORCE)
set(PA_BUILD_STATIC ON CACHE BOOL "" FORCE)
set(PA_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(PA_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(PA_BUILD_TOOLS OFF CACHE BOOL "" FORCE)
set(PA_USE_WASAPI ON CACHE BOOL "" FORCE)
set(PA_USE_ASIO OFF CACHE BOOL "" FORCE)
set(PA_USE_DS OFF CACHE BOOL "" FORCE)
set(PA_USE_WMME OFF CACHE BOOL "" FORCE)
set(PA_USE_WDMKS OFF CACHE BOOL "" FORCE)
add_subdirectory("${PORTAUDIO_ROOT}" portaudio EXCLUDE_FROM_ALL)

add_executable(minihub_engine2
    src/audio_engine.cpp
    src/audio_engine.h
    src/audio_graph.cpp
    src/audio_graph.h
    src/main.cpp
    src/plugin_instance.cpp
    src/plugin_instance.h
    src/portaudio_device.cpp
    src/portaudio_device.h
    src/wav_writer.cpp
    src/wav_writer.h
    "${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/module_win32.cpp"
    "${VST3_SDK_ROOT}/public.sdk/source/vst/hosting/plugprovider.cpp")

target_include_directories(minihub_engine2 PRIVATE
    "${CMAKE_CURRENT_SOURCE_DIR}/src"
    "${VST3_SDK_ROOT}"
    "${PORTAUDIO_ROOT}/include")

target_link_libraries(minihub_engine2 PRIVATE sdk_hosting portaudio_static psapi)
target_compile_definitions(minihub_engine2 PRIVATE
    NOMINMAX WIN32_LEAN_AND_MEAN
    ENGINE2_VERSION="${PROJECT_VERSION}"
    VST3_SDK_REVISION="3cdf9ca5d1f5b1b21e0a86832aa4abe55607bd96"
    PORTAUDIO_REVISION="147dd722548358763a8b649b3e4b41dfffbcfbb6")

if(MSVC)
    target_compile_options(minihub_engine2 PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:char8_t-)
    target_link_options(minihub_engine2 PRIVATE /INCREMENTAL:NO)
endif()

option(ENGINE2_ENABLE_ASAN "Enable MSVC AddressSanitizer validation" OFF)
if(ENGINE2_ENABLE_ASAN AND MSVC)
    foreach(asan_target minihub_engine2 base pluginterfaces sdk_common sdk_hosting portaudio_static)
        target_compile_options(${asan_target} PRIVATE /fsanitize=address /Zi)
    endforeach()
    target_link_options(minihub_engine2 PRIVATE /INFERASANLIBS /DEBUG)
endif()

enable_testing()
add_test(NAME engine2_core COMMAND minihub_engine2 self-test --artifacts "${CMAKE_BINARY_DIR}/test-artifacts")
