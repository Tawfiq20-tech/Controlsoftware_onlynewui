import { useState } from 'react';
import { Play, Pause, Square, Zap, SkipForward, Maximize2, AlertTriangle } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    backendJobPause,
    backendJobResume,
    backendJobStop,
    backendSoftReset,
} from '../utils/backendConnection';
import StartFromLine from './StartFromLine';
import RunOutline from './RunOutline';
import { startShownDesign } from '../utils/designLoad';
import './JobControlBar.css';

export default function JobControlBar() {
    const [showStartFromLine, setShowStartFromLine] = useState(false);
    const [showRunOutline, setShowRunOutline] = useState(false);

    const {
        connected,
        machineState,
        jobActive,
        gcode,
        jobProgress,
        currentLine,
        fileLoadedBackend,
        safetyValidation,
        safetyOverrideArmed,
        fileLoadError,
        programPause,
        resumePoint,
        addConsoleLog,
    } = useCNCStore();

    // The file:load dispatch itself lives in App.tsx's effect (always
    // mounted at the app root), not here. JobControlBar only mounts
    // conditionally (Visualizer3D.tsx's showCarveBar), so a duplicate
    // copy of that effect here used to race the App.tsx one -- both would
    // see fileLoadedBackend===false at the same time and both would fire
    // controller.loadFile(), causing the backend to redundantly re-parse
    // and reload the sender (HIGH#8). Removed; see App.tsx.

    const handlePlayPause = () => {
        if (!connected) return;
        if (!jobActive && fileLoadError) {
            addConsoleLog('error', `"${fileLoadError.name}" cannot run on this machine -- see the reasons above. Load a corrected file.`);
            return;
        }
        if (!jobActive) {
            if (fileLoadedBackend && machineState === 'paused') {
                backendJobResume();
                addConsoleLog('info', 'Job resumed');
                return;
            }
            // Starts only the design shown on this screen: when it is not on
            // the machine yet, it is loaded first and Start is sent only after
            // the machine confirms exactly this content (no fixed timer).
            startShownDesign('play');
        } else if (machineState === 'paused') {
            backendJobResume();
            addConsoleLog('info', 'Job resumed');
        } else {
            backendJobPause();
            addConsoleLog('warning', 'Job paused');
        }
    };

    const handleStop = () => {
        if (!connected) return;
        backendJobStop();
        addConsoleLog('warning', 'Job stopped');
    };

    const handleEmergencyStop = () => {
        if (!connected) return;
        // RTS abort = binary frame 01 05 00 03 FF (vendor CommPort.requestAbort).
        // backendSoftReset → controller.reset() → backend 'reset' command →
        // RTSController._softReset() → 0x03 byte. The old ASCII '!' + Ctrl-X
        // were GRBL idioms which RTS firmware ignores — that's why your
        // E-Stop wasn't halting the machine.
        backendSoftReset();
        addConsoleLog('error', 'EMERGENCY STOP — motion stopped, drivers disabled');
    };

    // Enable gate (gsender pattern):
    //  - serial connected
    //  - G-code parsed and present in store
    //  - machine is not in alarm
    //  - no ECSS bounds violation
    const ecssBlocked = !!safetyValidation?.blocked
        && !safetyValidation?.cleared
        && !jobActive
        && !safetyOverrideArmed;
    const loadRefused = !!fileLoadError && !jobActive;
    const isJobDisabled =
        !connected ||
        // starting a job needs the file; pausing or resuming a running one does
        // not -- a second screen must still be able to hold the machine
        (!jobActive && gcode.length === 0) ||
        machineState === 'alarm' ||
        ecssBlocked ||
        loadRefused;
    // 'running' counts too: after a screen restart the machine can be cutting
    // while this client has not seen a sender:start of its own.
    const canStop = connected && (jobActive || machineState === 'running' || machineState === 'paused');

    // Normally the bar needs a file. But a screen that joined after the carve
    // started (a second tab, a phone, a refresh that lost the local parse) has
    // no local G-code and was shown NOTHING -- no Stop, no E-STOP, no Resume
    // for an M0 pause. Whenever the machine is working, the controls are there.
    if (gcode.length === 0 && !jobActive && !programPause) return null;

    const willResumeFrom = !jobActive && resumePoint && resumePoint.line > 1 ? resumePoint.line : 0;

    return (
        <>
            {!connected && (jobActive || programPause) && (
                <div className="job-connection-lost" role="alert">
                    <AlertTriangle size={14} />
                    <span>
                        <strong>Connection to the machine lost.</strong> What you see here is the last
                        known state — Stop and E-STOP cannot reach the machine. Use the machine's own
                        emergency stop.
                    </span>
                </div>
            )}
            {programPause && (
                <div className="job-program-pause" role="status">
                    <Pause size={14} />
                    <span className="job-program-pause-text">
                        <strong>{programPause.kind === 'dwell' ? 'Waiting' : 'Paused'} at line {programPause.line}</strong>
                        {programPause.message ? ` — ${programPause.message}` : ` (${programPause.optional ? 'M1' : 'M0'} in the program)`}
                    </span>
                    <button
                        className="job-program-pause-btn"
                        onClick={() => { backendJobResume(); addConsoleLog('info', programPause.kind === 'dwell' ? 'Skipping the wait' : 'Continuing the program'); }}
                        disabled={!connected}
                    >
                        <Play size={13} /> {programPause.kind === 'dwell' ? 'Skip wait' : 'Resume'}
                    </button>
                </div>
            )}
            <div className="job-control-bar">
                <button
                    className={`job-play-btn ${jobActive && machineState !== 'paused' ? 'running' : ''} ${ecssBlocked ? 'ecss-blocked' : ''}`}
                    onClick={handlePlayPause}
                    disabled={isJobDisabled}
                    title={
                        loadRefused
                            ? `Cannot run: ${fileLoadError?.errors?.[0] ? `${fileLoadError.errors[0].line ? `line ${fileLoadError.errors[0].line}: ` : ''}${fileLoadError.errors[0].msg}` : 'file refused'}${(fileLoadError?.errorCount || 0) > 1 ? ` (+${(fileLoadError?.errorCount || 0) - 1} more, see console)` : ''}`
                            : ecssBlocked
                            ? `Blocked by pre-flight check — see banner above (${safetyValidation?.issues?.length || 0} issue${(safetyValidation?.issues?.length || 0) === 1 ? '' : 's'}).`
                            : jobActive && machineState !== 'paused' ? 'Pause'
                            : willResumeFrom
                            ? `Resume from line ${willResumeFrom}${resumePoint?.reason ? ` (stopped: ${resumePoint.reason})` : ''} — the tool lifts, returns and plunges before cutting, unless a Stop left it on that spot`
                            : 'Start'
                    }
                >
                    {jobActive && machineState !== 'paused' ? <Pause size={16} /> : <Play size={16} />}
                </button>

                <div className="job-info">
                    {willResumeFrom > 0 && (
                        <div className="job-resume-hint">
                            ▶ continues from line {willResumeFrom}
                            {resumePoint?.reason ? ` — ${resumePoint.reason}` : ''}
                        </div>
                    )}
                    <div className="job-stats-row">
                        <span>Lines <span className="job-stat-val">{gcode.length}</span></span>
                        <span>Current <span className="job-stat-val">{currentLine}</span></span>
                        <span><span className="job-stat-val">{Math.round(jobProgress)}%</span></span>
                    </div>
                    <div className="job-progress-bar">
                        <div className="job-progress-fill" style={{ width: `${jobProgress}%` }} />
                    </div>
                </div>

                <button
                    className="job-outline-btn"
                    onClick={() => setShowRunOutline(true)}
                    disabled={!connected || (jobActive && machineState !== 'paused')}
                    title="Run Outline — Trace workpiece boundary perimeter at safe Z height"
                >
                    <Maximize2 size={14} />
                </button>

                <button
                    className="job-startfrom-btn"
                    onClick={() => setShowStartFromLine(true)}
                    disabled={!connected || gcode.length === 0}
                    title="Start From Line — Resume carve job starting from a specific G-code line"
                >
                    <SkipForward size={14} />
                </button>

                <button
                    className="job-stop-btn"
                    onClick={handleStop}
                    disabled={!canStop}
                    title="Stop Job — Stop current carve and unlock file management"
                >
                    <Square size={14} />
                </button>

                <button
                    className="emergency-stop-btn"
                    onClick={handleEmergencyStop}
                    disabled={!connected}
                    title="Emergency Stop (Feed Hold + Reset)"
                >
                    <Zap size={14} />
                    E-STOP
                </button>
            </div>

            {showStartFromLine && (
                <StartFromLine onClose={() => setShowStartFromLine(false)} />
            )}
            {showRunOutline && (
                <RunOutline onClose={() => setShowRunOutline(false)} />
            )}
        </>
    );
}