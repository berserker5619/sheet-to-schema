#!/usr/bin/env bash
# usage: serve-and-drive.sh <project dir> <entry .mjs> <port> <url path> <label>
# Starts `node <entry>` in the project with PORT set, waits for it, runs drive.mjs, stops it.
set -u
W=$(cd "$(dirname "$0")" && pwd)
cd "$1"
PORT=$3 node "$2" > "server-$5.log" 2>&1 &
PID=$!
for i in $(seq 1 100); do
  curl -s -o /dev/null "http://127.0.0.1:$3/" && break
  sleep 0.1
done
node "$W/drive.mjs" "http://127.0.0.1:$3$4" "$5"
STATUS=$?
kill $PID 2>/dev/null
wait $PID 2>/dev/null
echo "--- server log ($5):"; cat "server-$5.log"
exit $STATUS
