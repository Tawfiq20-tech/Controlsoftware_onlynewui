#!/bin/bash -e
# Runs on the build host; on_chroot runs inside the arm64 image.

mkdir -p "${ROOTFS_DIR}/tmp/onefinity"
tar -xzf files/bundle.tar.gz -C "${ROOTFS_DIR}/tmp/onefinity"

on_chroot <<'EOF'
bash /tmp/onefinity/OnefinitySender/pi-kiosk/install.sh
rm -rf /tmp/onefinity
EOF
