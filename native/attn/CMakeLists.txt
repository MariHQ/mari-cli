cmake_minimum_required(VERSION 3.16)
project(attn_extract CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_BUILD_TYPE Release CACHE STRING "" FORCE)

set(LLAMA_DIR "/Users/henneberger/llama.cpp" CACHE PATH "Path to llama.cpp checkout (must be built)")
set(LLAMA_BUILD_DIR "${LLAMA_DIR}/build")

if(NOT EXISTS "${LLAMA_BUILD_DIR}/bin/libllama.dylib")
    message(FATAL_ERROR "Expected built llama at ${LLAMA_BUILD_DIR}/bin/libllama.dylib. Build llama.cpp first.")
endif()

find_package(Threads REQUIRED)

add_library(llama SHARED IMPORTED)
set_target_properties(llama PROPERTIES
    IMPORTED_LOCATION "${LLAMA_BUILD_DIR}/bin/libllama.dylib"
    INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_DIR}/include;${LLAMA_DIR}/ggml/include;${LLAMA_DIR}/src")

add_library(llama-common SHARED IMPORTED)
set_target_properties(llama-common PROPERTIES
    IMPORTED_LOCATION "${LLAMA_BUILD_DIR}/bin/libllama-common.dylib"
    INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_DIR}/common;${LLAMA_DIR}/include;${LLAMA_DIR}/ggml/include;${LLAMA_DIR}/src")

add_library(ggml SHARED IMPORTED)
set_target_properties(ggml PROPERTIES
    IMPORTED_LOCATION "${LLAMA_BUILD_DIR}/bin/libggml.dylib"
    INTERFACE_INCLUDE_DIRECTORIES "${LLAMA_DIR}/ggml/include;${LLAMA_DIR}/ggml/src;${LLAMA_DIR}/include")

set(LLAMA_INSTALL_VERSION "0.0.1")
set(LLAMA_TOOLS_INSTALL OFF)
add_subdirectory("${LLAMA_DIR}/tools/mtmd" "${CMAKE_BINARY_DIR}/mtmd" EXCLUDE_FROM_ALL)

add_executable(attn_extract main.cpp)

# Homebrew libomp on macOS
set(OMP_PREFIX "/opt/homebrew/opt/libomp")
target_include_directories(attn_extract PRIVATE
    "${LLAMA_DIR}/include"
    "${LLAMA_DIR}/ggml/include"
    "${LLAMA_DIR}/common"
    "${LLAMA_DIR}/src"
    "${LLAMA_DIR}/tools/mtmd"
    "${OMP_PREFIX}/include"
)
target_compile_options(attn_extract PRIVATE -Xpreprocessor -fopenmp)
target_link_libraries(attn_extract PRIVATE "${OMP_PREFIX}/lib/libomp.dylib")

target_link_directories(attn_extract PRIVATE "${LLAMA_BUILD_DIR}/bin")
target_link_libraries(attn_extract PRIVATE
    mtmd
    llama-common
    ggml
    ggml-base
    ggml-cpu
    ggml-metal
    ggml-blas
    Threads::Threads
    z
)

# Make the runtime able to find the dylibs alongside the binary.
set_target_properties(attn_extract PROPERTIES
    BUILD_RPATH "${LLAMA_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_BUILD_DIR}/bin"
)

# ── Mari's entry point: same core (main.cpp), forces --mari-coverage, emits findings JSON ──
add_executable(mari_attn mari_attn.cpp)
target_include_directories(mari_attn PRIVATE
    "${LLAMA_DIR}/include"
    "${LLAMA_DIR}/ggml/include"
    "${LLAMA_DIR}/common"
    "${LLAMA_DIR}/src"
    "${LLAMA_DIR}/tools/mtmd"
    "${OMP_PREFIX}/include"
    "${CMAKE_CURRENT_SOURCE_DIR}"
)
target_compile_options(mari_attn PRIVATE -Xpreprocessor -fopenmp)
target_link_libraries(mari_attn PRIVATE "${OMP_PREFIX}/lib/libomp.dylib")
target_link_directories(mari_attn PRIVATE "${LLAMA_BUILD_DIR}/bin")
target_link_libraries(mari_attn PRIVATE
    mtmd llama-common ggml ggml-base ggml-cpu ggml-metal ggml-blas Threads::Threads z)
set_target_properties(mari_attn PROPERTIES
    BUILD_RPATH "${LLAMA_BUILD_DIR}/bin"
    INSTALL_RPATH "${LLAMA_BUILD_DIR}/bin"
)
