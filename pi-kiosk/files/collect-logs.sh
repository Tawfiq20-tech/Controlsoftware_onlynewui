#!/usr/bin/env bash
# Collects everything needed to diagnose this machine into one file.
#
#   sudo onefinity-logs              -> writes onto the SD card's boot partition
#   sudo onefinity-logs /some/dir    -> writes there instead
#
# The boot partition is the one place a Windows or Mac PC can read: it is FAT32,
# so pulling the SD card out and putting it in a card reader shows the file
# straight away. The rest of the card is ext4 and will not open there at all.
#
# The kiosk has no desktop and no terminal on the screen, so without this the
# only way to get logs off the machine is to know a dozen journalctl incantations
# over SSH. Pull the card instead and send the file on.
#
# Secrets are removed on the way out: the operator token, Wi-Fi keys, and the
# bot/cloud/remote-diagnostics tokens in config.json. The file is meant to be
# emailed, so nothing in it should let someone drive the machine.
set -u

APP_DIR=/opt/onefinity-sender
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="onefinity-logs-$(hostname)-$STAMP"

BOOT_DIR=/boot/firmware
[ -d "$BOOT_DIR" ] || BOOT_DIR=/boot

pick_dest() {
    # An explicit destination is checked. It used to be taken verbatim, so
    # "sudo onefinity-logs /mnt/stick" when the stick is really at
    # /media/usb-sda1 made tar fail into /dev/null and the operator was still
    # told the bundle had been written.
    if [ $# -gt 0 ]; then
        if [ ! -d "$1" ]; then say "Not a directory: $1"; exit 1; fi
        if [ ! -w "$1" ]; then say "Not writable: $1"; exit 1; fi
        echo "$1"; return
    fi
    # The SD card's FAT boot partition: readable in any PC's card reader.
    if [ -d "$BOOT_DIR" ] && [ -w "$BOOT_DIR" ]; then
        mkdir -p "$BOOT_DIR/onefinity-logs" 2>/dev/null &&
            { echo "$BOOT_DIR/onefinity-logs"; return; }
    fi
    # Then a USB stick, if one happens to be in.
    for m in /media/usb-*; do
        [ -d "$m" ] && [ -w "$m" ] && { echo "$m"; return; }
    done
    echo /tmp
}
DEST="$(pick_dest "$@")"
WORK="$(mktemp -d)"
OUT="$WORK/$NAME"
mkdir -p "$OUT"
trap 'rm -rf "$WORK"' EXIT

say() { printf '%s\n' "$*" >&2; }
grab() { # grab <file> <command...>
    local f="$1"; shift
    { echo "\$ $*"; "$@" 2>&1; echo; } >> "$OUT/$f"
}

say "Collecting logs..."

# ---- what this machine is -------------------------------------------------
grab system.txt date
grab system.txt uname -a
grab system.txt cat /etc/os-release
grab system.txt cat /proc/device-tree/model
grab system.txt uptime
grab system.txt df -h /
grab system.txt free -h
[ -r "$APP_DIR/backend/package.json" ] &&
    grab system.txt grep -m1 '"version"' "$APP_DIR/backend/package.json"

# ---- power: the Pi 5 brownout / USB current story -------------------------
grab power.txt vcgencmd get_throttled
grab power.txt vcgencmd pmic_read_adc EXT5V_V
grab power.txt vcgencmd measure_temp
grab power.txt rpi-eeprom-config
# $BOOT_DIR, not a hardcoded path: on a pre-Bookworm or re-imaged card the
# boot partition is at /boot, and this section then shipped two "No such file
# or directory" lines instead of the exact settings it exists to show.
grab power.txt cat "$BOOT_DIR/config.txt"
grab power.txt cat "$BOOT_DIR/cmdline.txt"

# ---- USB and input: over-current, re-enumeration, the touchscreen ----------
grab usb.txt lsusb
grab usb.txt lsusb -t
grab usb.txt ls -l /dev/ttyACM0 /dev/ttyUSB0 /dev/ttyACM1 /dev/ttyUSB1
grab usb.txt ls -l /dev/input/by-id/
grab usb.txt libinput list-devices
grab usb.txt cat /run/udev/rules.d/99-onefinity-touch.rules
grab usb.txt cat /etc/onefinity-kiosk.conf

# ---- kernel: USB resets, over-current, under-voltage -----------------------
grab dmesg.txt dmesg -T
grab dmesg-usb.txt sh -c "dmesg -T | grep -iE 'usb|over-?current|under-?volt|xhci|hwmon'"

# ---- the services ---------------------------------------------------------
grab journal-backend.txt journalctl -u onefinity-backend -b --no-pager -n 3000
grab journal-kiosk.txt   journalctl -u onefinity-kiosk   -b --no-pager -n 1500
# Previous boot too: a brownout reset leaves its evidence there, not here.
grab journal-prev-boot.txt journalctl -b -1 --no-pager -n 1500
grab journal-errors.txt journalctl -b -p err --no-pager -n 500

# ---- the app's own logs ----------------------------------------------------
if [ -d "$APP_DIR/backend/logs" ]; then
    mkdir -p "$OUT/app"
    for f in "$APP_DIR"/backend/logs/app*.log; do
        [ -f "$f" ] && tail -c 2000000 "$f" > "$OUT/app/$(basename "$f")"
    done
    # The two newest serial sessions: these carry the controller handshake.
    mkdir -p "$OUT/app/sessions"
    ls -1t "$APP_DIR"/backend/logs/sessions/*.ndjson 2>/dev/null | head -2 |
        while read -r s; do tail -c 2000000 "$s" > "$OUT/app/sessions/$(basename "$s")"; done
fi

# ---- config, with every secret taken out ----------------------------------
if [ -r "$APP_DIR/backend/data/config.json" ]; then
    sed -E 's/("([^"]*([Tt]oken|[Ss]ecret|[Pp]assword|[Aa]pi[Kk]ey|psk)[^"]*)"[[:space:]]*:[[:space:]]*)"[^"]*"/\1"[removed]"/g' \
        "$APP_DIR/backend/data/config.json" > "$OUT/config.redacted.json"
fi
# Network: names and signal only, never the pre-shared keys.
grab network.txt nmcli -t -f NAME,TYPE,DEVICE connection show
grab network.txt nmcli -t -f DEVICE,TYPE,STATE device status
grab network.txt ip -brief addr

# The operator launch secret travels as a URL query (?op=<hex>) or a cookie,
# neither of which the key:value check below matches. Strip it from every file
# before that check runs -- this bundle is emailed, and that secret is a
# permanent second factor for Wi-Fi, PIN, pairing and permission changes.
find "$OUT" -type f -print0 | while IFS= read -r -d '' f; do
    sed -i -E 's/([?&]op=)[0-9a-fA-F]{8,}/\1[removed]/g; s/(onefinity_op=)[A-Za-z0-9_-]{8,}/\1[removed]/g' "$f" 2>/dev/null || true
done

# Prove the secrets really are gone before this leaves the machine.
if grep -rqiE '(psk|password|token|secret)"?[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9/+_-]{12,}' "$OUT" 2>/dev/null \
   || grep -rqiE '[?&]op=[0-9a-fA-F]{16,}|onefinity_op=[A-Za-z0-9_-]{16,}' "$OUT" 2>/dev/null; then
    say "WARNING: something secret-looking is still in the bundle; check before sending."
fi

ARCHIVE="$DEST/$NAME.tar.gz"
# Errors used to go to /dev/null and the status was never checked, so a failed
# or truncated archive was announced as "Written:". On a machine with no screen
# and no terminal that means a second site visit.
if ! tar -C "$WORK" -czf "$ARCHIVE" "$NAME"; then
    say ""
    say "FAILED to write $ARCHIVE -- nothing was collected."
    say "The destination may be full or read-only. Try: sudo onefinity-logs /tmp"
    rm -f "$ARCHIVE"
    exit 1
fi
chmod a+r "$ARCHIVE" 2>/dev/null
sync

# The boot partition is small (512 MB) and shared with the firmware: never let
# these pile up there. AFTER a successful tar -- pruning first meant a failed
# run had already deleted the older bundles.
ls -1t "$DEST"/onefinity-logs-*.tar.gz 2>/dev/null | tail -n +3 | xargs -r rm -f

say ""
say "Written: $ARCHIVE"
say "Size:    $(du -h "$ARCHIVE" | cut -f1)"
case "$DEST" in
    /boot*)
        say ""
        say "It is on the SD card's boot partition. To fetch it: shut the Pi down"
        say "(sudo poweroff), put the card in a PC, and open the small drive that"
        say "appears -- the file is in the onefinity-logs folder."
        ;;
    /media/*) say "On the USB stick. Safe to unplug once this command has finished." ;;
    *)        say "Copy it off with:  scp $(whoami)@$(hostname -I | awk '{print $1}'):$ARCHIVE ." ;;
esac
