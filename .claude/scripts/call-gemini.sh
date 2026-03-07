#!/bin/bash
# call-gemini.sh — Calls Gemini API for Staff Engineer 2 and Tiebreaker
# Usage: bash .claude/scripts/call-gemini.sh <model> <prompt>
# Models: gemini-2.5-pro | gemini-2.5-flash
#
# Requires: GEMINI_API_KEY environment variable
# Get your key at: https://aistudio.google.com/apikey

MODEL="${1}"
PROMPT="${2}"

if [ -z "$GEMINI_API_KEY" ]; then
  echo "ERROR: GEMINI_API_KEY environment variable not set."
  echo "Get your free API key at: https://aistudio.google.com/apikey"
  echo "Then run: export GEMINI_API_KEY=your_key_here"
  exit 1
fi

if [ -z "$MODEL" ] || [ -z "$PROMPT" ]; then
  echo "ERROR: Usage: bash call-gemini.sh <model> <prompt>"
  exit 1
fi

# Map shorthand to full model name
case "$MODEL" in
  "gemini-2.5-pro")
    FULL_MODEL="gemini-2.5-pro"
    ;;
  "gemini-2.5-flash")
    FULL_MODEL="gemini-2.5-flash"
    ;;
  *)
    FULL_MODEL="$MODEL"
    ;;
esac

# Escape the prompt for JSON
ESCAPED_PROMPT=$(echo "$PROMPT" | python3 -c "import sys, json; print(json.dumps(sys.stdin.read()))")

RESPONSE=$(curl -s \
  "https://generativelanguage.googleapis.com/v1beta/models/${FULL_MODEL}:generateContent?key=${GEMINI_API_KEY}" \
  -H 'Content-Type: application/json' \
  -d "{
    \"contents\": [{
      \"parts\": [{\"text\": ${ESCAPED_PROMPT}}]
    }],
    \"generationConfig\": {
      \"temperature\": 0.3,
      \"maxOutputTokens\": 4096
    }
  }")

# Extract the text response
echo "$RESPONSE" | python3 -c "
import sys, json
data = json.load(sys.stdin)
try:
    text = data['candidates'][0]['content']['parts'][0]['text']
    print(text)
except (KeyError, IndexError) as e:
    print('ERROR: Could not parse Gemini response')
    print(json.dumps(data, indent=2))
    sys.exit(1)
"