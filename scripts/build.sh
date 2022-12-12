#!/bin/sh
tsc
echo "#!/usr/bin/env node\n$(cat build/src/main.js)" > build/src/main.js
