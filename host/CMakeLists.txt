cmake_minimum_required(VERSION 3.22)

project(vch_host VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(VCH_JUCE_DIR "" CACHE PATH "Path to a local JUCE checkout (otherwise JUCE is downloaded)")

if(VCH_JUCE_DIR)
    add_subdirectory(${VCH_JUCE_DIR} JUCE)
else()
    include(FetchContent)
    FetchContent_Declare(JUCE
        GIT_REPOSITORY https://github.com/juce-framework/JUCE.git
        GIT_TAG 9.0.5
        GIT_SHALLOW TRUE)
    FetchContent_MakeAvailable(JUCE)
endif()

juce_add_console_app(vch-host PRODUCT_NAME "vch-host")

target_sources(vch-host PRIVATE
    src/Main.cpp
    src/PluginLoader.cpp
    src/Commands.cpp
    src/Protocol.cpp
    src/Wav.cpp)

target_compile_definitions(vch-host PRIVATE
    VCH_HOST_VERSION="${PROJECT_VERSION}"
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_LV2=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(vch-host PRIVATE
    juce::juce_audio_processors_headless
    juce::juce_recommended_config_flags
    juce::juce_recommended_lto_flags
    juce::juce_recommended_warning_flags)

# vch-gui: opens plugin editors and captures them (GUI reconstruction)
juce_add_console_app(vch-gui PRODUCT_NAME "vch-gui")

target_sources(vch-gui PRIVATE
    src/GuiMain.cpp
    src/Protocol.cpp
    src/ScreenCapture.cpp)

target_compile_definitions(vch-gui PRIVATE
    VCH_HOST_VERSION="${PROJECT_VERSION}"
    JUCE_PLUGINHOST_VST3=1
    JUCE_PLUGINHOST_LV2=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_DISPLAY_SPLASH_SCREEN=0
    JUCE_MODAL_LOOPS_PERMITTED=1)

target_link_libraries(vch-gui PRIVATE
    juce::juce_audio_processors
    juce::juce_gui_extra
    juce::juce_recommended_config_flags
    juce::juce_recommended_warning_flags)

if(UNIX AND NOT APPLE)
    find_package(X11 REQUIRED)
    target_link_libraries(vch-gui PRIVATE X11::X11 X11::Xtst)
endif()
