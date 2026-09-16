# EasyCNC product fix — status

Goal: any design the customer loads runs from start to finish in one go, with
no mid-job stop, and an interruption can always be continued from the exact
line. Reference files: `Downloads/gcode_test_file/file_finity` (13 files).

Last updated: 2026-09-16. **Nothing has been flashed and the machine has not
been run.** Firmware 0.2.0 is built and waiting; the sender works on the
firmware currently on the board as well.

---

## Verified right now

`cd backend && npm test` — 13 test files, all passing (~120 s). A test file now
has to SAY it finished: a test that dies half way through used to exit 0 and be
reported as a pass, and a missing corpus folder is called out as SKIPPED
instead of reading as full cover.

### Independent audit (2026-09-16)

109 review agents went over the rewritten code against the firmware source:
50 findings, 16 refuted, **34 confirmed and all 34 now fixed**. The ones that
would have reached the machine:

| Confirmed defect | Why it mattered |
|---|---|
| `G4 X2.5` compiled into a cutting move | Fanuc-form dwell ploughed the tool sideways at depth |
| An arc word with an explicit `+` sign was dropped | `G2 X+10 Y+0 I+5 J0` collapsed the whole arc onto one point |
| Arc position tracking ignored incremental moves | An arc after a `G91` section was cut from a stale start point |
| Stall detection could never fire on real hardware | A stuck step engine still reports "moving"; the job would hang forever |
| Resume traversed at the safe height, not the file's clearance plane | On stock taller than 10 mm the traverse crossed the work |
| Resume "lift" could descend | A tool parked high dropped to the safe height over whatever was on the table |
| Feed override scaled the resume plunge | 200% would have plunged twice as fast as the safety feed |
| Error replies resolved as success | A refused jog/zero/home was completely silent |
| A stalled link could never recover | Every later command refused until the port was reopened |
| A device on an old sequence number livelocked | Sender and board repeated themselves forever |
| The durable power-cut checkpoint was never written | "Resume after a power cut" had nothing to resume from |
| Disconnecting mid-job never told the machine | The controller's watchdog stopped it in the cut |
| RUN.bat's carve check failed unsafe | Any timeout read as "no carve" and killed the sender |
| A second screen got no Stop, and ▶ silently resumed | The operator could not stop a carve from the screen in front of them |
| Units toggle relabelled the readout without converting | 12.700 mm shown as 12.700 in |

The gate that matters most is `tests/corpus_stream.test.js`: every one of the
13 reference files is loaded through the real controller and streamed to a
fake firmware that behaves like `easycnc_protocol.c`. For each file it checks
that **every move executes exactly once, in order, at the compiled target**,
as a single firmware job, with no abort, no planner overflow and no watchdog
trip.

| File | Moves | Machine time |
|---|---|---|
| Happy Halloween 3D Finishing | 502,056 | 2.8 h |
| fish_wall_redline | 465,847 | 2.6 h |
| Textured Clock Number Pockets | 58,933 | 0.3 h |
| CABIN CLOCK RELIEF ROUGH | 39,503 | 0.2 h |
| Bluey-Bingo V-Carve | 32,182 | 0.2 h |
| …and 8 more | | |

Run against the firmware on the board today with
`EASYCNC_FW_VERSION=0.1.1 node tests/corpus_stream.test.js` — **all 13 files
finish there too**, so none of this waits on flashing.

The other gates:

- `rsp-stream-engine` — 16 fault scenarios: lost events, lost frames,
  stop/resume, driver alarm mid-move, M0 pause, G4 dwell and skipping it,
  E-stop, link silence, a frozen machine, an undeliverable line, and a
  70,508-line job crossing both the line-number and sequence wrap.
- `rsp-firmware-compat` — run, pause, M0, alarm, stop and orphan-job recovery
  against **both** firmware 0.1.1 (flashed) and 0.2.0 (new).
- `arc_linearization` — all 4,293 arcs in the corpus, checked against the
  ORIGINAL files: every point on the true arc, right direction, exact
  endpoint, and the chords never bow more than one motor step.
- `fw_number_scanner` — firmware 0.2.0's own G-code number reader, run over
  3.79 million words of the reference files.

`tests/rsp-stream-engine.test.js` runs 15 fault scenarios against the same
fake firmware: lost events, lost frames, stop/resume, driver alarm mid-move,
program pause, E-stop, link silence, a frozen machine, an undeliverable line,
and a 70,508-line job that crosses both the line-number and sequence wrap.

---

## What was wrong, and what changed

### Things that stopped a job mid-way

| Cause | Fix |
|---|---|
| Files over 60,000 lines were split into separate firmware jobs; each split dropped the machine to idle and **switched the drivers off mid-carve** | One firmware job per file; line numbers wrap safely |
| Progress was credited from lines the firmware had only *received* (`M3`, `T1`, `G17` answer immediately), so resume points landed past uncut lines and the planner could be overfilled | Only confirmed moves count; the resume point is the contiguous watermark of finished lines |
| A stall reported the job as *finished*, wiping the resume point | Every failure stops the machine and keeps the resume point |
| "No move finished for 90 s" also fired on one long slow move | A stall now needs no progress **and** no machine motion in telemetry |
| Stop could leave a gap the firmware waited on forever — Stop and E-STOP were then refused | Gaps are filled immediately; Stop is honoured at once |
| A page refresh or a second browser tab re-uploaded the open file, which stopped the carve | The running job is left alone; another file is refused until you stop |
| Double-clicking RUN.bat during a carve killed the sender, and the controller stopped the machine on its own 5 s watchdog | RUN.bat now asks the running sender first and refuses to kill a carve |
| A backend crash or closing the window did the same | Uncaught errors no longer kill the process; closing stops the job cleanly first |
| The PC going to sleep suspends USB and the machine stops mid-cut | The sender holds a wake lock while a job runs |
| `M0` ("Click Continue when the spindle is up to speed") was ignored — the machine started cutting with the spindle off | The job pauses and waits for Resume; `G4` dwells wait too |

### Things that cut the wrong thing

- Hex-float parsing (`G0X11.1` lost the X), feed lag and step-grid drift — all
  removed by compiling every line before it is streamed (`lib/wireCompiler.js`).
- Start From Line used to plunge to machine Z (−254 mm on an inch file). Resume
  and Start From Line now always lift, travel above the work, then plunge.
- The power-cut checkpoint prepended its own preamble to the raw file, which
  re-read an inch file's remaining coordinates as millimetres. It now uses the
  controller's safe resume.
- E-STOP rebooted the controller, losing the work zero and the USB connection.
  It now stops the step engine at once, keeps the position and saves the
  resume point.

### Things that cut the wrong shape (found while verifying, 2026-09-16)

| Cause | Fix |
|---|---|
| `G4 X2.5` — the Fanuc/Haas way of writing a 2.5 second dwell — compiled into a **cutting move to X2.5**, ploughing across the work | A G4 line can no longer move the machine; X is read as the dwell time, with a warning saying so |
| `G28` / `G30` (the retract most CAM posts end with) **refused the whole file** | Handled like `G53`: lift to safe Z, never travel to a "home" this machine does not have |
| Arc chords bowed up to **0.017 mm** off the true curve on large radii (fixed 3° step) | Step derived from the radius: the cut stays within one motor step (0.005 mm) of the true arc, and small arcs now need *fewer* moves |
| A dwell of `P600` (a post writing milliseconds) would park the machine for 10 minutes with no explanation | Flagged at load as probably milliseconds, shown in the pause banner, and skippable with Resume |

### Feed override

The firmware accepts the override and stores it, but never applies it to a
move — so the buttons did nothing on the machine. The sender now applies it to
the lines it has not streamed yet, re-clamped to the machine's per-axis limits
(200% never exceeds the axis maximum). It takes effect within the few moves
already queued. **The Controls tab is open during a carve** so the speed can be
changed while cutting; the Jog tab is locked instead (the job owns the machine).

### Safety / access

- Remote access over the internet tunnel was treated as if it came from the PC
  at the machine, so the PIN was skipped entirely. Tunnelled and proxied
  requests now always need the PIN, and with no PIN set remote access is off
  rather than open.
- **Any website you visited could drive the machine.** The server accepted API
  and socket connections from every web origin, and a page in your browser
  reaches `localhost` from your own PC — so it looked local and passed every
  check. Only pages served by this machine (localhost, its LAN address, the
  tunnel) are accepted now; a sandboxed iframe (`Origin: null`) is refused too.
- A failing log write (disk full, USB drive pulled) threw an uncaught
  exception. Logging can no longer take the sender down mid-carve.
- Raw serial passthrough could inject text G-code mid-carve; it is refused
  during a job and refused outright on this protocol.
- Firmware flashing is refused while a job is loaded, running or paused.
- Remote diagnostics mirroring (it was streaming logs to `10.1.76.249`) is off.

---

### Firmware 0.2.0 (built 2026-09-16, NOT flashed)

`shortcut/firmware/firmware_0.2.0.hex`, sha256 `7b3d5d75…`, source in
`source_0.2.0/`, diff in `0.2.0_vs_0.1.2.patch`. Builds warning-free.
Flash with `"FLASH (2).bat" firmware_0.2.0.hex`; roll back with
`tillnow_good_firmware.hex`. Check `SHA256SUMS.txt` first — the file names in
that folder had drifted (`firmware.hex` is the 0.1.2 build, not 0.1.1), and
the list is now correct and machine-checkable (`sha256sum -c SHA256SUMS.txt`).

1. **Numbers are read decimally, and nothing else.** The C library function
   used before also accepted hexadecimal, so `G0X2.6416Y3.6613` (no spaces,
   as several posts write it) was read as `G17` with **no X word at all** and
   the machine ran the line with X wherever it happened to be. That is the
   2026-09-13 cut. It misreads **539 real lines in your own reference files**.
   (The sender rewrites every line before sending, so this is the second of
   two independent guards.)
2. An interrupted move on the `OP_MOVE`/text path now keeps the steps it took
   — the position used to silently revert to the start of that move.
3. A stop is never refused: abort works in ALARM/E-stop, and job id `0xFFFF`
   means "whatever job you are running".
4. RESUME only lifts a feed hold (it used to be able to start motion from idle
   on whatever was left in the planner).
5. Driver faults everywhere cut power, record the axis, report a real reason
   and clear the planner.
6. While held, the alarm inputs are still watched, the line in flight is
   finished and reported, and the PC-lost watchdog still applies.
7. The plain-text console is refused while the sender is connected, so nothing
   can move the machine behind its back (`?` status still works).

## Not done yet

1. **Firmware beyond 0.2.0**: feed hold that stops *inside* a move (today a
   pause finishes the current line first), integer step counters, and the
   2 ms ALM trip still used by the homing/probe path. Also: homing, probing
   and `OP_MOVE` still block the controller's main loop for the whole physical
   motion, so during those (and only those) a software E-STOP is not acted on
   until the move ends — the machine's own emergency stop is the one to use.
2. **Machine limits** are still the conservative defaults (X/Y 5000, Z 3000
   mm/min, 10 mm safe height, Z travel unknown). They should be measured on
   the machine and put in `backend/data/config.json`.
3. **The X driver ALM trip** that stopped the 2026-09-15 job is hardware. The
   sender now survives it cleanly (exact resume point, safe continue), but the
   wiring/driver cause is still open.

## What needs you and the machine

1. **Air cut first, no stock, spindle off, Z well clear.** Load
   `Buildbotics_DRAGON ROUGH.ngc` and check, in order: it pauses at the `M0`
   with its message; Resume continues; the feed override changes the speed
   while cutting; Stop then Start continues from the stopped line by lifting,
   travelling and plunging; E-STOP stops at once and keeps the position.
2. **Then flash `firmware_0.2.0.hex`** (`"FLASH (2).bat" firmware_0.2.0.hex`,
   checksums first) and repeat the same air cut. Roll back any time with
   `tillnow_good_firmware.hex`. The sender is tested against both, so this is
   not urgent — it closes the parsing hole for raw/console G-code and makes
   stops and faults cleaner.
3. **Measure the real limits** — maximum X/Y/Z feed and how far Z can travel
   above the work — and put them in `backend/data/config.json` under
   `machine.maxRate` / `machine.zHeadroom`. Everything currently uses
   conservative defaults (5000/5000/3000 mm/min, Z travel unknown).
4. **The X driver's ALM wiring** is still the open hardware question from
   2026-09-15.
