# ONEFINITY WEBSITE KNOWLEDGE BASE
### Comprehensive Operational, Navigation, & Safety Reference for AI RAG Chatbot

---

## Website Knowledge Metadata

* **Website Version**: `0.1.0` (`cnc-industrial-ui` / `onefinity-cnc-controller`)
* **Git Commit**: `2140fea7903a8c983e45fe671cfb1ae27610309e`
* **Repository Version**: `0.1.0`
* **Last Analyzed**: `2026-08-21`
* **Architecture**: Single Page Application (React 18.3.1 + TypeScript + Zustand 4.4.7 + Three.js 0.160 + Socket.IO 4.8.0) communicating with Express / Node.js backend (Port `4000`).

---

## 1. Project Overview & Layout

The **Onefinity CNC Web Application** (Axio-Onefinity / EasyCNC) is a browser-based machine control interface and G-code sender designed for Onefinity CNC machines and compatible motion controllers (`grblHAL`, `GRBL`, and `Buildbotics`/`RTS-1`/`RTS-2`).

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ 1. HEADER (Top Bar - Always Visible)                                                       │
│ [Onefinity Logo] [Home Dropdown ▾] [Prepare] [Carve] [Device] [Project] [Library] [Settings]│
│ [Status Pill: OFFLINE/IDLE/RUN/HOLD/ALARM] [Feed mm/min] [Spindle RPM] [FW Info] [E-Stop]   │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│ 2. SAFETY & ALARM BANNERS (Conditional Overlay / Below Header)                              │
│ • Motor Error / Alarm Recovery Bar (Reset Motors, Clear Limit, Clear Alarm)                │
│ • ECSS Safety Banners (Pre-flight Out of Bounds, Suspicious WCS, Z-Runaway Abort)           │
├───────────────────────────────┬─────────────────────────────────────────────────────────────┤
│ 3. SIDEBAR (Left Panel)       │ 4. VIEWPORT / MAIN WORKSPACE                                │
│ (Prepare & Carve tabs only)   │ • Prepare: 3D Visualizer + Simulation HUD                   │
│ • File Management (Upload/Drop)│ • Carve: Live 3D Execution View + Status + G-code Stream    │
│ • Sub-Tabs:                   │ • Device: Connection, DRO, Joystick, Firmware, Profiles     │
│   - Position (Work/Machine/A) │ • Project: Job Execution History & File Metadata           │
│   - Jog (Radial Dial + Z)     │ • Library: Custom Saved Files, FILEFINITY Link, Docs        │
│   - [Probe Launcher Button]   │ • Settings: Appearance, WhatsApp, Telegram, Cameras, etc.   │
│   - Controls (Coolant/Spindle)│                                                             │
│   - Macros (Create/Run)       │                                                             │
│   - Console (Terminal & Log)  │                                                             │
├───────────────────────────────┴─────────────────────────────────────────────────────────────┤
│ 5. STATUS BAR (Bottom Bar - Always Visible)                                                │
│ [● Connected/Disconnected] [STATE: IDLE/RUN/ALARM] [WCS: G54] [Units: mm] [Pos Readout]    │
│ [Alarm Clear Button] [Remote Diag Status] [Firmware Version] [⌨ Shortcuts Floating Button]  │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Navigation Map

```text
Prepare (Default Startup Workspace)
├── Sidebar (Left Panel)
│   ├── File Management [Browse for G-Code File | Reload Current | Clear File]
│   ├── Sub-Tab: Position [ZERO ALL | HOME ALL | DRO Rows X, Y, Z, A | Per-Axis Zero & Home]
│   ├── Sub-Tab: Jog [Radial 8-Direction Dial | Z+ / Z- | Step: 0.1, 1, 10, 100 mm | Speed: Slow, Med, Fast, Ultra | Coord System]
│   ├── [Probe Button] ──► Opens Probing Modal [Step 1: Type ➔ Step 2: Jog+Bit ➔ Step 3: Run]
│   ├── Sub-Tab: Controls [Coolant: Mist M7, Flood M8, Stop M9 | Spindle: CW M3, CCW M4, Stop M5 | Laser: ON, OFF, Test Fire]
│   ├── Sub-Tab: Macros [Add Macro | Run | Edit | Delete]
│   └── Sub-Tab: Console [Log Output | Manual Command Input Field | Send]
└── Viewport (Center 3D Canvas)
    ├── View Presets [ISO | Top | Front | Left | Right | Fit to Part | Reset View]
    ├── Visual Toggles [Grid | Envelope | Rapids | Progress | Toolhead | Axes]
    ├── Color-By Modes [Motion | Feed Heatmap | Depth Gradient]
    ├── File Info HUD [ETA | Line Count | Distance Cut/Rapid | Units | Tools]
    └── Simulate Bar [Simulate Play/Pause | Scrubber Slider | Speed 0.5x–14x | Camera Follow | Exit]

Carve (Live Execution Workspace)
├── Sidebar (Same sub-tabs as Prepare; Controls tab locked during active carve)
├── Top Carve Banner [File Name | Lines | Status Pill: RUN/HOLD/ALARM/IDLE | Progress Track | ETA]
├── Carve Action Bar [START | Pause | Stop | Current Executing G-code Line Ticker]
└── Right Panel: G-Code Stream [Live Line-by-Line Execution Tracker]

Device
├── Section: CNC Controller [Port Selector | Baud Rate | Flow Control | Connect / Disconnect | Device & Machine Cards]
├── Section: Joystick Control [Gamepad Connect | Left/Right Stick Deflection Bars | Start/Stop Control]
├── Section: Position (DRO) [WCS Dropdown G54–G59 | Work Pos | Machine Pos | Zero All | Zero XY | Zero Z]
├── Section: Firmware [EEPROM $$ Editor | Category Filter | Search | Inline Edit | Import / Export | Restore Defaults]
└── Section: Profiles [Built-in Profiles | Custom Profile Creation | Work Area | Feeds | Apply EEPROM Defaults]

Project
├── Project Stats [Total Projects | Completed Projects]
├── Project History Table [Name | File Name | Last Run | Status | Lines | Duration | Size]
└── Details Drawer [View Details | Run Again | Delete]

Library
├── Custom Library [Server-side files at backend/data/library/ | Add File | Load into Sender | Delete]
├── FILEFINITY [External Link: forum.onefinitycnc.com Community Files]
└── Documentation [External/Placeholder Link: Help guides]

Settings
├── General
│   ├── Appearance [Theme Picker: Carbon Orange (Dark) / Stack Overflow Light]
│   └── WhatsApp [Enable/Disable | Pairing QR | Recipients | Event Filters | Slash Bot Commands | Telegram Bot]
├── Hardware
│   ├── Cameras [Add Camera | MJPEG / RTSP / USB /dev/video* | Resolution | FPS | Live Stream View]
│   └── Watch folder [Enable Watcher | Folder Path | Extensions Filter | Detected File List]
├── CNC
│   ├── Surfacing [Spoilboard Flattening Generator: Dimensions | Bit Diameter | Stepover | Zigzag / Spiral | Generate ➔ Load]
│   ├── Probing [Built-in Probe Strategies | Active WCS Selector | Test Run]
│   └── Tools [Tool Library: Tool Number | Diameter | Flutes | Default Feeds/Speeds | Add / Edit / Delete]
└── Activity
    └── Job history [Audit Log: Total Runs | OK / Fail / Aborted Counts | Total Runtime | Clear All]

Home Menu (Top-Left Home Icon ▾)
├── Machine Information [Active Profile Dropdown | Voltage | Work Area]
├── Device Info [Port | Manufacturer | Vendor ID | Baud Rate]
└── Ethernet [Connect to IP Address | Touchscreen On-Screen Keyboard]
```

---

## 3. Detailed Page & Feature Reference

---

### Page: Prepare

* **Navigation Path**: `Prepare` (Header Tab)
* **Route**: `/` (Default view when `activeHeaderTab === 'Prepare'`)
* **Purpose**: Primary setup workspace for loading G-code, verifying toolpaths in 3D, jogging to origin, zeroing coordinates, running test simulations, and executing macros.
* **Source Traceability**:
  * Source File: `frontend/src/App.tsx:L79-L82`
  * Components: `Sidebar.tsx`, `Visualizer3D.tsx`, `ResizeHandle.tsx`
  * Confidence: `VERIFIED`

#### UI Elements & Sub-Sections:

#### 1. File Management
* **Navigation Path**: `Prepare → Sidebar → File Management`
* **Website Fact**: Provides file drop area and action buttons. Supports `.nc`, `.gcode`, `.txt`, `.ngc`, `.cnc`, `.tap` up to 50 MB.
* **UI Elements**:
  * `Browse for G-Code File` (Button): Opens file selector dialog.
  * `Reload Current` (Button): Re-reads active file from disk. Visible only when file is loaded.
  * `Clear File` (Button `X`): Unloads file and resets 3D toolpath.
* **Action Type**: `informational`
* **Confidence**: `VERIFIED` (`frontend/src/components/Sidebar.tsx:L345-L443`)

#### 2. Position Sub-Tab
* **Navigation Path**: `Prepare → Sidebar → Position`
* **Website Fact**: Displays real-time Work Position (`position.x/y/z`), Machine Position (`machinePosition.x/y/z`), and rotary 4th axis (`aAxis.work/machine` in `°`, rendered when `aAxis.connected === true`).
* **UI Elements**:
  * `ZERO ALL` (Button): Sets X, Y, Z work coordinates to `0.000` mm. Sends `backendZeroAll()` / `G10 L20 P0 X0 Y0 Z0`. Action Type: `machine_control`.
  * `HOME ALL` (Button): Triggers homing cycle overlay (`backendHome()`). Action Type: `safety_critical`.
  * `Axis Zero (X/Y/Z)` (Button Crosshair): Zeroes specific axis. Sends `G10 L20 P0 [Axis]0`. Action Type: `machine_control`.
  * `Axis Home (X/Y/Z)` (Button Home): Homes specific axis. Sends `backendHomeAxis(axis)`. Action Type: `safety_critical`.
* **Confidence**: `VERIFIED` (`frontend/src/components/Sidebar.tsx:L491-L593`)

#### 3. Jog Sub-Tab
* **Navigation Path**: `Prepare → Sidebar → Jog`
* **Website Fact**: Contains an 8-way radial dial and Z axis column.
* **UI Elements**:
  * `Radial Dial Slices`: `N (Y+)`, `NE (X+Y+)`, `E (X+)`, `SE (X+Y-)`, `S (Y-)`, `SW (X-Y-)`, `W (X-)`, `NW (X-Y+)`.
  * `Center STOP` (Octagon): Aborts jog motion.
  * `Z+ / Z-` (Buttons): Jogs Z axis vertically.
  * `Step Presets` (Buttons): `0.1`, `1`, `10`, `100` mm.
  * `Speed Presets` (Buttons): `Slow` (500 mm/min), `Medium` (2500 mm/min), `Fast` (5000 mm/min), `Ultra` (10000 mm/min).
  * `Coordinate System` (Buttons): `Z`, `XYZ`, `XY`, `X`, `Y`.
* **Action Type**: `machine_control`
* **Confidence**: `VERIFIED` (`frontend/src/components/Sidebar.tsx:L596-L774`)

#### 4. Controls Sub-Tab (Spindle, Laser, Coolant)
* **Navigation Path**: `Prepare → Sidebar → Controls`
* **Website Fact**: Hardware output toggles. Locked during active carving.
* **UI Elements**:
  * `Mist (M7)` (Button): Toggles mist coolant (`backendCoolantMist()`).
  * `Flood (M8)` (Button): Toggles flood coolant (`backendCoolantFlood()`).
  * `Stop Coolant (M9)` (Button): Shuts all coolant off (`backendCoolantOff()`).
  * `Spindle CW (M3)` / `CCW (M4)` / `Stop (M5)` (Buttons): Controls spindle direction and speed (`0` to `24000` RPM slider/input).
  * `Laser Mode` (Toggle): Prompts confirmation to stop spindle before switching.
  * `Laser ON (M3)` / `Laser OFF (M5)` / `Test Fire` (Buttons): Controls laser power (0%–100%) and pulse fire (50–5000 ms).
* **Action Type**: `safety_critical`
* **Confidence**: `VERIFIED` (`frontend/src/components/SpindleLaserControl.tsx`, `CoolantControl.tsx`)

#### 5. Macros Sub-Tab
* **Navigation Path**: `Prepare → Sidebar → Macros`
* **Website Fact**: Manage and execute multi-line G-code scripts.
* **UI Elements**:
  * `Add Macro` (Button): Opens creation form (Name, G-code textarea).
  * `Run Macro` (Button Play): Executes macro lines with a 100 ms stagger. Action Type: `machine_control`.
  * `Edit Macro` / `Delete Macro` (Buttons).
* **Confidence**: `VERIFIED` (`frontend/src/components/Sidebar.tsx:L801-L879`)

#### 6. Console Sub-Tab
* **Navigation Path**: `Prepare → Sidebar → Console`
* **Website Fact**: Live serial terminal logging controller messages with color coding (system, info, success, warning, error).
* **UI Elements**:
  * `Log Output Area`: Auto-scrolling message list.
  * `G-code Input`: Text field supporting manual command entry + Enter key (`sendBackendCommand()`).
* **Action Type**: `machine_control`
* **Confidence**: `VERIFIED` (`frontend/src/components/Sidebar.tsx:L882-L938`)

#### 7. 3D Visualizer Viewport (Prepare Mode)
* **Navigation Path**: `Prepare → Viewport`
* **Website Fact**: WebGL scene built on Three.js showing bed plane, travel envelope wireframe, rapid/feed/arc toolpaths, and cone toolhead.
* **UI Elements**:
  * `View Preset Buttons`: `iso`, `top`, `front`, `left`, `right`, `Fit to Part` (`Maximize2`), `Reset View` (`RotateCcw`).
  * `Visual Toggles`: `Grid` (Grid3x3), `Envelope` (Box), `Rapids` (Move3d), `Progress` (Layers), `Toolhead` (Crosshair), `Axes` (Eye/EyeOff).
  * `HUD Card`: Displays File name, ETA, Line progress, Cut distance, Rapid distance, Units, Tool numbers.
  * `Color-By Selector`: `motion` (rapids cyan/tan, cuts amber, arcs orange), `feed` (heatmap), `depth` (gradient).
  * `Simulate Button`: Activates timeline scrubber (`cursorSec`), playback speed (`0.5x` to `14x`), and `Camera Follow` toolhead tracking.
* **Action Type**: `informational`
* **Confidence**: `VERIFIED` (`frontend/src/components/Visualizer3D/Visualizer3D.tsx:L250-L875`)

---

### Page: Carve

* **Navigation Path**: `Carve` (Header Tab)
* **Route**: `/` (Active when `activeHeaderTab === 'Carve'`)
* **Purpose**: Dedicated real-time cutting screen. Displays live execution stats, start/pause/stop buttons, toolhead position tracking, and live scrolling G-code.
* **Source Traceability**:
  * Source File: `frontend/src/App.tsx:L84-L87`
  * Components: `Visualizer3D.tsx` (mode="carve"), `CarveBar`, `GcodePanel`
  * Confidence: `VERIFIED`

#### UI Elements:
1. **Top Carve Banner**:
   * Displays File name, Line count, State pill (`RUN` green, `HOLD` yellow, `ALARM` red, `IDLE` grey), Progress bar fill (`%`), and remaining ETA clock.
2. **Carve Action Bar (Bottom)**:
   * `START` (Green Button): Begins G-code stream (`fetch('/api/command', { command: 'start' })`). Action Type: `safety_critical`.
   * `Pause` (Yellow Button): Pauses stream (`fetch('/api/command', { command: 'pause' })`). Action Type: `safety_critical`.
   * `Stop` (Red Button): Aborts cutting job (`fetch('/api/command', { command: 'stop' })`). Action Type: `safety_critical`.
   * `Current Line Ticker`: Single-line display of active G-code command.
3. **G-Code Panel (Right Side Panel)**:
   * Resizable panel displaying all G-code lines. Lines are styled: `done` (completed), `current` (active executing line, auto-centered), and `upcoming`.
* **Confidence**: `VERIFIED` (`frontend/src/components/Visualizer3D/Visualizer3D.tsx:L899-L1023`)

---

### Page: Device Management

* **Navigation Path**: `Device` (Header Tab)
* **Route**: `/` (Active when `activeHeaderTab === 'Device'`)
* **Purpose**: Manages serial/Ethernet machine connections, gamepad controllers, Digital Readout (DRO), firmware EEPROM parameters, and machine profile presets.
* **Source Traceability**:
  * Source File: `frontend/src/components/DevicePanel.tsx`
  * Sub-components: `FirmwareSettings.tsx`, `MachineProfiles.tsx`, `JoystickManager.ts`
  * Confidence: `VERIFIED`

#### Sections & Elements:

#### 1. CNC Controller Section
* **Navigation Path**: `Device → CNC Controller`
* **UI Elements**:
  * `Select CNC Controller` (Dropdown): Lists serial ports returned by `requestBackendPorts()` (e.g. `CH340 Serial (COM3)`).
  * `Baud Rate` (Dropdown): `9600`, `19200`, `38400`, `57600`, `115200` (Default), `230400`, `250000`.
  * `Flow Control` (Dropdown): `None (GRBL/grblHAL)` or `RTS/CTS Hardware (RTS/Buildbotics)`.
  * `Connect / Disconnect` (Button): Connects via Socket.IO/REST.
  * `Device Info Card`: Displays Port, Manufacturer, Vendor ID, Baud Rate.
  * `Machine Info Card`: Displays Profile name, Voltage, Work area, Max feed, Spindle, Controller.
* **Action Type**: `informational` / `machine_control`
* **Confidence**: `VERIFIED` (`frontend/src/components/DevicePanel.tsx:L308-L599`)

#### 2. Joystick Control Section
* **Navigation Path**: `Device → Joystick Control`
* **UI Elements**:
  * `Connect Joystick` (Button): Attaches gamepad via HTML5 Gamepad API.
  * `Axis Deflection Bars`: Visual progress bars for Left X, Left Y, and Right Y (Z).
  * `Start Control / Stop Control` (Button): Enables analog jogging with deadband filtering and rate scaling. Action Type: `machine_control`.
  * `Disconnect Joystick` (Button).
* **Confidence**: `VERIFIED` (`frontend/src/components/DevicePanel.tsx:L702-L814`)

#### 3. Position (DRO) Section
* **Navigation Path**: `Device → Position (DRO)`
* **UI Elements**:
  * `WCS Selector` (Dropdown): Selects active WCS from `G54` to `G59`.
  * `Work Position Readout`: Displays X, Y, Z in mm (3 decimal places).
  * `Machine Position Readout`: Displays raw machine coordinates.
  * `Zero All` / `Zero XY` / `Zero Z` (Buttons): Zeroes corresponding work axes. Action Type: `machine_control`.
* **Confidence**: `VERIFIED` (`frontend/src/components/DevicePanel.tsx:L602-L685`)

#### 4. Firmware Section (EEPROM Editor)
* **Navigation Path**: `Device → Firmware`
* **UI Elements**:
  * `Read Settings` (Button): Sends `$$` to controller (`backendReadEEPROM()`).
  * `Category Filter`: `Motors`, `Limits`, `Homing`, `Spindle`, `Axes`, `Motion`, `Reporting`.
  * `Search Input`: Filters settings by ID, name, or description.
  * `Inline Value Editor`: Click any setting to edit value, click checkmark to write `$id=val`. Action Type: `safety_critical`.
  * `Export Settings` (Button): Downloads settings as JSON file.
  * `Import Settings` (Button): Loads settings JSON and writes batch to controller. Action Type: `safety_critical`.
  * `Restore Defaults` (Button): Restores factory defaults with confirmation modal. Action Type: `safety_critical`.
* **Confidence**: `VERIFIED` (`frontend/src/components/FirmwareSettings.tsx`)

#### 5. Profiles Section (Machine Profiles)
* **Navigation Path**: `Device → Profiles`
* **UI Elements**:
  * `Built-in Profiles`: Generic 3018, Shapeoko 3, X-Carve 750mm, OpenBuilds LEAD 1010, Onefinity Woodworker.
  * `Custom Profile Form`: Define Name, Work area, Max feed, Acceleration, Steps/mm, Max RPM.
  * `Apply EEPROM Defaults` (Button): Writes profile EEPROM values directly to controller. Action Type: `safety_critical`.
* **Confidence**: `VERIFIED` (`frontend/src/components/MachineProfiles.tsx`)

---

### Page: Project Panel

* **Navigation Path**: `Project` (Header Tab)
* **Route**: `/` (Active when `activeHeaderTab === 'Project'`)
* **Purpose**: Displays persistent local storage log (`cncProjects`) of all uploaded G-code files, execution dates, durations, line counts, and completion statuses.
* **Source Traceability**:
  * Source File: `frontend/src/components/ProjectPanel.tsx`
  * Confidence: `VERIFIED`

#### UI Elements:
* `Header Stats`: Total Projects, Completed count.
* `Project Table`: Lists projects with Name, File name, Last run timestamp, Status pill (`completed`, `failed`, `running`, `pending`), Lines, Duration, and Size.
* `Row Action Menu (⋮)`:
  * `Run Again`: Prepares project for re-running. Action Type: `informational`.
  * `View Details`: Opens side drawer with full execution timestamps.
  * `Delete`: Removes entry from `localStorage`.
* **Confidence**: `VERIFIED` (`frontend/src/components/ProjectPanel.tsx`)

---

### Page: Library

* **Navigation Path**: `Library` (Header Tab)
* **Route**: `/` (Active when `activeHeaderTab === 'Library'`)
* **Purpose**: Central portal for saved custom designs, community forum files, and documentation.
* **Source Traceability**:
  * Source File: `frontend/src/components/Library/Library.tsx`
  * Backend API: `/api/library` (`backend/services/library/LibraryService.js`)
  * Confidence: `VERIFIED`

#### Sub-Views & Cards:
1. **Custom Library**:
   * *Description*: Server-side file repository on disk (`backend/data/library/`).
   * *UI Elements*: `Add file` (uploads G-code to server), table of saved designs, `Load` button (fetches body, parses toolpath into visualizer and sender), `Delete` button (removes file from server).
   * *Action Type*: `informational` / `machine_control`
2. **FILEFINITY Card**:
   * *Description*: External link opening Onefinity Community Forum in a new browser tab (`https://forum.onefinitycnc.com/c/projects-files-and-tools/files-and-templates/9`).
3. **Documentation Card**:
   * *Description*: Placeholder card for official documentation site (currently links to `#`).
* **Confidence**: `VERIFIED` (`frontend/src/components/Library/Library.tsx`)

---

### Page: Settings

* **Navigation Path**: `Settings` (Header Tab)
* **Route**: `/` (Active when `activeHeaderTab === 'Settings'`)
* **Purpose**: System configuration grouped into General, Hardware, CNC, and Activity categories.
* **Source Traceability**:
  * Source File: `frontend/src/components/Settings/Settings.tsx`
  * Sub-components: `SectionAppearance.tsx`, `SectionNotifications.tsx`, `SectionWebcam.tsx`, `SectionWatchDir.tsx`, `SectionSurfacing.tsx`, `SectionProbing.tsx`, `SectionTools.tsx`, `SectionJobHistory.tsx`
  * Confidence: `VERIFIED`

#### Sub-Sections:

#### 1. Appearance
* **Navigation Path**: `Settings → General → Appearance`
* **UI Elements**:
  * Theme Cards: **Carbon Orange** (Dark navy `#0e1015`, orange accent `#f59e0b`) and **Stack Overflow Light** (Light `#f8f9f9`, grey `#f1f2f3`, orange accent `#f48024`).
  * Instant Theme Broadcasting: Dispatches `cnc:theme` event to re-color 3D Three.js canvas in place.
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionAppearance.tsx`)

#### 2. WhatsApp & Telegram Notifications
* **Navigation Path**: `Settings → General → WhatsApp`
* **UI Elements**:
  * `Enable / Disable` (Button): Initializes `whatsapp-web.js` over headless Chromium.
  * `Pairing QR Code`: Displayed until scanned by WhatsApp mobile app.
  * `Recipients List`: Add/remove E.164 phone numbers (e.g. `+1234567890`).
  * `Event Checkboxes`: Toggle alerts for `connected`, `disconnected`, `job:start`, `job:pause`, `job:resume`, `job:end`, `job:stop`, `job:error`, `alarm`, `emergency`.
  * `Throttling & Coordinates`: Set min interval between messages and toggle inclusion of X/Y/Z machine coordinates.
  * `Send Test Message` (Button).
  * `Bot Slash Commands`: When checked, authorized phones can send `/status`, `/jog X+10`, `/home`, `/start`, `/stop`, `/files`, `/load <name>`, `/upload` (with file), `/help`. Destructive commands require a "YES" reply within 30 s.
  * `Bot-Eye Webcam`: Attaches a snapshot image from selected camera after jog commands.
  * `Telegram Bot`: Configure Bot Token from `@BotFather`, add allowed chat IDs, and execute identical bot commands.
* **Action Type**: `informational` / `machine_control`
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionNotifications.tsx`)

#### 3. Cameras (Webcam)
* **Navigation Path**: `Settings → Hardware → Cameras`
* **UI Elements**:
  * `Add Camera` (Button): Configure Name, Type (`mjpeg-url`, `rtsp`, `v4l2`), URL or Device Path (`/dev/video0`), Resolution (`640x480`), FPS (`15`).
  * `Camera Cards`: Shows live streaming thumbnail, online/offline status, Edit, and Delete buttons.
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionWebcam.tsx`)

#### 4. Watch Folder
* **Navigation Path**: `Settings → Hardware → Watch folder`
* **UI Elements**:
  * `Enable folder watching` (Checkbox).
  * `Folder path` (Input): Local or network directory path.
  * `Extensions` (Input): Comma-separated list (`.nc, .gcode, .gc, .cnc, .tap, .ngc`).
  * `Detected Files List`: Displays matching G-code files found in the folder.
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionWatchDir.tsx`)

#### 5. Surfacing
* **Navigation Path**: `Settings → CNC → Surfacing`
* **UI Elements**:
  * Parameter Inputs: Area Width (X), Area Length (Y), Bit Diameter, Stepover % (1%–100%), Feed Rate, Spindle RPM, Safe Z Height, Max Depth, Depth Per Pass, Units (`mm`/`inch`).
  * `Cut Pattern`: `Zigzag` or `Spiral` (concentric rectangles).
  * `Start Position`: `Front-Left`, `Front-Right`, `Back-Left`, `Back-Right`, `Center`.
  * `Generate Toolpath` (Button): Validates inputs and generates G-code.
  * `Load to Workspace` (Button): Pushes toolpath directly to visualizer and feeder. Action Type: `machine_control`.
  * `Download G-code` (Button): Downloads `.gcode` file.
* **Confidence**: `VERIFIED` (`frontend/src/components/SurfacingTool.tsx`)

#### 6. Probing (Strategies)
* **Navigation Path**: `Settings → CNC → Probing`
* **UI Elements**:
  * `Active WCS Dropdown`: `G54` to `G59`.
  * `Strategy Cards`: Built-in strategies (`z-only`, `xyz-corner-front-left`). Clicking a card sends `POST /api/probing/run`.
  * `Last Run Status`: Displays success/error and coordinate updates.
* **Action Type**: `safety_critical`
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionProbing.tsx`)

#### 7. Tools (Tool Library)
* **Navigation Path**: `Settings → CNC → Tools`
* **UI Elements**:
  * `Tool Table`: Tool # (`T1`), Name, Diameter, Flutes, Material, Coating, Default Feed, Default Plunge, Default RPM, Default Stepdown, Default Stepover.
  * `Add Tool` / `Edit Tool` / `Delete Tool` (Buttons).
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionTools.tsx`)

#### 8. Job History
* **Navigation Path**: `Settings → Activity → Job history`
* **UI Elements**:
  * `Summary Stats`: Total runs, OK count, Fail count, Aborted count, Total runtime.
  * `Log Entries`: Lists filename, controller, line count, duration, exact timestamps, and error messages.
  * `Clear All` (Button): Wipes server-side history.
* **Confidence**: `VERIFIED` (`frontend/src/components/Settings/SectionJobHistory.tsx`)

---

### Modals & Dialogs Reference

---

#### 1. Probing Modal
* **Navigation Path**: Click `Probe` button in Sidebar sub-tab bar (or triggered by custom event `cnc:open-probing`).
* **Website Fact**: Full-screen 3-step wizard for touch plate zeroing.
* **Steps**:
  * **Step 1 (TYPE)**: Select **Z Probe** (Z height only) or **XYZ Probe** (3-axis corner touch).
  * **Step 2 (JOG + BIT)**: On-screen jog wheel (`Y+`, `Y-`, `X+`, `X-`, `Z+`, `Z-`, step `0.1`, `1`, `10`, `100` mm), live position readout, and **Bit Diameter** numeric input (`0.1` to `20` mm).
  * **Step 3 (PROBE)**: Displays routine summary and safety warning. Click **Start Probing** (`POST /api/probing/run`). Displays live probing spinner, success confirmation with WCS update, or error retry.
* **Action Type**: `safety_critical`
* **Confidence**: `VERIFIED` (`frontend/src/components/ProbingModal/ProbingModal.tsx`)

#### 2. Run Outline Dialog
* **Navigation Path**: Click `Run Outline` button (`Maximize2` icon) in Job Control Bar.
* **Website Fact**: Traces bounding envelope of loaded G-code at safe Z height with spindle off.
* **UI Elements**:
  * `Bounding Box Summary`: Displays Width (X), Height (Y), X range, Y range in mm.
  * `Outline Mode`: **Square** (rectangular perimeter) or **Detailed** (downsampled 200-point toolpath outline).
  * `Safe Z Height`: Lift height input (Default `10` mm).
  * `Feed Rate`: Travel speed input (Default `2000` mm/min).
  * `Run Outline` (Button): Streams outline G-code without starting spindle. Action Type: `machine_control`.
* **Confidence**: `VERIFIED` (`frontend/src/components/RunOutline.tsx`)

#### 3. Start From Line Dialog
* **Navigation Path**: Click `Start From Line` button (`SkipForward` icon) in Job Control Bar.
* **Website Fact**: Resumes an interrupted G-code program from a specific line number.
* **UI Elements**:
  * `Line Number Input`: Stepper buttons and slider (Range: `1` to total lines).
  * `Safe Z Height`: Lift height in machine coordinates (`G53 G0 Z...`).
  * `G-code Context Window`: Displays 5 preceding and 5 succeeding lines with the target line highlighted.
  * `Warnings Box`: Reminds operator to verify spindle speed, active WCS, and coolant state.
  * `Start from Line [N]` (Button): Automatically extracts modal states (units, plane, distance mode, WCS, coolant), builds safe preamble, and starts streaming from target line. Action Type: `safety_critical`.
* **Confidence**: `VERIFIED` (`frontend/src/components/StartFromLine.tsx`)

#### 4. Homing Sequence Overlay
* **Navigation Path**: Triggered by `HOME ALL` button or `Home` keyboard shortcut.
* **Website Fact**: Full-screen modal showing progressive axis homing sequence (`Z → X → Y`).
* **UI Elements**:
  * Step progression list: Displays active moving axis (`moving to limit...`), completed axes (`homed`), and failed axes (`TIMEOUT — check switch`).
  * `Abort` (Button): Transmits E-Stop command (`backendEstop()`) and closes overlay.
  * Watchdog: Auto-dismisses if 90 seconds of silence elapse.
* **Action Type**: `safety_critical`
* **Confidence**: `VERIFIED` (`frontend/src/components/HomingOverlay.tsx`)

---

## 4. UI State & Availability Rules

| Control / UI Element | State | Verified Condition in Code | Source File & Location |
|---|---|---|---|
| **START (Carve / Job)** | **Disabled** | `!connected \|\| gcode.length === 0 \|\| !fileLoadedBackend \|\| machineState === 'alarm' \|\| ecssBlocked` | `frontend/src/components/JobControlBar.tsx:L99-L104` |
| **START (Carve / Job)** | **Enabled** | `connected && gcode.length > 0 && fileLoadedBackend && machineState !== 'alarm' && (!safetyValidation?.blocked \|\| safetyValidation?.cleared \|\| safetyOverrideArmed)` | `frontend/src/components/JobControlBar.tsx:L99-L104` |
| **Pause (Carve / Job)** | **Enabled** | `connected && machineState === 'running'` | `frontend/src/components/JobControlBar.tsx:L44-L65` |
| **Stop (Carve / Job)** | **Enabled** | `connected && (jobActive \|\| machineState === 'paused')` | `frontend/src/components/JobControlBar.tsx:L105` |
| **Sidebar Controls Tab** | **Locked (🔒)** | `machineState === 'running' \|\| machineState === 'paused'` | `frontend/src/components/Sidebar.tsx:L65`, `L447-L450` |
| **Header Nav Tabs** | **Locked** | `(machineState === 'running' \|\| machineState === 'paused') && tab !== 'Carve'` | `frontend/src/components/Header.tsx:L76-L89` |
| **Radial Jog Dial** | **Locked** | `jobActive === true` (Displays tooltip: *"Jog disabled while a job is running"*) | `frontend/src/components/Sidebar.tsx:L635` |
| **DRO Zero Buttons** | **Disabled** | `!connected \|\| machineState !== 'idle'` | `frontend/src/components/DevicePanel.tsx:L654-L672` |
| **E-Stop (Header)** | **Disabled** | `!connected` | `frontend/src/components/Header.tsx:L127-L131` |
| **Simulate Bar** | **Hidden** | `mode !== 'prepare' \|\| !simulating \|\| !parsed \|\| parsed.durationSec <= 0` | `frontend/src/components/Visualizer3D/Visualizer3D.tsx:L256` |
| **Right G-Code Stream** | **Hidden** | `mode !== 'carve'` | `frontend/src/components/Visualizer3D/Visualizer3D.tsx:L881-L894` |
| **Rotary A-Axis DRO** | **Hidden** | `aAxis.connected === false` | `frontend/src/components/Sidebar.tsx:L571` |

---

## 5. Safety Systems & Error Reference

### 1. Safety Systems Breakdown

* **ECSS Module 1: Pre-Flight Toolpath Validator**:
  * *Trigger Condition*: G-code toolpath XYZ bounds exceed machine envelope dimensions in active WCS.
  * *Website Behavior*: Displays red safety banner (`ecss-banner--block`), logs offending lines and axes to console, and disables `START`.
  * *Override Action*: Operator can click `⚠️ Arm one-shot override`. This allows a single Start press while keeping real-time watchdogs active.
  * *Confidence*: `VERIFIED` (`frontend/src/components/SafetyBanner.tsx:L77-L113`, `cncStore.ts:L156-L165`)

* **ECSS Module 2: WCS Health Checker**:
  * *Trigger Condition*: Active G54 work coordinate offset exceeds `±50 mm`, indicating NVRAM drift or corrupt coordinates.
  * *Website Behavior*: Displays warning banner recommending homing and re-zeroing.
  * *Confidence*: `VERIFIED` (`frontend/src/components/SafetyBanner.tsx:L54-L75`)

* **ECSS Module 3: Z-Runaway Watchdog**:
  * *Trigger Condition*: Z axis drops faster than threshold window without controlled deceleration.
  * *Website Behavior*: Emits binary `0x03` abort on serial wire, halts stream, and displays critical alert banner (`ecss-banner--critical`). Auto-dismisses banner after 60 seconds.
  * *Confidence*: `VERIFIED` (`frontend/src/components/SafetyBanner.tsx:L36-L52`)

---

### 2. User-Visible Error Reference Table

```text
Error ID: ERR-ALARM-001
Exact Error Message: "ALARM — Machine is locked. Clear alarm to continue."
Category: Machine State
Page: Header / Status Bar
UI Location: Header Error Banner & Bottom Status Bar
Trigger Condition: Hard/soft limit switch tripped, probe collision, or E-Stop activated.
Meaning: Controller is in locked ALARM mode; all motion commands are rejected.
Recommended User Action: Inspect workspace, ensure limit switches are disengaged, and click "Clear Alarm" (sends $X).
Safety Level: safety_critical
Related Feature: Clear Alarm, E-Stop
Source File: frontend/src/components/Header.tsx:L161-L164
Source Function: Header()
Confidence: VERIFIED

Error ID: ERR-MOTOR-001
Exact Error Message: "MOTOR ERROR — Closed-loop position error detected. Check motor wiring."
Category: Hardware Error
Page: Header / Sidebar
UI Location: Top Alarm Banner & Sidebar Position Tab
Trigger Condition: Closed-loop stepper driver reports positioning error or stall.
Meaning: Physical motor position diverged from commanded position.
Recommended User Action: Check motor cables and physical obstructions, then click "Reset Motors" (or individual "Reset X", "Reset Y1", "Reset Y2", "Reset Z").
Safety Level: safety_critical
Related Feature: Reset Motors
Source File: frontend/src/components/Header.tsx:L161-L174
Source Function: Header()
Confidence: VERIFIED

Error ID: ERR-SAFETY-001
Exact Error Message: "Pre-flight BLOCKED — toolpath out of bounds."
Category: Safety Validation
Page: Global / Viewport Top
UI Location: Safety Banner Stack
Trigger Condition: G-code toolpath dimensions exceed configured machine envelope.
Meaning: Cutting this file would cause the machine to crash into physical axis limits.
Recommended User Action: Re-zero workpiece closer to center or edit CAM toolpath dimensions. If intentional, click "Arm one-shot override".
Safety Level: safety_critical
Related Feature: Pre-flight Validator, Arm Override
Source File: frontend/src/components/SafetyBanner.tsx:L81-L93
Source Function: SafetyBanner()
Confidence: VERIFIED

Error ID: ERR-SAFETY-002
Exact Error Message: "Z RUNAWAY ABORT — stream halted on safety."
Category: Safety Abort
Page: Global / Viewport Top
UI Location: Critical Safety Banner
Trigger Condition: Uncontrolled rapid Z plunge detected during streaming.
Meaning: Z-axis plunged abnormally; backend transmitted binary 0x03 abort.
Recommended User Action: Power-cycle machine, re-home all axes, and inspect G-code file before restarting.
Safety Level: safety_critical
Related Feature: Z-Runaway Watchdog, E-Stop
Source File: frontend/src/components/SafetyBanner.tsx:L38-L52
Source Function: SafetyBanner()
Confidence: VERIFIED

Error ID: ERR-FILE-001
Exact Error Message: "Invalid file type: [extension]. Supported formats: .nc, .gcode, .txt, .ngc, .cnc, .tap"
Category: File Validation
Page: Prepare
UI Location: Sidebar Console Log
Trigger Condition: User selected a file with an unsupported file extension.
Meaning: File format cannot be parsed as CNC G-code.
Recommended User Action: Export standard G-code from CAM software (Carveco, VCarve, Fusion 360).
Safety Level: informational
Related Feature: G-code Upload
Source File: frontend/src/components/Sidebar.tsx:L180-L186
Source Function: processFile()
Confidence: VERIFIED

Error ID: ERR-FILE-002
Exact Error Message: "File too large: [size]. Maximum size: 50MB"
Category: File Validation
Page: Prepare
UI Location: Sidebar Console Log
Trigger Condition: Selected file size exceeds 52,428,800 bytes (50 MB).
Meaning: File exceeds memory limits for browser parsing and streaming.
Recommended User Action: Reduce file size in CAM software or divide into separate toolpaths.
Safety Level: informational
Related Feature: G-code Upload
Source File: frontend/src/components/Sidebar.tsx:L189-L193
Source Function: processFile()
Confidence: VERIFIED

Error ID: ERR-CONN-001
Exact Error Message: "No serial ports found. Check USB connection and power."
Category: Connection
Page: Device
UI Location: CNC Controller Section Error Box
Trigger Condition: backend returned 0 serial ports during port scan.
Meaning: Computer cannot detect any connected CNC controllers.
Recommended User Action: Check USB cable connection, verify controller power, check drivers (CH340/FTDI), and click refresh icon.
Safety Level: informational
Related Feature: Serial Connection
Source File: frontend/src/components/DevicePanel.tsx:L100-L102
Source Function: loadPorts()
Confidence: VERIFIED
```

---

## 6. User Workflows

---

### Workflow: Uploading & Visualizing G-Code
* **User Action**: Click `Browse for G-Code File` in Sidebar (or drag-and-drop file, or press `Ctrl+O`).
* **Website Behavior**:
  1. Validates extension (`.nc`, `.gcode`, `.tap`, etc.) and size (max 50 MB).
  2. Parses toolpath lines and arc segments via `GCodeParser`.
  3. Updates Zustand store (`gcode`, `toolpathSegments`, `fileInfo`, `rawGcodeContent`).
  4. Automatically transmits file to backend feeder (`controller.loadFile()`).
  5. 3D canvas auto-fits camera bounding box to the workpiece with 1.4× padding.
* **Machine Behavior**: None (Machine remains stationary).
* **Confidence**: `VERIFIED` (`frontend/src/components/Sidebar.tsx:L178-L251`)

---

### Workflow: Setting Work Zero via Touch Plate Probing
* **User Action**:
  1. Place touch plate on workpiece surface and connect ground clip to tool.
  2. In Sidebar sub-tab bar, click `Probe`.
  3. Select `Z Probe` or `XYZ Probe`.
  4. Use jog buttons to position bit above plate, enter `Bit Diameter`, click `Done ➔`.
  5. Click `Start Probing`.
* **Website Behavior**: Sends `POST /api/probing/run` with selected strategy, bit diameter, and active WCS (`G54`). Shows live spinner until backend probe routine completes.
* **CNC Technical Knowledge / Machine Behavior**: Machine moves probe axis downward at fast seek rate (`fastFind`) until touch plate contact closes circuit, retracts slightly, touches off at slow feed rate (`slowFind`), and executes `G10 L20 P0` to set the coordinate offset based on plate thickness.
* **Safety Requirements**: Ensure ground magnet is attached to bit and touch plate is resting flat. In case of runaway, hit E-Stop.
* **Confidence**: `VERIFIED` (`frontend/src/components/ProbingModal/ProbingModal.tsx`)

---

### Workflow: Starting & Monitoring a Carve Job
* **User Action**: Navigate to `Carve` tab and click green `START` button (or press `Spacebar`).
* **Website Behavior**:
  1. Verifies pre-flight check, connection, and backend file load status.
  2. Sends start command (`POST /api/command` with `{ command: 'start' }`).
  3. Locks non-Carve header tabs and Sidebar Controls tab.
  4. Shifts 3D view to live tracking mode and streams G-code lines in right panel.
* **Machine Behavior**: Spindle spools up to programmed RPM, moves to initial cut coordinates, and executes G-code toolpath sequentially.
* **Safety Requirements**: Keep hands clear of spindle; wear eye and hearing protection. Operator must remain in attendance.
* **Confidence**: `VERIFIED` (`frontend/src/components/Visualizer3D/Visualizer3D.tsx:CarveBar`, `JobControlBar.tsx`)

---

### Workflow: Resuming Cut with "Start From Line"
* **User Action**:
  1. Click `Start From Line` (`SkipForward` icon) in Job Control Bar.
  2. Enter target line number and Safe Z Height (e.g. `10` mm).
  3. Click `Start from Line [N]`.
* **Website Behavior**:
  1. Scans preceding G-code lines to extract modal states (units `G20/G21`, plane `G17/G18/G19`, distance `G90/G91`, feed `G93/G94`, active WCS `G54-G59`, coolant `M7/M8/M9`).
  2. Builds safe preamble with machine-coordinate lift (`G53 G0 Z...`) and modal state commands.
  3. Prepends preamble to remaining G-code lines, sends to feeder, and starts execution.
* **CNC Technical Knowledge / Machine Behavior**: Spindle lifts to safe clearance height in absolute machine coordinates, restores tool speed and coolant, travels to target XY position, and descends to resume cutting.
* **Safety Requirements**: Verify active tool diameter and WCS zero point before resuming.
* **Confidence**: `VERIFIED` (`frontend/src/components/StartFromLine.tsx`)

---

## 7. Conflicting, Deprecated, & Unused UI Analysis

| Component / Feature | Active Implementation | Deprecated / Unused Variant | Status | Resolution in Codebase |
|---|---|---|---|---|
| **Probing Entry Points** | `ProbingModal.tsx` (Launched via Sidebar `Probe` button) | `ProbeWizard.tsx` (In-sidebar multi-step wizard) | `DEPRECATED` | Multi-step sidebar wizard replaced by `ProbingModal` per developer notes (msg 7350/7375). `ProbingModal` is the single active entry point. |
| **Gamepad Configuration** | `DevicePanel.tsx ➔ Joystick Control` | `Settings ➔ SectionGamepad.tsx` | `DEPRECATED` | `SectionGamepad` was removed from Settings tabs array (`GROUPS` in `Settings.tsx:L50`) to eliminate duplication with `DevicePanel ➔ Joystick`. |
| **Documentation Link** | `Library.tsx` (Documentation Card) | External URL | `UNKNOWN / INCOMPLETE` | Card displays *"Coming soon"* and links to `#` placeholder. |
| **FILEFINITY Card** | `Library.tsx` | Community Forum External URL | `ACTIVE` | Opens `https://forum.onefinitycnc.com/...` in a new browser tab. |
| **E-Stop Protocol** | Binary frame `0x03` (`backendEstop()`) | ASCII `!` / `Ctrl+X` | `ACTIVE` | Binary `0x03` implemented to support RTS-1/RTS-2 controller architectures alongside GRBL. |

---

## 8. RAG Knowledge Records (Expanded Ingestion Model)

```yaml
- Knowledge ID: UI-GCODE-001
  Source Type: website
  Content Type: ui_element
  Category: G-code Operations
  Page: Prepare
  Route: / (activeHeaderTab === 'Prepare')
  Feature: G-code Upload
  UI Element: Browse for G-Code File (Button & Drop Zone)
  Navigation Path: Prepare → Sidebar → File Management → Browse for G-Code File
  User Intent: Upload and load a G-code CNC file into the visualizer and sender.
  Question Examples:
    - Where do I upload my G-code?
    - How do I open a G-code file?
    - Where is the G-code upload button?
    - Can I drag and drop my CNC file?
    - How do I load a .nc or .tap file?
  Answer: Go to the Prepare tab. At the top of the left Sidebar under 'File Management', click 'Browse for G-Code File' (or press Ctrl+O). You can also drag and drop any supported G-code file (.nc, .gcode, .txt, .ngc, .cnc, .tap up to 50 MB) directly into the dashed drop zone.
  Prerequisites: File must have a valid extension (.nc, .gcode, .txt, .ngc, .cnc, .tap) and be under 50 MB.
  Expected Result: File parses into lines and toolpath segments, 3D toolpath renders in viewport, metadata displays in HUD card, and file is sent to backend streamer.
  Failure Conditions: File extension invalid or file size exceeds 50 MB (logs error to Console).
  Related Features: G-code Simulation, Live Carve, Start Job, Project History
  Action Type: informational
  Confidence: VERIFIED
  Source File: frontend/src/components/Sidebar.tsx
  Source Component: Sidebar
  Source Function: processFile()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-JOB-001
  Source Type: website
  Content Type: ui_element
  Category: Job Execution
  Page: Carve
  Route: / (activeHeaderTab === 'Carve')
  Feature: Start Job
  UI Element: START Button
  Navigation Path: Carve → Carve Action Bar → START
  User Intent: Begin carving the loaded G-code program on the CNC machine.
  Question Examples:
    - How do I start a job?
    - Where is the start button?
    - Why is the start button disabled?
    - How do I begin carving?
    - What button starts cutting?
  Answer: Open the Carve tab and click the green START button in the bottom action bar (or press Spacebar). If START is disabled, verify: (1) Machine is connected, (2) G-code file is loaded on frontend and backend, (3) Machine is not in ALARM, and (4) Toolpath is not blocked by ECSS pre-flight limits.
  Prerequisites: Machine connected, G-code loaded, fileLoadedBackend true, machineState not 'alarm', pre-flight check passed or overridden.
  Expected Result: Controller starts spindle and begins streaming G-code lines; UI switches to active execution mode.
  Failure Conditions: Controller disconnected, file missing, alarm active, or out-of-bounds pre-flight block.
  Related Features: Pause Job, Stop Job, Start From Line, Safety Banner Override
  Action Type: safety_critical
  Confidence: VERIFIED
  Source File: frontend/src/components/Visualizer3D/Visualizer3D.tsx
  Source Component: CarveBar
  Source Function: sendJob('start')
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-JOG-001
  Source Type: website
  Content Type: ui_element
  Category: Machine Control
  Page: Prepare
  Route: / (activeHeaderTab === 'Prepare')
  Feature: Manual Jogging
  UI Element: 8-Direction Radial Dial & Z Column
  Navigation Path: Prepare → Sidebar → Jog
  User Intent: Manually position the CNC spindle along X, Y, and Z axes.
  Question Examples:
    - Where is the jog control?
    - How do I move the machine manually?
    - How do I jog the X, Y, or Z axis?
    - Where do I change jog speed or step size?
    - How do I move diagonally?
  Answer: In the left Sidebar, click the 'Jog' sub-tab. Click any of the 8 slices on the circular dial to jog X/Y in cardinal or diagonal directions, or click Z+/Z- to move vertically. Select step increments (0.1, 1, 10, 100 mm) and speed presets (Slow, Medium, Fast, Ultra) below the dial, or use keyboard arrow keys and PageUp/PageDown.
  Prerequisites: Machine connected and not actively carving a job.
  Expected Result: Machine jogs by the selected step distance at the specified feed rate.
  Failure Conditions: Disabled while a job is running (displays lock overlay).
  Related Features: Continuous Keyboard Jog, Gamepad Jogging, Work Zeroing
  Action Type: machine_control
  Confidence: VERIFIED
  Source File: frontend/src/components/Sidebar.tsx
  Source Component: Sidebar
  Source Function: handleJog(), handleDiagonalJog()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-PROBE-001
  Source Type: website
  Content Type: feature
  Category: Probing & Zeroing
  Page: Prepare / Probing Modal
  Route: / (Modal overlay)
  Feature: Touch Plate Probing Wizard
  UI Element: Probe Button (Sidebar Tab Bar)
  Navigation Path: Prepare → Sidebar → [Probe Button]
  User Intent: Probe workpiece surface or corner to set Work Coordinate zero automatically.
  Question Examples:
    - Where are the probing settings?
    - How do I probe my Z zero?
    - Where is the XYZ probe wizard?
    - How do I touch off with my probe block?
    - Where do I enter bit diameter for probing?
  Answer: Click the 'Probe' button located in the Sidebar sub-tab bar (between Jog and Controls). In the modal: (1) Select Z Probe or XYZ Probe, (2) Jog bit 5–10 mm above the plate and enter your Bit Diameter, (3) Click 'Start Probing'. The machine touches off, updates the active WCS zero, and displays confirmation.
  Prerequisites: Machine connected, touch plate placed on workpiece, ground clip attached to bit.
  Expected Result: Machine probes touch plate, calculates tool offset, and sets active WCS zero (G10 L20 P0).
  Failure Conditions: Probe fails to make electrical contact within seek depth (returns error state with retry button).
  Related Features: Work Zeroing, WCS Selection, Settings Probing Strategies
  Action Type: safety_critical
  Confidence: VERIFIED
  Source File: frontend/src/components/ProbingModal/ProbingModal.tsx
  Source Component: ProbingModal
  Source Function: startProbe()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-ZERO-001
  Source Type: website
  Content Type: ui_element
  Category: Work Coordinates
  Page: Prepare
  Route: / (activeHeaderTab === 'Prepare')
  Feature: Work Zeroing
  UI Element: ZERO ALL Button & Axis Crosshairs
  Navigation Path: Prepare → Sidebar → Position → ZERO ALL
  User Intent: Set work coordinate origin (0, 0, 0) at current tool position.
  Question Examples:
    - How do I zero my machine?
    - Where is the Zero All button?
    - How do I zero only the Z axis?
    - How do I set X and Y to zero?
  Answer: Open the 'Position' sub-tab in the left Sidebar. Click 'ZERO ALL' (or press Ctrl+Z) to set X, Y, and Z to 0.000 mm in the active coordinate system. To zero an individual axis, click the crosshair button next to that specific axis row.
  Prerequisites: Machine connected and idle.
  Expected Result: Active work position updates to 0.000 mm; G10 L20 command sent to controller.
  Failure Conditions: Disabled when disconnected or actively carving.
  Related Features: Probing Modal, DRO Readout, WCS Selection
  Action Type: machine_control
  Confidence: VERIFIED
  Source File: frontend/src/components/Sidebar.tsx
  Source Component: Sidebar
  Source Function: handleZeroAll(), handleZero()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-SURF-001
  Source Type: website
  Content Type: feature
  Category: CNC Utilities
  Page: Settings
  Route: / (activeHeaderTab === 'Settings')
  Feature: Spoilboard Surfacing Generator
  UI Element: Surfacing Tool Form & Action Buttons
  Navigation Path: Settings → CNC → Surfacing
  User Intent: Generate and run a toolpath to flatten spoilboard or rough lumber stock.
  Question Examples:
    - Where is the surfacing tool?
    - How do I flatten my spoilboard?
    - How do I generate a surfacing file?
    - Where can I create a surfacing program?
  Answer: Navigate to Settings → Surfacing (under the CNC category). Enter your board Width, Length, Bit Diameter, Stepover percentage, Feed Rate, RPM, and Max Depth. Select Zigzag or Spiral pattern, click 'Generate Toolpath', and then click 'Load to Workspace' to send it directly to the 3D visualizer and sender.
  Prerequisites: Valid numerical dimensions entered (width > 0, length > 0, bit diameter > 0).
  Expected Result: G-code generated and loaded into the active session with toolpath visual preview.
  Failure Conditions: Input validation failure (displays error list if bit diameter > dimensions or feeds <= 0).
  Related Features: G-code Visualizer, Start Job, Tool Library
  Action Type: machine_control
  Confidence: VERIFIED
  Source File: frontend/src/components/SurfacingTool.tsx
  Source Component: SurfacingTool
  Source Function: handleGenerate(), handleLoadToWorkspace()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-FIRM-001
  Source Type: website
  Content Type: feature
  Category: Machine Configuration
  Page: Device
  Route: / (activeHeaderTab === 'Device')
  Feature: Firmware Settings / EEPROM Editor
  UI Element: EEPROM Table & Inline Edit
  Navigation Path: Device → Firmware
  User Intent: Read, search, edit, backup, and restore GRBL/grblHAL $$ configuration parameters.
  Question Examples:
    - Where can I change GRBL settings?
    - How do I edit EEPROM parameters?
    - Where is the $$ settings editor?
    - How do I change steps per mm ($100)?
    - How do I backup my machine settings?
  Answer: Click the Device tab in the top header and select 'Firmware'. Click 'Read Settings' to load all $$ values from the controller. You can filter by category (Motors, Limits, Homing, Axes) or search by keyword. Click on any value to edit it inline and click the checkmark to write $id=value to EEPROM. Use 'Export Settings' to save a JSON backup.
  Prerequisites: Machine connected via serial port.
  Expected Result: Settings read from/written to controller EEPROM.
  Failure Conditions: Controller not connected or communication timeout.
  Related Features: Machine Profiles, Port Connection
  Action Type: safety_critical
  Confidence: VERIFIED
  Source File: frontend/src/components/FirmwareSettings.tsx
  Source Component: FirmwareSettings
  Source Function: readSettings(), saveEdit()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-ALARM-001
  Source Type: website
  Content Type: error
  Category: Safety & Diagnostics
  Page: Header / Status Bar
  Feature: Alarm & Motor Error Recovery
  UI Element: Clear Alarm & Reset Motors Buttons
  Navigation Path: Header → Alarm Banner → Clear Alarm / Reset Motors
  User Intent: Unlock the CNC controller after a limit switch trip, motor stall, or E-Stop.
  Question Examples:
    - Why is the machine in ALARM state?
    - How do I clear an alarm?
    - What does Motor Error mean?
    - How do I unlock my CNC?
    - What is the Clear Limit button for?
  Answer: An ALARM state occurs when a limit switch trips, a soft limit is hit, or E-Stop was pressed. Click 'Clear Alarm' in the top header banner or bottom status bar (sends $X unlock). If the banner shows 'MOTOR ERROR' (closed-loop stepper position error), click 'Reset Motors' to re-energize the motor drives.
  Prerequisites: Limit switches must be physically disengaged before unlocking.
  Expected Result: Sends unlock command ($X) and motor reset signal; machine state transitions back to IDLE.
  Failure Conditions: Alarm re-triggers immediately if limit switch is still physically depressed.
  Related Features: E-Stop, Homing, Status Bar
  Action Type: safety_critical
  Confidence: VERIFIED
  Source File: frontend/src/components/Header.tsx
  Source Component: Header
  Source Function: backendUnlock(), backendMotorReset()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-NOTIF-001
  Source Type: website
  Content Type: feature
  Category: Remote Notifications
  Page: Settings
  Route: / (activeHeaderTab === 'Settings')
  Feature: WhatsApp & Telegram Notifications and Bot
  UI Element: WhatsApp / Telegram Setup Panels
  Navigation Path: Settings → General → WhatsApp
  User Intent: Receive job completion alerts on mobile phone and control CNC machine via messaging slash commands.
  Question Examples:
    - How do I get WhatsApp alerts when a job finishes?
    - Where do I pair my phone with the CNC?
    - Can I control my CNC from Telegram or WhatsApp?
    - What slash commands are supported?
  Answer: Go to Settings → WhatsApp (or Telegram). Enable the service and scan the pairing QR code with your WhatsApp app (Settings → Linked Devices). Add your phone number and toggle desired alerts (Job start, end, alarm, E-stop). Enable 'Bot commands' to text /status, /jog X+10, /home, /start, /stop, or /files directly to your machine.
  Prerequisites: Backend running with internet connectivity; WhatsApp mobile app with camera for QR pairing.
  Expected Result: Mobile messages dispatched automatically on machine state changes; slash commands executed by backend.
  Failure Conditions: Headless Chromium launch failure, phone disconnected, or unauthorized sender number.
  Related Features: Webcams (Bot-Eye snapshot), Job History
  Action Type: informational / machine_control
  Confidence: VERIFIED
  Source File: frontend/src/components/Settings/SectionNotifications.tsx
  Source Component: SectionNotifications
  Source Function: toggleEnabled(), addPhone()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21

- Knowledge ID: UI-SFL-001
  Source Type: website
  Content Type: feature
  Category: Job Execution
  Page: Prepare / Carve
  Route: / (Dialog overlay)
  Feature: Start From Line Recovery
  UI Element: Start From Line Button (SkipForward icon)
  Navigation Path: Carve → Job Control Bar → Start From Line
  User Intent: Resume a stopped or failed job from a specific G-code line number.
  Question Examples:
    - How do I resume a failed job?
    - Where is the start from line tool?
    - How do I start carving from the middle of a file?
    - Can I skip to line 500 of my G-code?
  Answer: Click the Start From Line button (SkipForward icon) in the Job Control Bar. Enter the target line number and Safe Z Height. The system automatically inspects all preceding lines to reconstruct modal states (units, plane, distance mode, WCS, spindle speed, coolant), lifts to safe machine height, applies states, and resumes cutting.
  Prerequisites: Machine connected, G-code file loaded, valid line number selected.
  Expected Result: Builds safe preamble, lifts Z, moves to XY coordinate, and streams from chosen line.
  Failure Conditions: Target line exceeds total lines in file.
  Related Features: START Job, Stop Job, G-code Stream Panel
  Action Type: safety_critical
  Confidence: VERIFIED
  Source File: frontend/src/components/StartFromLine.tsx
  Source Component: StartFromLine
  Source Function: handleStart()
  Website Version: 0.1.0
  Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e
  Last Verified: 2026-08-21
```

---

## 9. Comprehensive Change & Verification Report

```text
Change Report

Added:
- Document-level and record-level metadata (Website Version: 0.1.0, Git Commit: 2140fea7903a8c983e45fe671cfb1ae27610309e, Last Verified: 2026-08-21).
- Rigorous distinction between Website Facts and CNC Technical Knowledge.
- Full RAG schema across all knowledge records (Source Type, Content Type, Action Type, Navigation Paths, Failure Conditions, Confidence, Versioning).
- Explicit safety classification (machine_control vs safety_critical) and safety warnings.
- Expanded structured Error Records with exact messages, triggers, recommended user actions, and source mapping.

Corrected:
- Clarified that Settings → Gamepad is deprecated and superseded by Device → Joystick Control.
- Clarified that Probing settings in Home Menu were relocated to ProbingModal (launched via Sidebar Probe button).
- Confirmed that E-Stop emits binary frame 0x03 (CommPort.requestAbort) to support RTS-1/RTS-2 firmware architectures alongside GRBL.
- Verified exact START enable/disable boolean logic from JobControlBar.tsx:L99-L104.

Removed:
- Generic non-website CNC tutorials.
- Speculative assumptions regarding undocumented future features.

Marked as Inferred:
- Probe pin continuity check fallback logic (backendTestProbePin).

Marked as Unknown / Incomplete:
- Official Documentation external link destination (currently points to placeholder '#' in Library.tsx).

Deprecated Features Found:
- Old in-sidebar ProbeWizard.tsx (replaced by full-screen ProbingModal.tsx).
- Settings SectionGamepad.tsx (replaced by DevicePanel Joystick Control).

Safety-Critical Features:
- START, Pause, Stop, E-Stop, HOME ALL, ZERO ALL, Probing Wizard, Start From Line, Spindle Controls, Laser Controls & Test Fire, Firmware EEPROM Writing, Safety Banner Overrides.

Total RAG Knowledge Records:
- 10 comprehensive standalone RAG records covering all core user intents.
```
