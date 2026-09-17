# Onefinity Control Software — Navigation Knowledge Base

This document describes the current UI of the CNC control software. It is written for the in-app assistant, to help operators find where to click for common tasks: connecting, loading files, running a job, jogging, homing, zeroing, probing, alarms, and settings.

Each section below is self-contained — safe to chunk independently for retrieval.

## Top-level navigation

The header has 6 tabs: **Prepare**, **Carve**, **Device**, **Project**, **Library**, **Settings**.

- **Prepare**: left Sidebar + 3D view, for setup before a run (file card with In Range / Exceeds Travel Limit, Simulate, legend).
- **Carve**: the same Sidebar + 3D view, plus the job control bar and the G-code line panel.
- **Device**: CNC Controller (connect), Joystick Control, Position (DRO), Firmware ($$ settings editor), Profiles.
- **Project**: Project History, a list of files loaded in this browser. Not where you load files, and not a record of runs.
- **Library**: Custom Library, FILEFINITY, Documentation (coming soon).
- **Settings**: General, Hardware, CNC and Activity groups.

While a job is running or paused, every tab except Carve is locked. The header also has the Home menu (house icon), the layout button (Auto / Horizontal / Vertical), the theme button, and the red **E-Stop**.

## How do I connect to my machine?

1. Go to the **Device** tab > **CNC Controller**.
2. Open the "Select a device..." dropdown and pick your controller's port.
3. Check **Baud Rate** (default 115200) and Flow Control.
4. Click **Connect**. The status changes to `Connecting...` then `Connected to ...`.

The app usually connects by itself to the controller you used last when it's plugged in. The header's Home menu Ethernet section only saves an IP address; there is no Ethernet connect button.

## How do I load / upload a G-code file?

- On Prepare or Carve, use **Sidebar > File Management** at the top.
- Drag the file onto the drop zone, click **Browse for G-Code File**, or press **Ctrl+O**.
- Accepted types: `.nc` `.gcode` `.txt` `.ngc` `.cnc` `.tap`, up to 50 MB.
- The file card shows name, size and line count. **Reload Current** loads the same file again and re-sends it to the machine; the X icon clears it.
- You can also load from **Library > Custom Library** with Load.

Files can't be loaded while a job is running or paused.

## How do I start / pause / stop a job?

- Open the **Carve** tab. The job control bar runs along the bottom of the 3D view (in the vertical layout it's the Job control card under the view). It appears once a file is loaded.
- Buttons from left: **Start/Pause** (play icon), progress readout, **Run Outline**, **Start From Line**, **Stop Job**, **E-STOP**.
- Keyboard: **Space** starts (when idle with a file loaded), pauses or resumes; **Escape** stops the job.

If a stopped job left a resume line, the bar shows "continues from line N" and Start picks up from there.

## Run Outline and Start From Line

- **Run Outline** traces the design's footprint with the tool raised to a safe height, without cutting, so you can check it fits on your material.
- **Start From Line** runs the file from a chosen line. The dialog shows the last stop line ("Use line N"), a Safe Z Height, and notes under "Before you start". Keep the existing zero unless the position was lost.

## Feed override, spindle and coolant

In **Sidebar > Controls**:

- **Coolant**: Mist (M7) / Flood (M8) / Stop (M9).
- **Spindle / Laser**: spindle direction, RPM and stop, or Laser mode with power, ON/OFF and a timed Test Fire. On RSP controllers these commands are refused and only log an error in the Console.
- **Speed (Feed Override)**: -10%, -1%, reset to 100%, +1%, +10% buttons, range 10–200%. There is no slider.

## How do I jog the machine (move it manually)?

- On Prepare, open **Sidebar > Jog**. Click the round dial (Y+ top, X+ right, Y- bottom, X- left, plus diagonals) and Z+ / Z− in the Z Axis column.
- Pick a step in the **Step (mm)** row: 0.1, 1, 10, 50 or 100, and a Speed.
- Keyboard: Arrow keys = X/Y, Page Up / Page Down = Z, keys 1–4 set the step to 0.1 / 1 / 10 / 100 mm.
- The Jog tab is locked while a job is running or paused.

## How do I home the machine?

- Open **Sidebar > Position** and click **HOME ALL**, or press the **Home** key while connected.
- The house icon in the header opens the Home menu (Machine Information, Device Info, Ethernet); it does not home the machine.
- On controllers that report homing progress, a "Homing in progress" window lists each axis and has an Abort button.

Homing is refused while a job is running or paused.

## How do I zero my work coordinates?

- Open **Sidebar > Position**. Click **ZERO ALL** to zero X, Y and Z at the current spot, or the crosshair icon ("Zero this axis") on one axis row.
- **Ctrl+Z** also zeros all axes.
- Zeroing only changes Work Position; Machine Position stays the same.
- The Zero All / Zero XY / Zero Z buttons on Device tab > Position (DRO) do nothing in this build; use the Sidebar.

## How do I probe (set my Z zero / find my work origin)?

Click the **Probe** button (crosshair icon) in the Sidebar's sub-tab row, between Jog and Controls. The Probing window has 3 steps:

1. **TYPE**: Z Probe or XYZ Probe (corner).
2. **JOG + BIT**: jog the bit near the plate or block, enter the bit diameter, click **Done**.
3. **PROBE**: connect the plate, click **Start Probing**. It shows "Probing…" with no cancel button; use E-Stop to abort.

- A **Z Probe** sets Z zero where the bit touches, which is the top of the plate (plate thickness is not subtracted). It ends with "Probing complete" and OK.
- An **XYZ Probe** ends with **Probe device removed — finalize zero** (remove the block first; the bit lowers to the real surface and zeroes X, Y and Z) or **Close without finalizing**.

## What do I do if the machine shows an alarm / is locked?

A popup covers the screen: "ALARM — Machine is locked." Fix the cause first, then use:

- **Clear Alarm**: clears the E-stop state and unlocks.
- **Clear Limit**: clears a limit error.
- **Reset Motors** (motor error only) and, under **Details**, per-motor **Reset X / Y1 / Y2 / Z**. Details also shows what tripped.

The status bar's ALARM badge Clear only unlocks. The Sidebar Position/Jog banners have Reset buttons that reset motors, and Reset All resets motors and unlocks.

## Where do I see the 3D toolpath?

The 3D view fills the main area on Prepare and Carve and shows the file automatically once it's loaded. Use the view toolbar's Toolpath toggle, Fit to part and Reset view if it looks empty or off-screen.

## Where is the camera view?

On Prepare and Carve, a **Camera** bar sits at the bottom of the left Sidebar. Click it to pop the live camera window up; a LIVE tag means the feed is streaming. Add, edit or remove cameras in **Settings > Hardware > Cameras**.

## What's in Settings?

Settings has a left-hand menu in four groups:

- **General**: Appearance, WhatsApp (WhatsApp and Telegram setup).
- **Hardware**: Cameras, Watch folder, Firmware (installed/latest version and updates), Remote access.
- **CNC**: Surfacing, Probing (probe strategy cards), Tools.
- **Activity**: Job history (the permanent record of runs).

Machine Profiles are on **Device tab > Profiles**, not in Settings.

## How do I control the machine from a phone or tablet?

On the computer running the app, open **Settings > Hardware > Remote access**, set a PIN of at least 4 characters under "Security & PIN Gate", then scan the QR code or use "Copy Connection Link". Open the link on the phone and enter the PIN. The phone must be on the same Wi-Fi unless worldwide internet access is turned on. PIN and worldwide-access changes only work on the machine's own computer.

## How do I surface my spoilboard?

Go to **Settings > CNC > Surfacing**, enter the area, bit, feed and depth, click **Generate G-code**, then **Load to Workspace**. Set X/Y zero at the chosen start corner and Z zero on the surface, then run it from the Carve tab.
