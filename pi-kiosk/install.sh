#!/usr/bin/env bash
# Onefinity Sender -- Raspberry Pi kiosk installer.
#
# Turns a fresh Raspberry Pi OS Lite (64-bit, Bookworm or newer) into an
# appliance like the RTS-X Pi image: the Pi boots straight into the sender
# full-screen, and nothing else (desktop, terminal, other apps, browser UI)
# is reachable from the screen, keyboard or touch panel.
#
# Run from the unpacked bundle, as root:
#   sudo ./pi-kiosk/install.sh              # SSH is switched off
#   sudo ./pi-kiosk/install.sh --keep-ssh   # keep SSH for servicing
#
# Re-running it upgrades the app in place and keeps backend/data (machine
# config, library, resume point).
set -euo pipefail

APP_DIR=/opt/onefinity-sender
APP_USER=cnc
NODE_MAJOR=22
KEEP_SSH=0

for arg in "$@"; do
    case "$arg" in
        --keep-ssh) KEEP_SSH=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root: sudo $0"
[ "$(uname -m)" = "aarch64" ] || die "needs 64-bit Raspberry Pi OS (uname -m is $(uname -m), expected aarch64)"

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[ -f "$SRC_DIR/backend/index.js" ] || die "backend/index.js not found next to pi-kiosk/ -- run this from the unpacked bundle"
[ -f "$SRC_DIR/frontend/dist/index.html" ] || die "frontend/dist is missing -- build the bundle with pi-kiosk/build-bundle.sh"

BOOT_DIR=/boot/firmware
[ -f "$BOOT_DIR/cmdline.txt" ] || BOOT_DIR=/boot

# ---------------------------------------------------------------- packages
log "Installing system packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt "$NODE_MAJOR" ]; then
    apt-get install -y ca-certificates curl gnupg
    curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
    apt-get install -y nodejs
fi
# chromium is "chromium" on current Raspberry Pi OS, "chromium-browser" on older images.
CHROMIUM_PKG=chromium
apt-cache show chromium >/dev/null 2>&1 || CHROMIUM_PKG=chromium-browser
apt-get install -y --no-install-recommends \
    cage seatd wlr-randr "$CHROMIUM_PKG"fonts-dejavu-core fonts-noto-color-emoji \
    libudev-dev build-essential python3 curl rsync exfatprogs dosfstools

# -------------------------------------------------------------- user & app
log "Creating the kiosk user '$APP_USER'"
if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --create-home --shell /usr/sbin/nologin "$APP_USER"
fi
# serial port, camera, GPU, touch input, raw USB (firmware DFU)
for g in dialout video render input plugdev audio; do
    getent group "$g" >/dev/null && usermod -aG "$g" "$APP_USER"
done
passwd -l "$APP_USER" >/dev/null

log "Installing the app into $APP_DIR"
mkdir -p "$APP_DIR"
# backend/data is the machine's own state: never overwrite it on upgrade.
RSYNC_KEEP=()
[ -d "$APP_DIR/backend/data" ] && RSYNC_KEEP=(--exclude 'backend/data/')
rsync -a --delete "${RSYNC_KEEP[@]}" \
    --exclude 'backend/node_modules/' --exclude 'backend/logs/' \
    "$SRC_DIR/backend" "$SRC_DIR/frontend" "$SRC_DIR/pi-kiosk" "$APP_DIR/"
mkdir -p "$APP_DIR/backend/logs" "$APP_DIR/backend/data"
chown -R "$APP_USER:$APP_USER" "$APP_DIR"

log "Installing Node dependencies (arm64 native builds)"
# whatsapp-web.js pulls puppeteer, whose Chrome download has no arm64 build.
sudo -u "$APP_USER" -H env PUPPETEER_SKIP_DOWNLOAD=1 PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=1 \
    npm --prefix "$APP_DIR/backend" ci --omit=dev --no-audit --no-fund

# ------------------------------------------------------------ system files
log "Installing services, udev rules and browser lockdown"
F="$APP_DIR/pi-kiosk/files"
install -m 0755 "$F/kiosk-launch.sh"            /usr/local/bin/onefinity-kiosk
install -m 0644 "$F/onefinity-backend.service"  /etc/systemd/system/
install -m 0644 "$F/onefinity-kiosk.service"    /etc/systemd/system/
install -m 0644 "$F/99-onefinity.rules"         /etc/udev/rules.d/
install -m 0755 "$F/usb-automount.sh"           /usr/local/bin/onefinity-usb-mount
[ -f /etc/onefinity-kiosk.conf ] || install -m 0644 "$F/onefinity-kiosk.conf" /etc/onefinity-kiosk.conf
for d in /etc/chromium/policies/managed /etc/chromium-browser/policies/managed; do
    mkdir -p "$d"
    install -m 0644 "$F/chromium-policy.json" "$d/onefinity-kiosk.json"
done
udevadm control --reload-rules || true

# -------------------------------------------------------------- lockdown
log "Locking the Pi down to the sender only"
# No desktop, no login prompt on the screen, no switching to another console.
for dm in lightdm gdm3 sddm; do systemctl disable --now "$dm" 2>/dev/null || true; done
systemctl disable getty@tty1.service 2>/dev/null || true
mkdir -p /etc/systemd/logind.conf.d
cat > /etc/systemd/logind.conf.d/onefinity-kiosk.conf <<'EOF'
[Login]
NAutoVTs=0
ReserveVT=0
HandlePowerKey=poweroff
EOF
# Ctrl+Alt+Del must not reboot a machine mid-carve; no SysRq escape keys.
systemctl mask ctrl-alt-del.target
echo 'kernel.sysrq=0' > /etc/sysctl.d/90-onefinity-kiosk.conf
# Stop the first-boot user wizard from taking over tty1 on Pi OS images.
systemctl disable userconfig.service 2>/dev/null || true

if [ "$KEEP_SSH" -eq 1 ]; then
    echo "SSH left as it is (--keep-ssh)."
else
    systemctl disable --now ssh.service ssh.socket 2>/dev/null || true
    echo "SSH switched off. Re-run with --keep-ssh to keep it."
fi

# Silent boot: no rainbow screen, no kernel text, no blinking cursor.
if [ -f "$BOOT_DIR/cmdline.txt" ]; then
    CMDLINE="$(tr -d '\n' < "$BOOT_DIR/cmdline.txt")"
    for opt in quiet loglevel=3 logo.nologo vt.global_cursor_default=0 consoleblank=0; do
        case " $CMDLINE " in *" ${opt%%=*}"[=\ ]*) ;; *) CMDLINE="$CMDLINE $opt" ;; esac
    done
    printf '%s\n' "$CMDLINE" > "$BOOT_DIR/cmdline.txt"
fi
if [ -f "$BOOT_DIR/config.txt" ] && ! grep -q '^disable_splash=1' "$BOOT_DIR/config.txt"; then
    printf '\n# Onefinity kiosk\ndisable_splash=1\n' >> "$BOOT_DIR/config.txt"
fi

# ----------------------------------------------------------------- enable
# daemon-reload fails inside the image-builder chroot (no systemd running).
systemctl daemon-reload 2>/dev/null || true
systemctl set-default graphical.target
systemctl enable onefinity-backend.service onefinity-kiosk.service

log "Done. Reboot to start the kiosk: sudo reboot"
echo "Settings (screen rotation, URL): /etc/onefinity-kiosk.conf"
