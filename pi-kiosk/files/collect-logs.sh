#!/usr/bin/env bash
# Collects everything needed to diagnose this machine into one file.
#
#   sudo onefinity-logs              -> writes to a plugged-in USB stick if there
#                                       is one, otherwise to /tmp
#   sudo onefinity-logs /some/dir    -> writes there instead
#
# The kiosk has no desktop and no terminal on the screen, so without this the
# only way to get logs off the machine is to know a dozen journalctl incantations
# over SSH. Hand the USB stick to whoever is helping instead.
#
# Secrets are removed on the way out: the operator token, Wi-Fi keys, and the
# bot/cloud/remote-diagnostics tokens in config.json. The file is meant to be
# emailed, so nothing in it should let someone drive the machine.
set -u

APP_DIR=/opt/onefinity-sender
STAMP="$(date +%Y%m%d-%H%M%S)"
NAME="onefinity-logs-$(hostname)-$STAMP"

pick_dest() {
    [ $# -gt 0 ] && { echo "$1"; return; }
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
grab power.txt cat /boot/firmware/config.txt
grab power.txt cat /boot/firmware/cmdline.txt

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

# Prove the secrets really are gone before this leaves the machine.
if grep -rqiE '(psk|password|token|secret)"?[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9/+_-]{12,}' "$OUT" 2>/dev/null; then
    say "WARNING: something secret-looking is still in the bundle; check before sending."
fi

ARCHIVE="$DEST/$NAME.tar.gz"
tar -C "$WORK" -czf "$ARCHIVE" "$NAME" 2>/dev/null
chmod a+r "$ARCHIVE" 2>/dev/null
sync

say ""
say "Written: $ARCHIVE"
say "Size:    $(du -h "$ARCHIVE" | cut -f1)"
case "$DEST" in
    /media/*) say "On the USB stick. Safe to unplug once this command has finished." ;;
    *)        say "Copy it off with:  scp $(whoami)@$(hostname -I | awk '{print $1}'):$ARCHIVE ." ;;
esac
