#!/bin/sh
node -r ts-node/register --inspect=37373 "src/main.ts" --scan-config > /tmp/quickscript-config.json
npx config-builder --definition_file /tmp/quickscript-config.json
rm /tmp/quickscript-config.json
