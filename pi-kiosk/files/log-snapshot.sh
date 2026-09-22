#!/usr/bin/env bash
# Writes a short record of the LAST boot onto the SD card's boot partition,
# every time this one starts. Run by onefinity-logsnap.service.
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
OUT="$OUT_DIR/last-boot.txt"

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
    echo "--- devices seen now ---"
    lsusb 2>&1
} > "$OUT" 2>&1

chmod a+r "$OUT" 2>/dev/null
sync
exit 0
