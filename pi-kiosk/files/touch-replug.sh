#!/usr/bin/env bash
# Restarts the kiosk screen when the touchscreen comes back after dropping off.
#
# Plugging the controller in can make the touchscreen fall off USB for a
# moment and re-enumerate (both sit on the Pi's restricted USB power budget).
# The kernel and libinput pick the panel straight back up -- the touch rotation
# rule is applied again on "add" -- but Chromium on Wayland stops receiving
# touch once the seat has lost and regained its touch capability, so the panel
# stays dead until the browser restarts. The RTS-X image runs X11, where a
# re-plugged input device is simply picked up again; this gives our Wayland
# kiosk the same recovery.
#
# Restarting the screen does not touch a running job: the backend owns the job
# and the page reconnects to it, exactly as after a browser crash.
#
# Guarded so it can never loop: nothing happens during boot (the panel's first
# appearance is not a re-plug) and at most once every 20 s if the panel keeps
# flapping on a failing supply.
set -u

UNIT=onefinity-kiosk.service
STAMP=/run/onefinity-touch-replug.last
SETTLE_S=15
MIN_GAP_S=20

systemctl is-active --quiet "$UNIT" || exit 0

now=$(cut -d. -f1 /proc/uptime)

# Kiosk just started (or the system is still booting): this "add" is the
# panel's first appearance, which the fresh browser handles by itself.
active_us=$(systemctl show "$UNIT" -p ActiveEnterTimestampMonotonic --value 2>/dev/null || echo 0)
active_s=$(( ${active_us:-0} / 1000000 ))
[ $(( now - active_s )) -lt "$SETTLE_S" ] && exit 0

last=$(cat "$STAMP" 2>/dev/null || echo 0)
[ $(( now - last )) -lt "$MIN_GAP_S" ] && exit 0
echo "$now" > "$STAMP"

echo "onefinity-touch: touchscreen re-appeared; restarting the kiosk screen so touch works again" >&2
systemctl --no-block restart "$UNIT"
exit 0
