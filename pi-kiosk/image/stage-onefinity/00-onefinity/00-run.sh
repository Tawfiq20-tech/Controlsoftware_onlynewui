#!/bin/bash -e
# Runs on the build host; on_chroot runs inside the arm64 image.
# Not /tmp: on_chroot mounts a fresh tmpfs over the image's /tmp, which
# hides anything unpacked there from the host side.

rm -rf "${ROOTFS_DIR}/opt/onefinity-build"
mkdir -p "${ROOTFS_DIR}/opt/onefinity-build"
tar -xzf files/bundle.tar.gz -C "${ROOTFS_DIR}/opt/onefinity-build"

on_chroot <<'EOF'
# --keep-ssh while the image is being tested on hardware.
bash /opt/onefinity-build/OnefinitySender/pi-kiosk/install.sh --keep-ssh
EOF

rm -rf "${ROOTFS_DIR}/opt/onefinity-build"
