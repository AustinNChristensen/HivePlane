#!/bin/sh
set -eu

REQUIRED_MODELS="${HIVEPLANE_REQUIRED_OLLAMA_MODELS:-}"

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required to check Ollama models"
  exit 1
fi

models_json="$(curl -fsS http://127.0.0.1:11434/api/tags)"

if [ -z "$REQUIRED_MODELS" ]; then
  echo "$models_json" | sed -E 's/[[:space:]]+/ /g' | cut -c 1-500
  exit 0
fi

missing=""
old_ifs="$IFS"
IFS=","
for model in $REQUIRED_MODELS; do
  trimmed="$(printf '%s' "$model" | sed 's/^ *//;s/ *$//')"
  [ -z "$trimmed" ] && continue
  if ! printf '%s' "$models_json" | grep -F "\"name\":\"$trimmed\"" >/dev/null 2>&1; then
    missing="$missing $trimmed"
  fi
done
IFS="$old_ifs"

if [ -n "$missing" ]; then
  echo "Missing Ollama models:$missing"
  exit 1
fi

echo "Required Ollama models are present: $REQUIRED_MODELS"
