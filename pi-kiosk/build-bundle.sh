#!/usr/bin/env bash
# Packs the sender for the Raspberry Pi, the same shape as the RTS-X Pi
# download (RTSX-Raspi-arm64-V<ver>.tar.gz):
#
#   dist-pi/OnefinitySender-Raspi-arm64-V<ver>.tar.gz
#     OnefinitySender/backend/        (no node_modules -- installed on the Pi for arm64)
#     OnefinitySender/frontend/dist/  (the built UI)
#     OnefinitySender/pi-kiosk/       (installer, services, lockdown)
#
# Runs in Git Bash on Windows, or on Linux/macOS. Build the UI first:
#   cd frontend && npm run build
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

[ -f frontend/dist/index.html ] || { echo "frontend/dist missing: run 'cd frontend && npm run build' first" >&2; exit 1; }

VERSION="$(node -p "require('./backend/package.json').version")"
NAME="OnefinitySender"
OUT_DIR="$ROOT/dist-pi"
STAGE="$OUT_DIR/stage/$NAME"
ARCHIVE="$OUT_DIR/$NAME-Raspi-arm64-V$VERSION.tar.gz"

rm -rf "$OUT_DIR/stage"
mkdir -p "$STAGE/frontend"

# Machine config and library go along; per-PC secrets, logs and job history do not.
tar -C "$ROOT" -cf - \
    --exclude='backend/node_modules' \
    --exclude='backend/logs' \
    --exclude='backend/tests' \
    --exclude='backend/data/*.jsonl' \
    --exclude='backend/data/remote-access.json' \
    --exclude='backend/data/rsp_resume_state.json' \
    --exclude='*.log' \
    backend pi-kiosk | tar -C "$STAGE" -xf -
cp -r frontend/dist "$STAGE/frontend/dist"

# Windows checkouts may carry CRLF; bash on the Pi refuses "#!/usr/bin/env bash\r".
find "$STAGE/pi-kiosk" -type f \( -name '*.sh' -o -name '*.service' -o -name '*.conf' -o -name '*.rules' -o -name '*.json' \) \
    -exec sed -i 's/\r$//' {} +

tar -C "$OUT_DIR/stage" --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' -czf "$ARCHIVE" "$NAME"
# tar drops the exec bit on Windows filesystems; the installer runs them with bash anyway.
rm -rf "$OUT_DIR/stage"

echo "Built $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
