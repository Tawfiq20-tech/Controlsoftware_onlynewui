#!/usr/bin/env bash
# Writes two short records onto the SD card's boot partition:
#
#   last-boot.txt     what the PREVIOUS boot did, written once at startup
#   current-boot.txt  what THIS boot is doing, refreshed every few minutes
#
# Run by onefinity-logsnap.service at boot and onefinity-logsnap.timer after.
#
# The reason this exists: the faults on this machine -- a brownout reset, a USB
# over-current that kills the touchscreen -- take the machine down or make the
# screen unusable, which is exactly when nobody can run a command. After the
# reboot the evidence is in the PREVIOUS boot's journal, which is easy to lose.
# This captures it unattended, small enough to leave on a 512 MB FAT partition,
# and readable by putting the card in any PC.
set -u

BOOT_DIR=/boot/firmware
[ -d "$BOOT_DIR" ] || BOOT_DIR=/boot
OUT_DIR="$BOOT_DIR/onefinity-logs"
[ -w "$BOOT_DIR" ] || exit 0
mkdir -p "$OUT_DIR" 2>/dev/null || exit 0
# Bounds for the journal/dmesg scans below. Without -n, journalctl decompresses
# and scans the ENTIRE current-boot backend journal (install.sh sizes it at up
# to 200 MB persistent on the SD card) -- four times per run, every few minutes,
# for the life of the machine. That is the I/O storm that starved the serial
# stream mid-carve.
JOURNAL_LINES=${JOURNAL_LINES:-4000}
DMESG_LINES=${DMESG_LINES:-4000}

OUT="$OUT_DIR/last-boot.txt"
NOW="$OUT_DIR/current-boot.txt"

{
    echo "=== written $(date -Is) (boot $(cut -d. -f1 /proc/uptime)s ago) ==="
    echo
    echo "--- power right now (0x0 = healthy) ---"
    vcgencmd get_throttled 2>&1
    vcgencmd pmic_read_adc EXT5V_V 2>&1
    echo
    echo "--- why the machine last stopped ---"
    # Non-zero here after a reboot means it was not shut down cleanly.
    journalctl -b -1 -n 25 --no-pager 2>&1 | tail -25
    echo
    echo "--- errors from the previous boot ---"
    journalctl -b -1 -p err -n 60 --no-pager 2>&1
    echo
    echo "--- USB over-current / under-voltage, previous boot ---"
    journalctl -b -1 -k --no-pager 2>&1 | grep -iE "over-?current|under-?volt|usb .*(disconnect|reset)" | tail -40
    echo
    echo "--- USB over-current / under-voltage, this boot ---"
    dmesg -T 2>&1 | grep -iE "over-?current|under-?volt|usb .*(disconnect|reset)" | tail -40
    echo
    echo "--- the link to the controller: drops, timeouts, reconnects ---"
    # A controller that "disconnects on its own" does not always show up as a
    # USB event: the serial link can go quiet while the device stays plugged
    # in, and the sender then declares it lost. Both look identical from the
    # front, so capture the app's own view of it from this boot and the last.
    for b in 0 -1; do
        echo "  [boot $b]"
        journalctl -b "$b" -u onefinity-backend -n "$JOURNAL_LINES" --no-pager 2>/dev/null |
            grep -iE "link lost|link down|link restored|heartbeat|LinkLost|serialport:(close|error)|disconnect|reconnect|Controller initialized|port closed|ENOENT|EIO" |
            tail -40
    done
    echo

    echo "--- devices seen now ---"
    lsusb 2>&1
} > "$OUT" 2>&1

chmod a+r "$OUT" 2>/dev/null

# ---- what THIS boot is doing, refreshed while the machine runs -------------
#
# The faults being chased -- the controller dropping mid-job, the touchscreen
# going dead -- do NOT reboot the Pi. Their evidence is in the journal of the
# boot that is still running, which last-boot.txt (written at startup, about
# the previous boot) can never contain. Pull the card at any point and this
# file holds what has happened so far.
{
    echo "=== written $(date -Is), machine up $(cut -d. -f1 /proc/uptime)s ==="
    echo
    echo "--- power now (0x0 = healthy) ---"
    vcgencmd get_throttled 2>&1
    vcgencmd pmic_read_adc EXT5V_V 2>&1
    vcgencmd measure_temp 2>&1
    echo
    echo "--- the link to the controller, this boot ---"
    journalctl -b 0 -u onefinity-backend -n "$JOURNAL_LINES" --no-pager 2>/dev/null |
        grep -iE "link lost|link down|link restored|heartbeat|LinkLost|serialport:(close|error)|disconnect|reconnect|Controller initialized|port closed|ENOENT|EIO|alarm|E-?stop" |
        tail -60
    echo
    echo "--- job activity, this boot ---"
    journalctl -b 0 -u onefinity-backend -n "$JOURNAL_LINES" --no-pager 2>/dev/null |
        grep -iE "gcode:(load|start|stop|pause|resume)|sender:end|job:|superseded|compiled" |
        tail -40
    echo
    echo "--- backend errors and warnings, this boot ---"
    journalctl -b 0 -u onefinity-backend -p warning --no-pager 2>/dev/null | tail -40
    echo
    echo "--- USB events, this boot ---"
    dmesg -T 2>&1 | tail -n "$DMESG_LINES" | grep -iE "usb|over-?current|under-?volt|xhci" | tail -40
    echo
    echo "--- devices now ---"
    lsusb 2>&1
} > "$NOW" 2>&1
chmod a+r "$NOW" 2>/dev/null

# sync -f on this directory only. A bare `sync` flushes every dirty page on
# the system; running that every few minutes stalled I/O long enough for the
# serial loop to miss its heartbeat window and the sender to declare the link
# lost mid-carve -- manufacturing the exact fault this snapshot exists to
# diagnose.
sync -f "$OUT_DIR" 2>/dev/null || sync
exit 0
