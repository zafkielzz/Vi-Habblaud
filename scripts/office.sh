#!/bin/sh
# npm run office: builds and starts the office in the background, apart from any terminal (a session opened in its web
# terminal lives inside this server, so it must outlive the shell that started it). Then open the address it prints.
set -eu
cd "$(dirname "$0")/.."
port="${HABBLAUD_PORT:-4747}"
url="http://127.0.0.1:$port"
if curl -s -o /dev/null --max-time 2 "$url/"; then
  echo "The office is already running: $url"
  exit 0
fi
npm run build --silent
log="$HOME/.habblaud/office.log"
mkdir -p "${log%/*}"
HABBLAUD_PTY=1 HABBLAUD_WORLD=0 HABBLAUD_UPDATE_CHECK=0 setsid nohup node dist/server/index.js > "$log" 2>&1 < /dev/null &
echo "The office is starting: $url (log: $log)"
