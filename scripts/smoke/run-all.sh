#!/usr/bin/env bash
# Runs every smoke test against the real OpenRouter API (costs a few cents).
set -u
cd "$(dirname "$0")/../.."
E=--env-file=.env
bun $E scripts/smoke/05-key.ts
bun $E scripts/smoke/01-jev.ts
bun $E scripts/smoke/02-chat.ts deepseek/deepseek-v4.1-flash-1017
bun $E scripts/smoke/02-chat.ts openai/gpt-6-luna
bun $E scripts/smoke/04-embeddings.ts
bun $E scripts/smoke/05-key.ts
