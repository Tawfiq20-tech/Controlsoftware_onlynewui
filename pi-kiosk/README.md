# Onefinity Sender on a Raspberry Pi (kiosk)

Makes a Raspberry Pi behave like the RTS-X Pi image: the Pi boots straight
into the sender, full screen, and nothing else can be opened. That means no
desktop, no terminal, no other apps, no browser address bar or tabs, and no
Ctrl+Alt+F1–F6 switching to other consoles.

Needs a Raspberry Pi 4 or 5 running **64-bit** Raspberry Pi OS Lite (Bookworm or
newer). A Pi 3 is too slow for the 3D view.

## Option A: install on a Pi (quickest)

1. On the PC, build the UI and pack the bundle:
   ```
   cd frontend && npm run build && cd ..
   bash pi-kiosk/build-bundle.sh
   ```
   This makes `dist-pi/OnefinitySender-Raspi-arm64-V<version>.tar.gz`.
2. Flash **Raspberry Pi OS Lite (64-bit)** with Raspberry Pi Imager. In its
   settings, set a user and Wi-Fi, and turn on SSH so you can copy the bundle.
3. Copy the bundle to the Pi, then run:
   ```
   tar -xzf OnefinitySender-Raspi-arm64-V*.tar.gz
   sudo bash OnefinitySender/pi-kiosk/install.sh      # add --keep-ssh to keep SSH
   sudo reboot
   ```
   The Pi needs internet during the install (Node.js, Chromium, npm packages).

To upgrade, run the same steps with a new bundle. The files in `backend/data`
stay as they are: machine config, library and resume point.

## Option B: build a flashable image for Raspberry Pi Imager

This needs Linux, or WSL2 Ubuntu on Windows, with Docker installed. First set
`FIRST_USER_PASS` in `pi-kiosk/image/config`, then run:

```
bash pi-kiosk/build-bundle.sh
bash pi-kiosk/image/build-image.sh
```

The result is `dist-pi/OnefinitySender-Raspi-arm64.img.xz`. In Raspberry Pi
Imager, choose **Use custom** and pick that file. Every card you flash boots
straight into the sender.

## What the installer does

| Piece | Where |
|---|---|
| App | `/opt/onefinity-sender`, run as the locked user `cnc` |
| Backend | `onefinity-backend.service` (node, port 4000, restarts if it stops) |
| Screen | `onefinity-kiosk.service` runs `cage` (a Wayland compositor that shows one app) with Chromium in `--kiosk` mode on tty1. If the browser is closed it starts again. |
| Browser lockdown | `/etc/chromium/policies/managed/onefinity-kiosk.json` allows only `localhost:4000`. DevTools, incognito, sign-in and printing are off. |
| Escape keys | No VT switching, no Ctrl+Alt+Del reboot, no SysRq, no login prompt on the screen |
| Boot | Quiet boot (no rainbow splash, no kernel text) |
| SSH | Off, unless you pass `--keep-ssh` |
| USB sticks | Mounted automatically at `/media/usb-sdX1` so you can pick G-code files from them |
| Serial / DFU | udev rules for ttyACM/ttyUSB and the STM32 DFU bootloader (0483:df11) |

Settings are in `/etc/onefinity-kiosk.conf`: the page URL, and screen rotation
for a portrait touch monitor (`KIOSK_ROTATE=90`).

## Servicing a locked Pi

- Re-run the installer with `--keep-ssh` from a keyboard session, or take the
  SD card out and create an empty file named `ssh` on the boot partition.
- Logs: `journalctl -u onefinity-backend -u onefinity-kiosk`.

## Not yet tested on hardware

These scripts have been syntax-checked, and the bundle builds, but no one has
run them on a Pi yet. Check these on the first Pi:
- `KIOSK_ROTATE` uses `wlr-randr`. Older `cage` builds may not accept it.
- The Library "Filefinity" button opens a new window that the policy blocks.
  On a touch-only screen there is no way to close that window, so hide that
  button in kiosk builds.
