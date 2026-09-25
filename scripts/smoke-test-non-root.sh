#!/bin/sh
# Smoke test: verify the built image runs its process as the openwa user (not root).
# Usage: ./scripts/smoke-test-non-root.sh
# Requires Docker to be running locally.
set -e

# The Dockerfile pins the builder to $BUILDPLATFORM (BuildKit-injected) for multi-arch correctness,
# so the build requires BuildKit. It's the modern default, but force it on in case the host disabled it.
export DOCKER_BUILDKIT=1

# CI already builds the image; set OPENWA_SMOKE_IMAGE to reuse that tag instead of paying for a
# second build. Unset (the local default) keeps the original behaviour: build here, remove after.
IMAGE_TAG="${OPENWA_SMOKE_IMAGE:-openwa-test-non-root:smoke}"
BUILT_HERE=0

if [ -z "${OPENWA_SMOKE_IMAGE:-}" ]; then
  BUILT_HERE=1
  echo "==> Building test image..."
  docker build -t "$IMAGE_TAG" .
else
  echo "==> Using pre-built image: $IMAGE_TAG"
fi

# Only remove an image this script created — never one the caller handed us.
cleanup() {
  if [ "$BUILT_HERE" -eq 1 ]; then
    docker rmi "$IMAGE_TAG" > /dev/null 2>&1 || true
  fi
}

echo ""
echo "==> Checking process user inside container..."
# Override CMD with 'id' so docker-entrypoint.sh runs: exec gosu openwa id
USER_OUTPUT=$(docker run --rm "$IMAGE_TAG" id)
echo "    $USER_OUTPUT"

if echo "$USER_OUTPUT" | grep -q "uid=0(root)"; then
  echo "FAIL: process is running as root!" >&2
  cleanup
  exit 1
fi

if echo "$USER_OUTPUT" | grep -q "openwa"; then
  echo "PASS: process runs as openwa (non-root)"
else
  echo "FAIL: process is not running as the openwa user" >&2
  cleanup
  exit 1
fi

echo ""
echo "==> Verifying dumb-init is PID 1..."
PID1=$(docker run --rm "$IMAGE_TAG" sh -c 'cat /proc/1/comm 2>/dev/null || ps -p 1 -o comm= 2>/dev/null || echo unknown')
echo "    PID 1: $PID1"
if echo "$PID1" | grep -q "dumb-init"; then
  echo "PASS: dumb-init is PID 1"
else
  # Without it as PID 1 nothing reaps Chromium's exited children or forwards signals past Node.
  echo "FAIL: PID 1 is '$PID1' (expected dumb-init), check the ENTRYPOINT chain" >&2
  cleanup
  exit 1
fi

cleanup
echo ""
echo "All smoke tests passed!"
