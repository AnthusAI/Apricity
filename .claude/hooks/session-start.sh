#!/bin/bash
# Claude Code on the web starts every session from a fresh container, so the
# Kanbus CLI that AGENTS.md requires is installed here for remote sessions.
set -euo pipefail

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

if command -v kbs >/dev/null 2>&1 || command -v kanbus >/dev/null 2>&1; then
  echo "Kanbus CLI already installed"
  exit 0
fi

echo "Installing the Kanbus CLI"
python3 -m pip install --quiet --root-user-action=ignore kanbus cffi
kanbus --version
