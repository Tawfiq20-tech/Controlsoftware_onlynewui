#!/bin/sh
# Called from udev (99-onefinity.rules). udev kills long-running RUN
# programs and forbids mounts from its own namespace, so the mount is
# handed to systemd-mount, which runs it as a proper transient unit.
ACTION="$1"
DEV="/dev/$2"
DIR="/media/usb-$2"

case "$ACTION" in
add)
    FSTYPE="$(blkid -o value -s TYPE "$DEV" 2>/dev/null)"
    OPTS="noexec,nosuid,nodev"
    case "$FSTYPE" in
        vfat|exfat|ntfs|ntfs3) OPTS="$OPTS,uid=cnc,gid=cnc,umask=022" ;;
    esac
    /usr/bin/systemd-mount --no-block --collect -o "$OPTS" "$DEV" "$DIR"
    ;;
remove)
    /usr/bin/systemd-umount "$DIR" 2>/dev/null || true
    ;;
esac
exit 0
