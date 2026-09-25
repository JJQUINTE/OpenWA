#!/usr/bin/env bash
# shellcheck shell=bash
#
# Shared configuration resolution for backup.sh and restore.sh.
#
# The application fills its configuration from three layers (src/config/load-env.ts), each supplying
# only what the previous one left unset:
#
#   1. the process environment
#   2. ./.env
#   3. <data dir>/.env.generated   — written by Dashboard > Infrastructure
#
# These scripts used to read layer 1 only, so an install configured through the dashboard was backed
# up at the DEFAULT paths. That is not reliably loud: a missing database fails the run, but a
# database left at a default path from BEFORE the operator switched is archived instead, and the run
# exits 0. A backup that captured an abandoned database only reveals itself during a restore.
#
# Deliberately conservative: only a plain `KEY=value` line is honoured. A value carrying quotes or a
# `#` is reported and skipped rather than guessed at, because a silently mis-parsed path is the exact
# failure this exists to prevent. Nothing here exports anything — each key is looked up by name, so a
# stray entry in an operator's .env can never reach the script's own environment.

# openwa_env_file_value <file> <key> — print the value from one env-file layer, or nothing.
openwa_env_file_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 0
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}=" "$file" 2>/dev/null | tail -n 1)" || true
  [ -n "$line" ] || return 0
  value="${line#*=}"
  case "$value" in
    '')
      return 0
      ;;
    *\"* | *\'* | *'#'*)
      echo "[config] WARN: $file sets $key in a form these scripts do not parse (quotes or a trailing" >&2
      echo "[config]       comment) — ignoring it. Pass $key in the environment if it matters here." >&2
      return 0
      ;;
  esac
  printf '%s' "$value"
}

# Layer 3. Set here rather than read from the environment, so it can never arrive from an operator's
# shell; restore.sh points it at the archive's copy, which replaces this file during the restore.
OPENWA_GENERATED_ENV="${DATA_DIR:-./data}/.env.generated"

# openwa_resolve <key> <default> - the application's precedence: environment, then ./.env, then
# $OPENWA_GENERATED_ENV, then the built-in default. Requires DATA_DIR to be set before sourcing.
openwa_resolve() {
  local key="$1" fallback="$2" current value layer
  current="$(printenv "$key" 2>/dev/null || true)"
  if [ -n "$current" ]; then
    printf '%s' "$current"
    return 0
  fi
  for layer in "./.env" "$OPENWA_GENERATED_ENV"; do
    value="$(openwa_env_file_value "$layer" "$key")"
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
  printf '%s' "$fallback"
}
