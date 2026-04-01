#!/bin/bash
# copy-v1-modules.sh
# Run this after cloning to copy the unchanged V1 modules into V2
# Usage: bash copy-v1-modules.sh /path/to/base-arb-bot-v1

SRC=${1:-../base-arb-bot}

echo "Copying shared modules from V1: $SRC"

cp -r "$SRC/filters"     ./filters
cp -r "$SRC/simulation"  ./simulation
cp -r "$SRC/utils"       ./utils
cp    "$SRC/hardhat.config.js" ./hardhat.config.js
cp -r "$SRC/scripts"     ./scripts
cp -r "$SRC/test"        ./test

echo "Done. V2 now has all V1 modules plus the new V2 engine."
