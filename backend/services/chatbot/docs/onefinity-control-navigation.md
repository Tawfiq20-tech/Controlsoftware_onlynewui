# Onefinity Control Software — Navigation Knowledge Base

This document describes the real, current UI of the CNC control software (AXIO-ONEFINITY frontend). It is written for a RAG chatbot that helps users find where to click for common tasks: connecting, jogging, probing, loading G-code, running a job, homing, and settings.

Each section below is self-contained — safe to chunk independently for retrieval.

## Top-level navigation

The app has 6 tabs in the top header bar: **Prepare**, **Carve**, **Device**, **Project**, **Library**, **Settings**.

- **Prepare** and **Carve** both show the same layout: a left Sidebar + the 3D toolpath viewer in the main area. Carve is the tab you use while a job is actually running; Prepare is for jogging/probing/setup before a run.
- **Device** shows the connection panel (pick your USB port, connect/disconnect, live position readout, firmware info, machine profiles).
- **Project** shows your job history (previously run files) — not where you load a new file.
- **Library** shows the G-code library.
- **Settings** shows appearance, cameras, and machine configuration.

While a job is running or paused, all tabs except Carve are locked.

## How do I connect to my machine?

1. Go to the **Device** tab in the top header.
2. Under "CNC Controller", open the "Select a device..." dropdown and pick your machine's serial port.
3. Set **Baud Rate** if needed (default 115200; some controllers use 230400).
4. Click **Connect**. A status pill shows `Not Connected` / `Connecting...` / `Connected to X` / `Connection Error`.

If the machine was connected before, it will often auto-reconnect on its own the next time the app opens — no button needed.

## How do I jog the machine (move it manually)?

- Go to **Prepare** or **Carve**, then in the left Sidebar click the **Jog** sub-tab.
- Use the circular jog dial: X+/X−/Y+/Y− around the edge, Z+/Z− as separate buttons, and a center **STOP** button.
- Pick a step size first: 0.1 / 1 / 10 / 50 / 100 mm buttons, plus a speed preset.
- You can also jog with the keyboard: **Arrow keys** = X/Y, **Page Up / Page Down** = Z (hold for continuous movement). **Keys 1–4** switch step size (0.1/1/10/100mm).

## How do I probe (set my Z zero / find my work origin)?

In the Sidebar, click the **Probe** button (crosshair icon, between Jog and Controls). This opens a 3-step wizard:

1. **TYPE** — choose Z Probe (single-axis touch-off) or XYZ Probe (corner-block probing for X, Y, and Z together).
2. **JOG + BIT** — jog the bit near the probe/touch plate and enter your bit diameter.
3. **PROBE** — click Start, watch the live status, confirm OK when it finishes.

- **Z Probe** = lower the bit onto a touch plate to set Z=0.
- **XYZ Probe** = touch a corner block on 3 sides to set X=0, Y=0, and Z=0 together; there's a final "Finalize" step after you physically remove the probe.

## How do I load / upload a G-code file?

- In the Sidebar (Prepare or Carve tab), find the **File Management** section at the top.
- Either drag and drop your G-code file onto the drop zone, or click **"Browse for G-Code File"** to open a file picker.
- Accepted file types: `.nc` `.gcode` `.txt` `.ngc` `.cnc` `.tap`
- Once loaded, the file name, size, and line count are shown. A **"Reload Current"** button appears if you want to reset it.

> Note: the Project tab only shows history of files you've already run — it is not where you load a new file.

## How do I start / pause / stop a job?

- Press **Space** to start or pause/resume a running job.
- Press **Escape** to stop the job.

(There is no separate on-screen Start/Pause/Stop button panel currently active in this build — the keyboard shortcuts above are the reliable path today.)

Related controls, in the Sidebar's **Controls** sub-tab:

- **Coolant**: Mist / Flood / Stop (M7/M8/M9).
- **Spindle / Laser**: CW / CCW / Stop (M3/M4/M5), RPM slider, or Laser mode with power % and test-fire.
- **Feed rate override** slider.

## How do I home the machine?

- Click the **Home** icon/dropdown in the top header bar (next to the logo), or
- Go to **Sidebar → Position** sub-tab and click **HOME ALL** (or home a single axis from its row in the position table).

A full-screen overlay shows homing progress per axis (Z, then X, then Y) with an **Abort** button if needed.

## How do I zero my work coordinates?

- Go to **Sidebar → Position** sub-tab.
- Click **ZERO ALL** to zero all axes at the current position, or use the per-axis **Zero** button in each row of the position table.
- Keyboard shortcut: **Ctrl+Z** also zeros all axes.

## What do I do if the machine shows an alarm / is locked?

- A full-screen popup appears with **Clear Alarm** and **Clear Limit** buttons (and **Reset Motors** if it's a motor error). Use "Details" to see which axis/motor tripped.
- The bottom status bar also shows an **ALARM** badge with its own Clear button.
- The Sidebar's Position/Jog tabs show inline banners with per-motor Reset buttons too — use any of these, they do the same thing.

## Where do I see the 3D toolpath?

The 3D viewer is always shown in the main area whenever you're on the Prepare or Carve tab — it's not a separate toggle, it's the default view once a file is loaded.

## Where is the camera view?

A collapsible camera panel sits at the bottom of the left Sidebar (Prepare/Carve tabs). It shows a live read-only video feed from any camera you've configured. To add, edit, or remove a camera, go to **Settings → Cameras**.

## What's in Settings?

Go to the **Settings** tab. Sections (left sub-sidebar):

- **General**: Appearance (theme), notifications.
- **Hardware**: Cameras, Watch folder.
- **CNC**: Surfacing, Probing defaults, Tools.
- **Activity**: Job history.

Firmware info and Machine Profiles are **NOT** under Settings — they're their own tabs inside the **Device** panel instead.
