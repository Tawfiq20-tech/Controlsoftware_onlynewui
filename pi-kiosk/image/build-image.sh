#!/usr/bin/env bash
# Builds a flashable Raspberry Pi image (.img.xz for Raspberry Pi Imager)
# with the sender pre-installed as a kiosk, using the official pi-gen tool.
#
# Needs a Linux machine (or WSL2 Ubuntu on Windows) with Docker installed.
# Takes 30-90 minutes the first time.
#
#   ./pi-kiosk/build-bundle.sh                  # makes dist-pi/*.tar.gz
#   ./pi-kiosk/image/build-image.sh             # makes dist-pi/*.img.xz
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$ROOT/pi-kiosk/image"
WORK="$ROOT/dist-pi/pi-gen"

BUNDLE="$(ls -t "$ROOT"/dist-pi/OnefinitySender-Raspi-arm64-V*.tar.gz 2>/dev/null | head -1 || true)"
[ -n "$BUNDLE" ] || { echo "no bundle in dist-pi/: run pi-kiosk/build-bundle.sh first" >&2; exit 1; }
command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }

if [ ! -d "$WORK/.git" ]; then
    # 64-bit builds live on pi-gen's "arm64" branch.
    git clone --depth 1 --branch arm64 https://github.com/RPi-Distro/pi-gen.git "$WORK" \
        || git clone --depth 1 https://github.com/RPi-Distro/pi-gen.git "$WORK"
fi

# Custom stage on top of stage2 (Raspberry Pi OS Lite).
rm -rf "$WORK/stage-onefinity"
cp -r "$HERE/stage-onefinity" "$WORK/stage-onefinity"
find "$WORK/stage-onefinity" -type f -exec sed -i 's/\r$//' {} +
mkdir -p "$WORK/stage-onefinity/00-onefinity/files"
cp "$BUNDLE" "$WORK/stage-onefinity/00-onefinity/files/bundle.tar.gz"
chmod +x "$WORK/stage-onefinity/prerun.sh" "$WORK/stage-onefinity/00-onefinity/00-run.sh"

# Stages 3-5 are the desktop; the kiosk does not want them.
for s in stage3 stage4 stage5; do touch "$WORK/$s/SKIP" "$WORK/$s/SKIP_IMAGES"; done
touch "$WORK/stage2/SKIP_IMAGES"

sed 's/\r$//' "$HERE/config" > "$WORK/config"
cd "$WORK"
./build-docker.sh

mkdir -p "$ROOT/dist-pi"
cp deploy/*.img.xz "$ROOT/dist-pi/" 2>/dev/null || cp deploy/*.zip "$ROOT/dist-pi/"
echo "Image written to $ROOT/dist-pi/ -- flash it with Raspberry Pi Imager (Use custom)."
