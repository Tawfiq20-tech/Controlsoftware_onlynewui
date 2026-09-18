#!/usr/bin/env bash
# Started by onefinity-kiosk.service on tty1 as user "cnc".
# cage is a single-app Wayland compositor: one full-screen window, no
# desktop, no panels, and no Ctrl+Alt+F<n> console switching (cage only
# allows that with -s, which is deliberately not passed).
set -u

KIOSK_URL="${KIOSK_URL:-http://localhost:4000}"
KIOSK_ROTATE="${KIOSK_ROTATE:-normal}"

if [ "${1:-}" != "--inside-cage" ]; then
    # Wait for the backend so the screen never shows a "can't reach" page.
    for _ in $(seq 1 90); do
        curl -fs -o /dev/null "$KIOSK_URL" && break
        sleep 1
    done
    # A Pi 5 has two DRM cards: v3d (render only, no outputs) and vc4 (HDMI).
    # wlroots can pick v3d, find no screen and exit, leaving the display black.
    # Hand it only the cards that have connectors (cardN-HDMI-A-1 etc.).
    if [ -z "${WLR_DRM_DEVICES:-}" ]; then
        cards=""
        for c in /sys/class/drm/card[0-9]; do
            ls -d "$c"-* >/dev/null 2>&1 || continue
            cards="${cards:+$cards:}/dev/dri/$(basename "$c")"
        done
        [ -n "$cards" ] && export WLR_DRM_DEVICES="$cards"
    fi
    echo "onefinity-kiosk: WLR_DRM_DEVICES=${WLR_DRM_DEVICES:-auto}" >&2
    exec cage -d -- "$0" --inside-cage
fi

# ---- inside cage ------------------------------------------------------
if [ "$KIOSK_ROTATE" != "normal" ] && command -v wlr-randr >/dev/null; then
    for out in $(wlr-randr 2>/dev/null | awk '/^[^ ]/ {print $1}'); do
        wlr-randr --output "$out" --transform "$KIOSK_ROTATE" \
            || echo "onefinity-kiosk: could not rotate $out to $KIOSK_ROTATE" >&2
    done
fi

# ---- operator identity -------------------------------------------------
# Loopback alone only makes this browser "local": it can drive the machine, but
# not change machine settings (Wi-Fi, remote access, cloud). Proving it is the
# screen bolted to the machine needs the launch secret, handed over as ?op=<s>,
# which the page immediately trades for the operator cookie and strips from the
# address bar. Without this the kiosk's own Settings refuse it with 403 --
# Settings -> Wi-Fi could not scan, and remote access could not be set up.
TOKEN_FILE="${OPERATOR_TOKEN_FILE:-/opt/onefinity-sender/backend/data/operator-token}"
LAUNCH_URL="$KIOSK_URL"
for _ in $(seq 1 30); do
    [ -r "$TOKEN_FILE" ] && break
    sleep 1
done
if [ -r "$TOKEN_FILE" ]; then
    OP_SECRET="$(tr -d '[:space:]' < "$TOKEN_FILE" | tr '[:upper:]' '[:lower:]')"
    case "$OP_SECRET" in
        # The backend writes 64 hex characters; anything else is a truncated or
        # half-written file, and sending it would burn a failed-claim attempt.
        [0-9a-f]*)
            if [ ${#OP_SECRET} -eq 64 ]; then
                case "$KIOSK_URL" in
                    *\?*) LAUNCH_URL="$KIOSK_URL&op=$OP_SECRET" ;;
                    *)    LAUNCH_URL="$KIOSK_URL/?op=$OP_SECRET" ;;
                esac
            else
                echo "onefinity-kiosk: operator token is not 64 hex chars; starting without operator access" >&2
            fi
            ;;
        *) echo "onefinity-kiosk: operator token unreadable; starting without operator access" >&2 ;;
    esac
else
    echo "onefinity-kiosk: $TOKEN_FILE not readable; machine settings will be refused" >&2
fi

CHROMIUM="$(command -v chromium || command -v chromium-browser)"
PROFILE="$HOME/.config/onefinity-kiosk"
mkdir -p "$PROFILE/Default"
# After a power cut Chromium shows a "restore pages?" bar; mark the last
# session as a clean exit so it never appears.
PREFS="$PROFILE/Default/Preferences"
if [ -f "$PREFS" ]; then
    sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
fi

exec "$CHROMIUM" \
    --kiosk "$LAUNCH_URL" \
    --user-data-dir="$PROFILE" \
    --ozone-platform=wayland \
    --noerrdialogs \
    --disable-infobars \
    --no-first-run \
    --no-default-browser-check \
    --disable-session-crashed-bubble \
    --disable-features=Translate,TranslateUI,MediaRouter,DownloadBubble \
    --overscroll-history-navigation=0 \
    --disable-pinch \
    --password-store=basic \
    --check-for-update-interval=31536000 \
    --autoplay-policy=no-user-gesture-required
