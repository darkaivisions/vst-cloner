cmake_minimum_required(VERSION 3.22)

project(vch_clone VERSION 0.1.0 LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
    set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()

set(VCH_JUCE_DIR "" CACHE PATH "Path to a local JUCE checkout (otherwise JUCE is downloaded)")
set(CLONE_NAME "vst-cloner clone" CACHE STRING "Plugin name (shown in the DAW)")
set(CLONE_FILE_NAME "${CLONE_NAME}" CACHE STRING "Name of the plugin files (no characters that break make or file systems)")
set(CLONE_CODE "Vc00" CACHE STRING "Four-character plugin code")
set(CLONE_GENERATED_DIR "${CMAKE_CURRENT_SOURCE_DIR}/generated" CACHE PATH "Directory containing CloneModel.h and CloneGui.h")

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

juce_add_plugin(vch_clone
    PRODUCT_NAME "${CLONE_FILE_NAME}"
    PLUGIN_NAME "${CLONE_NAME}"
    COMPANY_NAME "vst-cloner"
    BUNDLE_ID "org.vstcloner.${CLONE_CODE}"
    PLUGIN_MANUFACTURER_CODE Vcln
    PLUGIN_CODE ${CLONE_CODE}
    FORMATS VST3 LV2
    LV2URI "urn:vst-cloner:${CLONE_CODE}"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT FALSE
    NEEDS_MIDI_OUTPUT FALSE
    IS_MIDI_EFFECT FALSE
    VST3_CATEGORIES Fx EQ
    COPY_PLUGIN_AFTER_BUILD FALSE)

target_sources(vch_clone PRIVATE src/CloneProcessor.cpp src/CloneEditor.cpp)
target_include_directories(vch_clone PRIVATE src ${CLONE_GENERATED_DIR})

target_compile_definitions(vch_clone PUBLIC
    VCH_EQ_EDITOR=1
    JUCE_WEB_BROWSER=0
    JUCE_USE_CURL=0
    JUCE_VST3_CAN_REPLACE_VST2=0
    JUCE_DISPLAY_SPLASH_SCREEN=0)

target_link_libraries(vch_clone
    PRIVATE juce::juce_audio_utils
    PUBLIC juce::juce_recommended_config_flags juce::juce_recommended_warning_flags)
