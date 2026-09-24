#!/usr/bin/env bash
# Smoke test: scripts/backup.sh + scripts/restore.sh.
#
# Covers:
#   (a) custom MAIN_DATABASE_NAME / DATABASE_NAME are honored by BOTH scripts
#   (b) a missing source database fails hard (non-zero, clear message, no archive)
#   (c) backup -> restore roundtrip via sqlite3 .backup (skipped with a notice when the host
#       has no sqlite3 — everything else still runs)
#   (d) the cp fallback writes a CONSISTENCY-WARNING marker into the archive, restore warns
#       but continues, and restore --strict refuses
#   (e) the archive min-content check rejects (and deletes) an archive missing a required DB
#   (f) data/.env.generated supplies paths the environment does not
#   (g) PLUGIN_STATE_DIR plugin state is archived and restored at the configured root
#   (h) restore refuses a live target without --force, before touching anything
#   (i) the data-store half of that guard refuses on its own
#   (j) a probe that fails or prints no usable count leaves the target counted as live
#   (k) an operator's sqlite3 rc file changes neither answer of the guard (skipped without sqlite3)
#   (l) an unwritable BACKUP_DIR fails before anything is staged (skipped as root)
#   (m) OPENWA_RESTORE_SNAPSHOT_DIR takes the data-dir snapshot off a read-only parent (skipped as root)
#   (n) a state dir outside the data dir is snapshotted before any database is written, and under
#       OPENWA_RESTORE_SNAPSHOT_DIR when that is set (skipped as root)
#   (o) such a state dir under a read-only parent, a mount point in the container, is restored in
#       place (skipped as root)
#   (p) a symlinked database target or data dir is snapshotted as a copy of what the link points at
#
# Usage: ./scripts/smoke-test-backup-restore.sh
# Requires: bash, tar, node (restore.sh path resolution). sqlite3 is optional (see (c) and (k)).
set -euo pipefail

# backup.sh and restore.sh take these from the environment before anything else. An exported value
# would aim a case at a real install, and restore replaces the state directories wholesale, so every
# case starts from none of them and sets exactly the paths it uses.
unset OPENWA_DATA_DIR BACKUP_DIR DATABASE_TYPE MAIN_DATABASE_NAME DATABASE_NAME SESSION_DATA_PATH \
  BAILEYS_AUTH_DIR STORAGE_LOCAL_PATH PLUGINS_DIR PLUGIN_STATE_DIR OPENWA_RESTORE_SNAPSHOT_DIR

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP="$REPO_ROOT/scripts/backup.sh"
RESTORE="$REPO_ROOT/scripts/restore.sh"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

HAS_SQLITE3=0
if command -v sqlite3 >/dev/null 2>&1; then
  HAS_SQLITE3=1
fi

pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# A fixture database: a real SQLite file with a sentinel row when sqlite3 is available (backup.sh
# uses .backup then, which refuses non-database files), else a plain marker file for the cp path.
make_fixture() {
  if [ "$HAS_SQLITE3" -eq 1 ]; then
    sqlite3 "$1" "CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('$2');"
  else
    printf 'sentinel:%s\n' "$2" >"$1"
  fi
}

# Content fingerprint that works for both fixture kinds above. sqlite3 .backup does NOT guarantee
# a byte-identical copy, so never cmp(1) databases that went through it.
db_fingerprint() {
  if [ "$HAS_SQLITE3" -eq 1 ]; then
    sqlite3 "$1" "SELECT payload FROM sentinel;"
  else
    sed 's/^sentinel://' "$1"
  fi
}

# A PATH farm with every tool backup.sh needs. Used to hide sqlite3 (forcing the cp fallback) or
# to shadow tar (simulating an incomplete archive) without touching the real scripts.
populate_shim() {
  shim_dir="$1"
  tools="env bash sh cp tar gzip mktemp date rm sed mkdir ls cat chmod grep printf uname dirname"
  if [ "${2:-}" = "with-sqlite3" ]; then
    tools="$tools sqlite3"
  fi
  for tool in $tools; do
    src="$(command -v "$tool" 2>/dev/null || true)"
    if [ -n "$src" ]; then
      ln -sf "$src" "$shim_dir/$tool"
    fi
  done
}

echo "==> (a) custom MAIN_DATABASE_NAME / DATABASE_NAME are honored"
A="$WORK/a"
mkdir -p "$A/custom" "$A/state" "$A/restore"
make_fixture "$A/custom/auth.sqlite" "alpha-main"
make_fixture "$A/custom/store.sqlite" "alpha-data"
(
  cd "$A"
  MAIN_DATABASE_NAME="$A/custom/auth.sqlite" \
    DATABASE_NAME="$A/custom/store.sqlite" \
    OPENWA_DATA_DIR="$A/state" \
    BACKUP_DIR="$A/out" \
    "$BACKUP" >/dev/null
)
ARCHIVE_A="$(ls "$A"/out/openwa-backup-*.tar.gz)"
if ! tar -tzf "$ARCHIVE_A" | grep -qx './main.sqlite'; then
  fail "(a) archive missing ./main.sqlite"
fi
if ! tar -tzf "$ARCHIVE_A" | grep -qx './openwa.sqlite'; then
  fail "(a) archive missing ./openwa.sqlite"
fi
(
  cd "$A/restore"
  MAIN_DATABASE_NAME="$A/restore/custom-main.sqlite" \
    DATABASE_NAME="$A/restore/custom-data.sqlite" \
    OPENWA_DATA_DIR="$A/restore/state" \
    "$RESTORE" "$ARCHIVE_A" >/dev/null
)
if [ "$(db_fingerprint "$A/restore/custom-main.sqlite")" != "alpha-main" ]; then
  fail "(a) main DB not restored to the MAIN_DATABASE_NAME path"
fi
if [ "$(db_fingerprint "$A/restore/custom-data.sqlite")" != "alpha-data" ]; then
  fail "(a) data DB not restored to the DATABASE_NAME path"
fi
pass "(a) env-resolved DB paths honored by backup.sh and restore.sh"

echo ""
echo "==> (b) missing source database fails hard"
B="$WORK/b"
mkdir -p "$B"
set +e
OUT_B="$(cd "$B" && OPENWA_DATA_DIR="$B/state" BACKUP_DIR="$B/out" "$BACKUP" 2>&1)"
RC_B=$?
set -e
if [ "$RC_B" -eq 0 ]; then
  fail "(b) backup.sh exited 0 with no database present (silent empty backup)"
fi
if ! printf '%s' "$OUT_B" | grep -q 'main.sqlite'; then
  fail "(b) error message does not name the missing main database"
fi
if [ -n "$(ls "$B/out" 2>/dev/null || true)" ]; then
  fail "(b) an archive was written despite the missing database"
fi
# Only the data store missing (default paths) must also fail, naming openwa.sqlite.
B2="$WORK/b2"
mkdir -p "$B2/data"
make_fixture "$B2/data/main.sqlite" "b2-main"
set +e
OUT_B2="$(cd "$B2" && BACKUP_DIR="$B2/out" "$BACKUP" 2>&1)"
RC_B2=$?
set -e
if [ "$RC_B2" -eq 0 ]; then
  fail "(b) backup.sh exited 0 with the data store missing"
fi
if ! printf '%s' "$OUT_B2" | grep -q 'openwa.sqlite'; then
  fail "(b) error message does not name the missing data store"
fi
pass "(b) missing DB -> non-zero exit, clear message, no archive"

echo ""
if [ "$HAS_SQLITE3" -eq 1 ]; then
  echo "==> (c) backup -> restore roundtrip via sqlite3 .backup (default paths)"
  C="$WORK/c"
  mkdir -p "$C/src/data" "$C/dst"
  sqlite3 "$C/src/data/main.sqlite" "CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('c-main');"
  sqlite3 "$C/src/data/openwa.sqlite" "CREATE TABLE sentinel(payload TEXT); INSERT INTO sentinel VALUES('c-data');"
  (
    cd "$C/src"
    BACKUP_DIR="$C/out" "$BACKUP" >/dev/null
  )
  ARCHIVE_C="$(ls "$C"/out/openwa-backup-*.tar.gz)"
  if tar -tzf "$ARCHIVE_C" | grep -q 'CONSISTENCY-WARNING'; then
    fail "(c) unexpected CONSISTENCY-WARNING marker with sqlite3 present"
  fi
  (
    cd "$C/dst"
    "$RESTORE" "$ARCHIVE_C" >/dev/null
  )
  if [ "$(sqlite3 "$C/dst/data/main.sqlite" 'SELECT payload FROM sentinel;')" != "c-main" ]; then
    fail "(c) main DB contents did not survive the roundtrip"
  fi
  if [ "$(sqlite3 "$C/dst/data/openwa.sqlite" 'SELECT payload FROM sentinel;')" != "c-data" ]; then
    fail "(c) data store contents did not survive the roundtrip"
  fi
  pass "(c) .backup roundtrip preserves database contents"
else
  echo "SKIP: (c) sqlite3 not found on this host — skipping the .backup roundtrip"
fi

echo ""
echo "==> (d) cp fallback marker + restore warning + --strict refusal"
D="$WORK/d"
mkdir -p "$D/src/data" "$D/shim" "$D/dst"
# Plain files are fine here: the shim PATH hides sqlite3, so backup.sh takes the cp branch
# regardless of what the host provides.
printf 'd-main\n' >"$D/src/data/main.sqlite"
printf 'd-data\n' >"$D/src/data/openwa.sqlite"
populate_shim "$D/shim"
(
  cd "$D/src"
  PATH="$D/shim" BACKUP_DIR="$D/out" "$BACKUP" >"$D/backup.log" 2>&1
)
ARCHIVE_D="$(ls "$D"/out/openwa-backup-*.tar.gz)"
if ! tar -tzf "$ARCHIVE_D" | grep -q 'CONSISTENCY-WARNING'; then
  fail "(d) fallback archive does not carry the CONSISTENCY-WARNING marker"
fi
if ! grep -q 'sqlite3' "$D/backup.log"; then
  fail "(d) backup.sh did not print the loud fallback warning"
fi
OUT_D="$(cd "$D/dst" && "$RESTORE" "$ARCHIVE_D" 2>&1)"
if ! printf '%s' "$OUT_D" | grep -q 'CONSISTENCY-WARNING'; then
  fail "(d) restore.sh did not surface the consistency warning"
fi
if [ "$(cat "$D/dst/data/main.sqlite")" != "d-main" ]; then
  fail "(d) fallback archive did not restore the main DB"
fi
set +e
OUT_DS="$(cd "$D/dst" && "$RESTORE" "$ARCHIVE_D" --strict 2>&1)"
RC_DS=$?
set -e
if [ "$RC_DS" -eq 0 ]; then
  fail "(d) restore --strict exited 0 on a marked archive"
fi
if ! printf '%s' "$OUT_DS" | grep -q -- '--strict'; then
  fail "(d) --strict refusal message is not explicit"
fi
pass "(d) fallback marker written, restore warns and continues, --strict refuses"

echo ""
echo "==> (e) archive min-content check rejects an incomplete archive"
E="$WORK/e"
mkdir -p "$E/src/data" "$E/shim"
make_fixture "$E/src/data/main.sqlite" "e-main"
make_fixture "$E/src/data/openwa.sqlite" "e-data"
if [ "$HAS_SQLITE3" -eq 1 ]; then
  populate_shim "$E/shim" with-sqlite3
else
  populate_shim "$E/shim"
fi
# Shadow tar: create the archive WITHOUT ./openwa.sqlite to simulate a truncated backup.
# (remove the populate_shim symlink first — writing through it would target the real tar)
rm -f "$E/shim/tar"
REAL_TAR="$(command -v tar)"
cat >"$E/shim/tar" <<EOF
#!/usr/bin/env bash
if [ "\$1" = "-czf" ]; then
  out="\$2"
  shift 2
  exec "$REAL_TAR" -czf "\$out" --exclude='./openwa.sqlite' "\$@"
fi
exec "$REAL_TAR" "\$@"
EOF
chmod +x "$E/shim/tar"
set +e
OUT_E="$(cd "$E/src" && PATH="$E/shim" BACKUP_DIR="$E/out" "$BACKUP" 2>&1)"
RC_E=$?
set -e
if [ "$RC_E" -eq 0 ]; then
  fail "(e) min-content check passed an archive missing openwa.sqlite"
fi
if ! printf '%s' "$OUT_E" | grep -q 'openwa.sqlite'; then
  fail "(e) error message does not name the missing archive member"
fi
if [ -n "$(ls "$E/out" 2>/dev/null || true)" ]; then
  fail "(e) the defective archive was left on disk"
fi
pass "(e) min-content check fails hard and removes the defective archive"

echo ""
echo "==> (f) data/.env.generated supplies paths the environment does not"
# The dangerous shape: the app was pointed elsewhere through the dashboard, and a database from
# before that switch is still sitting at the DEFAULT path. Resolving from the process environment
# alone then archives the abandoned file and exits 0 — a backup that only reveals itself as wrong
# during a restore. A missing default would at least fail loudly; a stale one does not.
F="$WORK/f"
mkdir -p "$F/state" "$F/live" "$F/data" "$F/extract" "$F/restore/state"
make_fixture "$F/live/auth.sqlite" "foxtrot-live-main"
make_fixture "$F/live/store.sqlite" "foxtrot-live-data"
make_fixture "$F/data/main.sqlite" "STALE-main"
make_fixture "$F/data/openwa.sqlite" "STALE-data"
printf 'DATABASE_TYPE=sqlite\nMAIN_DATABASE_NAME=%s\nDATABASE_NAME=%s\n' \
  "$F/live/auth.sqlite" "$F/live/store.sqlite" >"$F/state/.env.generated"
(
  cd "$F"
  OPENWA_DATA_DIR="$F/state" BACKUP_DIR="$F/out" "$BACKUP" >/dev/null
)
ARCHIVE_F="$(ls "$F"/out/openwa-backup-*.tar.gz)"
tar -xzf "$ARCHIVE_F" -C "$F/extract"
if [ "$(db_fingerprint "$F/extract/main.sqlite")" != "foxtrot-live-main" ]; then
  fail "(f) backup archived the stale default main DB instead of the one data/.env.generated names"
fi
if [ "$(db_fingerprint "$F/extract/openwa.sqlite")" != "foxtrot-live-data" ]; then
  fail "(f) backup archived the stale default data DB instead of the one data/.env.generated names"
fi
# restore.sh must read the SAME layer, or it writes the databases somewhere backup.sh never looked.
printf 'DATABASE_TYPE=sqlite\nMAIN_DATABASE_NAME=%s\nDATABASE_NAME=%s\n' \
  "$F/restore/auth.sqlite" "$F/restore/store.sqlite" >"$F/restore/state/.env.generated"
(
  cd "$F/restore"
  OPENWA_DATA_DIR="$F/restore/state" "$RESTORE" "$ARCHIVE_F" >/dev/null
)
if [ "$(db_fingerprint "$F/restore/auth.sqlite")" != "foxtrot-live-main" ]; then
  fail "(f) restore ignored the MAIN_DATABASE_NAME in data/.env.generated"
fi
if [ "$(db_fingerprint "$F/restore/store.sqlite")" != "foxtrot-live-data" ]; then
  fail "(f) restore ignored the DATABASE_NAME in data/.env.generated"
fi
# An explicit environment value must still win — that is the app's precedence, not ours to change.
(
  cd "$F"
  MAIN_DATABASE_NAME="$F/data/main.sqlite" DATABASE_NAME="$F/data/openwa.sqlite" \
    OPENWA_DATA_DIR="$F/state" BACKUP_DIR="$F/out2" "$BACKUP" >/dev/null
)
rm -rf "${F:?}/extract2" && mkdir -p "$F/extract2"
tar -xzf "$(ls "$F"/out2/openwa-backup-*.tar.gz)" -C "$F/extract2"
if [ "$(db_fingerprint "$F/extract2/main.sqlite")" != "STALE-main" ]; then
  fail "(f) an explicit environment path lost to data/.env.generated — precedence is inverted"
fi
pass "(f) data/.env.generated resolves paths for both scripts, and the environment still wins"

echo ""
echo "==> (g) PLUGIN_STATE_DIR moves the registry and ctx.storage, and both scripts follow it"
# The knob names the ROOT; the app keeps plugin state at <root>/plugins. Both scripts hardcoded
# $OPENWA_DATA_DIR/plugins, so with the knob set the archive carried neither the registry nor any
# plugin's persisted storage, and the restore put nothing back. Silent both ways: an empty source
# directory simply produces no plugin-state entry.
G="$WORK/g"
mkdir -p "$G/state" "$G/elsewhere/plugins/chatwoot" "$G/extract" "$G/restore/state"
make_fixture "$G/state/main.sqlite" "golf-main"
make_fixture "$G/state/openwa.sqlite" "golf-data"
printf '{"plugins":[{"id":"chatwoot"}]}' >"$G/elsewhere/plugins/registry.json"
printf 'mapped-conversation' >"$G/elsewhere/plugins/chatwoot/key-Zm9v.json"
(
  cd "$G"
  OPENWA_DATA_DIR="$G/state" PLUGIN_STATE_DIR="$G/elsewhere" BACKUP_DIR="$G/out" \
    MAIN_DATABASE_NAME="$G/state/main.sqlite" DATABASE_NAME="$G/state/openwa.sqlite" "$BACKUP" >/dev/null
)
ARCHIVE_G="$(ls "$G"/out/openwa-backup-*.tar.gz)"
tar -xzf "$ARCHIVE_G" -C "$G/extract"
if [ ! -f "$G/extract/plugin-state/registry.json" ]; then
  fail "(g) backup ignored PLUGIN_STATE_DIR: the plugin registry is missing from the archive"
fi
if [ ! -f "$G/extract/plugin-state/chatwoot/key-Zm9v.json" ]; then
  fail "(g) backup ignored PLUGIN_STATE_DIR: a plugin's persisted ctx.storage is missing"
fi
# And the restore has to put them back where the knob points, not under the default data dir.
(
  cd "$G"
  OPENWA_DATA_DIR="$G/restore/state" PLUGIN_STATE_DIR="$G/restored-elsewhere" \
    MAIN_DATABASE_NAME="$G/restore/state/main.sqlite" DATABASE_NAME="$G/restore/state/openwa.sqlite" \
    "$RESTORE" "$ARCHIVE_G" --force >/dev/null
)
if [ ! -f "$G/restored-elsewhere/plugins/registry.json" ]; then
  fail "(g) restore ignored PLUGIN_STATE_DIR: the registry did not land under the configured root"
fi
pass "(g) PLUGIN_STATE_DIR is honoured by backup and by restore"

echo ""
echo "==> (h) restore refuses a live target without --force, before touching anything"
# The data-loss guard: both target databases hold a working install's data, so a plain restore
# must refuse (non-zero, clear message) before ANY state changes, and --force must be the exact
# switch that changes the answer.
H="$WORK/h"
mkdir -p "$H/src/data" "$H/live" "$H/out"
make_fixture "$H/src/data/main.sqlite" "hotel-archive-main"
make_fixture "$H/src/data/openwa.sqlite" "hotel-archive-data"
(
  cd "$H/src"
  BACKUP_DIR="$H/out" "$BACKUP" >/dev/null
)
ARCHIVE_H="$(ls "$H"/out/openwa-backup-*.tar.gz)"
make_fixture "$H/live/main.sqlite" "hotel-live-main"
make_fixture "$H/live/openwa.sqlite" "hotel-live-data"
set +e
OUT_H="$(cd "$H" && MAIN_DATABASE_NAME="$H/live/main.sqlite" \
  DATABASE_NAME="$H/live/openwa.sqlite" OPENWA_DATA_DIR="$H/live" \
  "$RESTORE" "$ARCHIVE_H" 2>&1)"
RC_H=$?
set -e
if [ "$RC_H" -eq 0 ]; then
  fail "(h) restore exited 0 on a live target without --force"
fi
# ASCII anchors only: the second refusal line carries a UTF-8 dash that must not be grep'd.
if ! printf '%s' "$OUT_H" | grep -q 'appear live'; then
  fail "(h) refusal message does not say the target appears live"
fi
if ! printf '%s' "$OUT_H" | grep -q -- '--force'; then
  fail "(h) refusal message does not point at --force"
fi
if ! printf '%s' "$OUT_H" | grep -qF "$H/live/main.sqlite"; then
  fail "(h) refusal message does not name the live target"
fi
if [ "$(db_fingerprint "$H/live/main.sqlite")" != "hotel-live-main" ]; then
  fail "(h) the refused restore modified the live main DB"
fi
if [ "$(db_fingerprint "$H/live/openwa.sqlite")" != "hotel-live-data" ]; then
  fail "(h) the refused restore modified the live data DB"
fi
# $H/live is non-empty, so an execution that reached the safety-snapshot step would have left a
# $H/live.pre-restore-* sibling; its absence proves the guard fired before any state was touched.
if [ -n "$(ls -d "$H"/live.pre-restore-* 2>/dev/null || true)" ]; then
  fail "(h) the refused restore left a pre-restore snapshot behind"
fi
(
  cd "$H"
  MAIN_DATABASE_NAME="$H/live/main.sqlite" DATABASE_NAME="$H/live/openwa.sqlite" \
    OPENWA_DATA_DIR="$H/live" "$RESTORE" "$ARCHIVE_H" --force >/dev/null
)
if [ "$(db_fingerprint "$H/live/main.sqlite")" != "hotel-archive-main" ]; then
  fail "(h) --force did not overwrite the live main DB after the refusal"
fi
if [ "$(db_fingerprint "$H/live/openwa.sqlite")" != "hotel-archive-data" ]; then
  fail "(h) --force did not overwrite the live data DB after the refusal"
fi
pass "(h) live target refused before any state was touched; --force overwrites"

echo ""
echo "==> (i) the data-store half of the guard refuses on its own"
# (h) makes both databases live, so its main-DB check alone satisfies every assertion there. Here the
# data store is the only database present.
I="$WORK/i"
mkdir -p "$I/bin" "$I/live"
make_fixture "$I/live/openwa.sqlite" "india-live-data"

# guarded_restore <target dir>: restore ARCHIVE_H without --force over <dir>/main.sqlite and
# <dir>/openwa.sqlite, with $I/bin first on PATH. Output lands in OUT, the exit code in RC.
guarded_restore() {
  set +e
  OUT="$(cd "$WORK" && PATH="$I/bin:$PATH" MAIN_DATABASE_NAME="$1/main.sqlite" \
    DATABASE_NAME="$1/openwa.sqlite" OPENWA_DATA_DIR="$1" "$RESTORE" "$ARCHIVE_H" 2>&1)"
  RC=$?
  set -e
}

# expect_refused <label>: a restore over $I/live must refuse, name its data store, and leave it intact.
expect_refused() {
  guarded_restore "$I/live"
  if [ "$RC" -eq 0 ]; then
    fail "($1) restore exited 0 over a live data store without --force"
  fi
  if ! printf '%s' "$OUT" | grep -qF "$I/live/openwa.sqlite"; then
    fail "($1) refusal message does not name the live data store"
  fi
  if [ "$(db_fingerprint "$I/live/openwa.sqlite")" != "india-live-data" ]; then
    fail "($1) the refused restore modified the live data store"
  fi
}

expect_refused i
pass "(i) a live data store is refused with the main DB target absent"

echo ""
echo "==> (j) a probe that fails or prints no usable count leaves the target counted as live"
# A locked, corrupt or unreadable database makes sqlite3 exit non-zero, and output that is not a bare
# count did not answer the question. Neither may be read as an empty database.
for probe in 'exit 26' 'exit 0' 'printf "count(*)\n1\n"'; do
  printf '#!/usr/bin/env bash\n%s\n' "$probe" >"$I/bin/sqlite3"
  chmod +x "$I/bin/sqlite3"
  expect_refused "j: $probe"
done
rm -f "$I/bin/sqlite3"
pass "(j) a failed, empty or non-numeric probe refuses"

echo ""
if [ "$HAS_SQLITE3" -eq 1 ]; then
  echo "==> (k) an operator's sqlite3 rc file changes neither answer of the guard"
  # sqlite3 applies the user's rc file to a one-shot query too, and headers or csv mode turn the count
  # into text. It finds that file through the passwd entry, not $HOME, so a test cannot plant one by
  # moving HOME. The wrapper loads one with -init instead; an explicit -init later on the command line
  # replaces it, exactly as it replaces ~/.sqliterc.
  printf '.headers on\n.mode csv\n' >"$I/sqliterc"
  printf '#!/usr/bin/env bash\nexec %q -init %q "$@"\n' "$(command -v sqlite3)" "$I/sqliterc" >"$I/bin/sqlite3"
  chmod +x "$I/bin/sqlite3"
  expect_refused k
  # And a database with no tables yet is still safe to restore over without --force.
  mkdir -p "$I/fresh"
  : >"$I/fresh/openwa.sqlite"
  guarded_restore "$I/fresh"
  if [ "$RC" -ne 0 ]; then
    fail "(k) the rc file made a database with no tables look live"
  fi
  pass "(k) with an rc file, a live target is still refused and an empty one still restores"
else
  echo "SKIP: (k) sqlite3 not found on this host, so there is no rc file to load"
fi

echo ""
echo "==> (l) an unwritable BACKUP_DIR fails before anything is staged"
# The shipped container mounts its root read-only, so the default ./backups cannot be created. The
# run must stop up front, not after copying every database and media file into /tmp.
if [ "$(id -u)" -ne 0 ]; then
  L="$WORK/l"
  mkdir -p "$L/data" "$L/ro"
  make_fixture "$L/data/main.sqlite" "l-main"
  make_fixture "$L/data/openwa.sqlite" "l-data"
  chmod a-w "$L/ro"
  set +e
  OUT_L="$(cd "$L" && BACKUP_DIR="$L/ro/out" "$BACKUP" 2>&1)"
  RC_L=$?
  set -e
  chmod u+w "$L/ro"
  if [ "$RC_L" -eq 0 ]; then
    fail "(l) backup.sh exited 0 with an unwritable BACKUP_DIR"
  fi
  if ! printf '%s' "$OUT_L" | grep -q 'BACKUP_DIR=.* is not writable'; then
    fail "(l) error message does not name the unwritable BACKUP_DIR"
  fi
  if printf '%s' "$OUT_L" | grep -q 'Backing up'; then
    fail "(l) state was staged before the BACKUP_DIR check"
  fi
  pass "(l) unwritable BACKUP_DIR -> non-zero exit before staging, clear message"
else
  echo "SKIP: (l) running as root, which ignores the permission bits this case relies on"
fi

echo ""
echo "==> (m) OPENWA_RESTORE_SNAPSHOT_DIR takes the data-dir snapshot off a read-only parent"
# The shipped compose file and Helm chart mount the data dir as a volume under a read-only root, so
# the snapshot's default place next to it cannot be written and the restore stopped there.
if [ "$(id -u)" -ne 0 ]; then
  M="$WORK/m"
  mkdir -p "$M/root/data" "$M/snapshots"
  printf 'mike-before\n' >"$M/root/data/.api-key"
  chmod a-w "$M/root"
  set +e
  OUT_M="$(cd "$M" && MAIN_DATABASE_NAME="$M/root/data/main.sqlite" DATABASE_NAME="$M/root/data/openwa.sqlite" \
    OPENWA_DATA_DIR="$M/root/data" OPENWA_RESTORE_SNAPSHOT_DIR="$M/snapshots" "$RESTORE" "$ARCHIVE_H" 2>&1)"
  RC_M=$?
  set -e
  chmod u+w "$M/root"
  if [ "$RC_M" -ne 0 ]; then
    fail "(m) restore failed with a writable OPENWA_RESTORE_SNAPSHOT_DIR: $OUT_M"
  fi
  if [ "$(cat "$M"/snapshots/data.pre-restore-*/.api-key 2>/dev/null || true)" != "mike-before" ]; then
    fail "(m) the data-dir snapshot is not under OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  if [ "$(db_fingerprint "$M/root/data/main.sqlite")" != "hotel-archive-main" ]; then
    fail "(m) the restore did not put the archived main DB in place"
  fi
  pass "(m) data-dir snapshot written under OPENWA_RESTORE_SNAPSHOT_DIR, restore completes"
else
  echo "SKIP: (m) running as root, which ignores the permission bits this case relies on"
fi

echo ""
echo "==> (n) a state dir outside the data dir is snapshotted before any database is written"
# SESSION_DATA_PATH on its own mount has a parent of its own. When that parent is read-only, the
# snapshot of the directory cannot go next to it, and a restore that finds out only after writing
# the databases leaves them from the archive and the sessions from the live install.
if [ "$(id -u)" -ne 0 ]; then
  N="$WORK/n"
  mkdir -p "$N/src/data/sessions/session-s1" "$N/live" "$N/ro/sessions/session-s1" "$N/ext/sessions/session-s1"
  make_fixture "$N/src/data/main.sqlite" "november-archive-main"
  make_fixture "$N/src/data/openwa.sqlite" "november-archive-data"
  printf 'november-archive\n' >"$N/src/data/sessions/session-s1/marker"
  (
    cd "$N/src"
    BACKUP_DIR="$N/out" "$BACKUP" >/dev/null
  )
  ARCHIVE_N="$(ls "$N"/out/openwa-backup-*.tar.gz)"
  make_fixture "$N/live/main.sqlite" "november-live-main"
  make_fixture "$N/live/openwa.sqlite" "november-live-data"
  printf 'november-live\n' >"$N/ro/sessions/session-s1/marker"
  printf 'november-live\n' >"$N/ext/sessions/session-s1/marker"

  # restore_n <sessions dir> [snapshot dir]: a forced restore of ARCHIVE_N over $N/live. Output lands
  # in OUT, the exit code in RC.
  restore_n() {
    set +e
    OUT="$(cd "$N" && MAIN_DATABASE_NAME="$N/live/main.sqlite" DATABASE_NAME="$N/live/openwa.sqlite" \
      OPENWA_DATA_DIR="$N/live" SESSION_DATA_PATH="$1" OPENWA_RESTORE_SNAPSHOT_DIR="${2:-}" \
      "$RESTORE" "$ARCHIVE_N" --force 2>&1)"
    RC=$?
    set -e
  }

  chmod a-w "$N/ro"
  restore_n "$N/ro/sessions"
  chmod u+w "$N/ro"
  if [ "$RC" -eq 0 ]; then
    fail "(n) restore exited 0 although the sessions snapshot could not be written"
  fi
  if [ "$(db_fingerprint "$N/live/main.sqlite")" != "november-live-main" ]; then
    fail "(n) the main DB was overwritten before the sessions snapshot failed"
  fi
  if [ "$(cat "$N/ro/sessions/session-s1/marker")" != "november-live" ]; then
    fail "(n) the failed restore changed the live sessions"
  fi

  restore_n "$N/ext/sessions" "$N/snapshots"
  if [ "$RC" -ne 0 ]; then
    fail "(n) restore with an external SESSION_DATA_PATH failed: $OUT"
  fi
  if [ "$(cat "$N"/snapshots/sessions.pre-restore-*/session-s1/marker 2>/dev/null || true)" != "november-live" ]; then
    fail "(n) the sessions snapshot is not under OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  if [ -n "$(ls -d "$N"/ext/sessions.pre-restore-* 2>/dev/null || true)" ]; then
    fail "(n) the sessions snapshot was written next to the target despite OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  if [ "$(cat "$N/ext/sessions/session-s1/marker")" != "november-archive" ]; then
    fail "(n) the archived sessions were not restored"
  fi
  pass "(n) external state snapshotted before the databases are written, under OPENWA_RESTORE_SNAPSHOT_DIR"

  echo ""
  echo "==> (o) a state dir whose parent is read-only is restored in place"
  # A volume mounted at /sessions can be emptied but not removed or re-created: its parent is the
  # read-only root. The unwritable parent stands in for that here.
  printf 'oscar-stale\n' >"$N/ro/sessions/stale"
  chmod a-w "$N/ro"
  restore_n "$N/ro/sessions" "$N/snapshots-o"
  chmod u+w "$N/ro"
  if [ "$RC" -ne 0 ]; then
    fail "(o) restore into a state dir under a read-only parent failed: $OUT"
  fi
  if [ "$(cat "$N/ro/sessions/session-s1/marker")" != "november-archive" ]; then
    fail "(o) the archived sessions were not restored into the directory"
  fi
  if [ -e "$N/ro/sessions/stale" ]; then
    fail "(o) a file the archive does not carry survived the restore"
  fi
  if [ "$(cat "$N"/snapshots-o/sessions.pre-restore-*/session-s1/marker 2>/dev/null || true)" != "november-live" ]; then
    fail "(o) the sessions snapshot is not under OPENWA_RESTORE_SNAPSHOT_DIR"
  fi
  pass "(o) a state dir under a read-only parent is emptied and refilled in place"
else
  echo "SKIP: (n) and (o) running as root, which ignores the permission bits these cases rely on"
fi

echo ""
echo "==> (p) a symlinked database target or data dir is snapshotted as a copy"
# cp -R copies a symlink as the link itself, and the restore then writes through that link, which
# would leave a snapshot showing the archive instead of the state it replaced.
P="$WORK/p"
mkdir -p "$P/src/data" "$P/real/data"
make_fixture "$P/src/data/main.sqlite" "papa-archive-main"
make_fixture "$P/src/data/openwa.sqlite" "papa-archive-data"
(
  cd "$P/src"
  BACKUP_DIR="$P/out" "$BACKUP" >/dev/null
)
ARCHIVE_P="$(ls "$P"/out/openwa-backup-*.tar.gz)"
make_fixture "$P/real/main.sqlite" "papa-live-main"
make_fixture "$P/real/data/openwa.sqlite" "papa-live-data"
ln -s "$P/real/main.sqlite" "$P/ext-main.sqlite"
ln -s "$P/real/data" "$P/live"
(
  cd "$P"
  MAIN_DATABASE_NAME="$P/ext-main.sqlite" DATABASE_NAME="$P/live/openwa.sqlite" OPENWA_DATA_DIR="$P/live" \
    "$RESTORE" "$ARCHIVE_P" --force >/dev/null
)
SNAPSHOT_P="$(ls -d "$P"/ext-main.sqlite.pre-restore-*)"
if [ -L "$SNAPSHOT_P" ]; then
  fail "(p) the snapshot of a symlinked database is a link to the file the restore overwrote"
fi
if [ "$(db_fingerprint "$SNAPSHOT_P")" != "papa-live-main" ]; then
  fail "(p) the snapshot does not hold the database the restore replaced"
fi
SNAPSHOT_P="$(ls -d "$P"/live.pre-restore-*)"
if [ -L "$SNAPSHOT_P" ]; then
  fail "(p) the snapshot of a symlinked data dir is a link to the directory the restore overwrote"
fi
if [ "$(db_fingerprint "$SNAPSHOT_P/openwa.sqlite")" != "papa-live-data" ]; then
  fail "(p) the data-dir snapshot does not hold the data store the restore replaced"
fi
if [ "$(db_fingerprint "$P/ext-main.sqlite")" != "papa-archive-main" ]; then
  fail "(p) the archived main DB was not restored"
fi
if [ "$(db_fingerprint "$P/live/openwa.sqlite")" != "papa-archive-data" ]; then
  fail "(p) the archived data store was not restored"
fi
pass "(p) a symlinked database target and data dir are snapshotted as copies"

echo ""
echo "All smoke tests passed!"
