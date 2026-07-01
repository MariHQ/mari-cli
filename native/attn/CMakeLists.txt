cmake_minimum_required(VERSION 3.16)
project(attn_extract CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

# Path to a built llama.cpp checkout: -DLLAMA_CPP_DIR=... wins, then $LLAMA_CPP_DIR, then
# ~/llama.cpp as the fallback default.
if(DEFINED ENV{LLAMA_CPP_DIR})
    set(LLAMA_CPP_DIR "$ENV{LLAMA_CPP_DIR}" CACHE PATH "Path to llama.cpp checkout (must be built)")
else()
    set(LLAMA_CPP_DIR "$ENV{HOME}/llama.cpp" CACHE PATH "Path to llama.cpp checkout (must be built)")
endif()
set(LLAMA_DIR "${LLAMA_CPP_DIR}")
set(LLAMA_BUILD_DIR "${LLAMA_DIR}/build" CACHE PATH "llama.cpp build directory")

# Shared-library suffix differs per platform (.dylib on macOS, .so on Linux).
if(APPLE)
    set(_SHLIB_SUFFIX ".dylib")
else()
    set(_SHLIB_SUFFIX ".so")
endif()

if(NOT EXISTS "${LLAMA_BUILD_DIR}/bin/libllama${_SHLIB_SUFFIX}")
    message(FATAL_ERROR "Expected built llama at ${LLAMA_BUILD_DIR}/bin/libllama${_SHLIB_SUFFIX}. "
        "Build llama.cpp first, then point -DLLAMA_CPP_DIR (or $LLAMA_CPP_DIR) at the checkout.")
endif()

find_package(Threads REQUIRED)

add_library(llama SHARED IMPORTED)
set_target_properties(llama PROPERTIES
    IMPORTED_LOCATION "${LLAMA_BUILD_DIR}/bin/libllama${_SHLIB_SUFFIX}"
    INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_DIR}/include;${LLAMA_DIR}/ggml/include;${LLAMA_DIR}/src")

add_library(llama-common SHARED IMPORTED)
set_target_properties(llama-common PROPERTIES
    IMPORTED_LOCATION "${LLAMA_BUILD_DIR}/bin/libllama-common${_SHLIB_SUFFIX}"
    INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_DIR}/common;${LLAMA_DIR}/include;${LLAMA_DIR}/ggml/include;${LLAMA_DIR}/src")

add_library(ggml SHARED IMPORTED)
set_target_properties(ggml PROPERTIES
    IMPORTED_LOCATION "${LLAMA_BUILD_DIR}/bin/libggml${_SHLIB_SUFFIX}"
    INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_DIR}/ggml/include;${LLAMA_DIR}/ggml/src;${LLAMA_DIR}/include")

set(LLAMA_INSTALL_VERSION "0.0.1")
set(LLAMA_TOOLS_INSTALL OFF)
add_subdirectory("${LLAMA_DIR}/tools/mtmd" "${CMAKE_BINARY_DIR}/mtmd" EXCLUDE_FROM_ALL)

# OpenMP: Homebrew libomp on macOS (Apple clang has no bundled runtime); native OpenMP elsewhere.
if(APPLE)
    set(OMP_PREFIX "/opt/homebrew/opt/libomp" CACHE PATH "Homebrew libomp prefix")
    set(_OMP_INCLUDE "${OMP_PREFIX}/include")
    set(_OMP_COMPILE_OPTS -Xpreprocessor -fopenmp)
    set(_OMP_LINK_LIBS "${OMP_PREFIX}/lib/libomp.dylib")
else()
    find_package(OpenMP)
    set(_OMP_INCLUDE "")
    if(OpenMP_CXX_FOUND)
        set(_OMP_COMPILE_OPTS ${OpenMP_CXX_FLAGS})
        set(_OMP_LINK_LIBS OpenMP::OpenMP_CXX)
    else()
        set(_OMP_COMPILE_OPTS "")
        set(_OMP_LINK_LIBS "")
    endif()
endif()

# GGML backend libs differ per platform (Metal is macOS-only).
set(_GGML_LIBS ggml-base ggml-cpu)
if(APPLE)
    list(APPEND _GGML_LIBS ggml-metal ggml-blas)
endif()

function(mari_attn_configure tgt)
    target_include_directories(${tgt} PRIVATE
        "${LLAMA_DIR}/include"
        "${LLAMA_DIR}/ggml/include"
        "${LLAMA_DIR}/common"
        "${LLAMA_DIR}/src"
        "${LLAMA_DIR}/tools/mtmd")
    if(_OMP_INCLUDE)
        target_include_directories(${tgt} PRIVATE "${_OMP_INCLUDE}")
    endif()
    if(_OMP_COMPILE_OPTS)
        target_compile_options(${tgt} PRIVATE ${_OMP_COMPILE_OPTS})
    endif()
    target_link_directories(${tgt} PRIVATE "${LLAMA_BUILD_DIR}/bin")
    target_link_libraries(${tgt} PRIVATE
        mtmd llama-common ggml ${_GGML_LIBS} Threads::Threads z ${_OMP_LINK_LIBS})
    # Make the runtime able to find the shared libs alongside the binary.
    set_target_properties(${tgt} PROPERTIES
        BUILD_RPATH "${LLAMA_BUILD_DIR}/bin"
        INSTALL_RPATH "${LLAMA_BUILD_DIR}/bin")
endfunction()

add_executable(attn_extract main.cpp)
mari_attn_configure(attn_extract)

# ── Mari's entry point: same core (main.cpp) with Mari findings-JSON output modes ──
add_executable(mari_attn mari_attn.cpp)
target_include_directories(mari_attn PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}")
mari_attn_configure(mari_attn)
