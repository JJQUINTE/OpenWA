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
# Deliberately conservative: only a plain `KEY=value` line is honoured. Blanks around the `=` and the
# value, and CRLF line endings, are tolerated as dotenv tolerates them. A value carrying quotes or a
# `#`, and a `KEY: value` line, are reported and skipped rather than guessed at, because a silently
# mis-parsed path is the exact failure this exists to prevent. Nothing here exports anything — each
# key is looked up by name, so a stray entry in an operator's .env can never reach the script's own
# environment.

# openwa_env_file_value <file> <key> — print the value from one env-file layer, or nothing.
openwa_env_file_value() {
  local file="$1" key="$2" line value
  [ -f "$file" ] || return 0
  # The last line naming the key wins, as in dotenv. `KEY: value` is matched only to be reported.
  line="$(grep -E "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*[=:]" "$file" 2>/dev/null | tail -n 1)" || true
  [ -n "$line" ] || return 0
  value="${line#*"$key"}"
  value="${value#"${value%%[![:space:]]*}"}"
  case "$value" in
    =*) value="${value#=}" ;;
    *) value='#' ;; # the colon form: fall into the report below
  esac
  # Trim both ends, which also drops the CR of a CRLF line.
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    '')
      return 0
      ;;
    *\"* | *\'* | *'#'*)
      echo "[config] WARN: $file sets $key in a form these scripts do not parse (quotes, a trailing" >&2
      echo "[config]       comment or KEY: value); ignoring it. Pass $key in the environment if it matters here." >&2
      return 0
      ;;
  esac
  printf '%s' "$value"
}

# openwa_writable <path> - whether <path> can be written, or created when it does not exist yet (its
# nearest existing ancestor is then the directory that has to take it).
openwa_writable() {
  local p="$1"
  if [ -e "$p" ]; then
    [ -w "$p" ]
    return
  fi
  while [ ! -e "$p" ]; do p="$(dirname "$p")"; done
  [ -d "$p" ] && [ -w "$p" ]
}

# openwa_media_dir - STORAGE_LOCAL_PATH as the app settles it (src/config/storage-root.ts). v0.2.0 to
# v0.7.3 persisted ./uploads into .env.generated; where that cannot be created, as under the image's
# root-owned /app, the app keeps media in ./data/media instead, so the scripts have to look there too.
# Writability alone cannot tell: `docker exec` runs these as root, which can create /app/uploads while
# the app's own user cannot. The app creates a ./uploads it uses at boot, so a missing one beside an
# existing ./data/media means ./data/media is in use.
openwa_media_dir() {
  local dir
  dir="$(openwa_resolve STORAGE_LOCAL_PATH "$DATA_DIR/media")"
  case "$dir" in
    ./uploads | uploads)
      if ! openwa_writable "$dir" || { [ ! -d "$dir" ] && [ -d ./data/media ]; }; then
        echo "[config] WARN: STORAGE_LOCAL_PATH=$dir is a leftover the app does not use here, so it keeps" >&2
        echo "[config]       media in ./data/media; using that. Remove the line from .env.generated." >&2
        dir=./data/media
      fi
      ;;
  esac
  printf '%s' "$dir"
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
