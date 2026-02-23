#!/bin/bash

# Compile all configurations
# This script compiles WASM modules with different thread pool sizes and memory limits

echo "========================================"
echo "Compiling all WASM module configurations"
echo "========================================"

# Configuration array: (pool_size max_memory)
configs=(
    "1 2GB"
    "4 4GB"
    "8 4GB"
    "8 8GB"
    "16 8GB"
    "16 16GB"
    "32 16GB"
)

for config in "${configs[@]}"; do
    set -- $config
    pool_size=$1
    max_memory=$2
    
    echo ""
    echo "----------------------------------------"
    echo "Building config: pool_size=${pool_size}, max_memory=${max_memory}"
    echo "----------------------------------------"
    
    bash ./compile.sh ${pool_size} ${max_memory}
    
    if [ $? -eq 0 ]; then
        echo "✓ Successfully compiled pool_size=${pool_size}, max_memory=${max_memory}"
    else
        echo "✗ Failed to compile pool_size=${pool_size}, max_memory=${max_memory}"
        exit 1
    fi
done

echo ""
echo "========================================"
echo "All configurations compiled successfully!"
echo "========================================"
