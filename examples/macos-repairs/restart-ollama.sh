#!/bin/sh
set -eu

if command -v brew >/dev/null 2>&1 && brew services list 2>/dev/null | grep -q '^ollama '; then
  echo "Restarting Ollama with brew services..."
  brew services restart ollama
elif launchctl print "gui/$(id -u)/com.ollama.ollama" >/dev/null 2>&1; then
  echo "Restarting Ollama launchd service..."
  launchctl kickstart -k "gui/$(id -u)/com.ollama.ollama"
else
  echo "Opening Ollama.app..."
  open -a Ollama
fi

for attempt in 1 2 3 4 5; do
  if curl -fsS http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "Ollama is responding"
    exit 0
  fi
  echo "Waiting for Ollama... attempt $attempt"
  sleep 3
done

echo "Ollama did not respond after restart"
exit 1
