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

# Machine config and library go along; per-PC secrets, logs and job history do
# not. Anything left in here is burned into every image and is therefore
# identical on every machine flashed from it -- which is exactly wrong for an
# identity or a secret. All of these are regenerated on first boot.
tar -C "$ROOT" -cf - \
    --exclude='backend/node_modules' \
    --exclude='backend/logs' \
    --exclude='backend/tests' \
    --exclude='backend/data/*.jsonl' \
    --exclude='backend/data/remote-access.json' \
    --exclude='backend/data/rsp_resume_state.json' \
    --exclude='*.log' \
    `# This machine's cloud identity: shipping it would give every Pi the same one.` \
    --exclude='backend/data/device-identity.json' \
    --exclude='backend/data/device-identity.json.bak' \
    `# Kiosk operator secret: a shared one is a forgeable operator on every Pi.` \
    --exclude='backend/data/operator-token' \
    `# Files pulled down over the cloud link, and who was last connected.` \
    --exclude='backend/data/cloud-inbox' \
    --exclude='backend/data/cloud-link.json' \
    --exclude='backend/data/controller_last_seen.json' \
    `# A resume checkpoint drags the whole job's G-code along (5.6 MB in V0.1.0)` \
    `# and would make a freshly flashed Pi offer to resume a job it never ran.` \
    --exclude='backend/data/job_resume.json' \
    --exclude='backend/data/job_resume.json.bak' \
    --exclude='backend/data/job_resume_gcode.nc' \
    backend pi-kiosk | tar -C "$STAGE" -xf -
cp -r frontend/dist "$STAGE/frontend/dist"

# Windows checkouts may carry CRLF; bash on the Pi refuses "#!/usr/bin/env bash\r".
find "$STAGE/pi-kiosk" -type f \( -name '*.sh' -o -name '*.service' -o -name '*.conf' -o -name '*.rules' -o -name '*.json' \) \
    -exec sed -i 's/\r$//' {} +

tar -C "$OUT_DIR/stage" --owner=0 --group=0 --mode='u+rwX,go+rX,go-w' -czf "$ARCHIVE" "$NAME"
# tar drops the exec bit on Windows filesystems; the installer runs them with bash anyway.
rm -rf "$OUT_DIR/stage"

echo "Built $ARCHIVE ($(du -h "$ARCHIVE" | cut -f1))"
