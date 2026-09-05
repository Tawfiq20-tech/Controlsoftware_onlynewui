import { useEffect, useState } from 'react';
import { Play, Pause, Square, Zap, SkipForward, Maximize2 } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    backendJobStart,
    backendJobPause,
    backendJobResume,
    backendJobStop,
    backendSoftReset,
} from '../utils/backendConnection';
import controller from '../utils/controller';
import StartFromLine from './StartFromLine';
import RunOutline from './RunOutline';
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
        fileInfo,
        rawGcodeContent,
        fileLoadedBackend,
        controllerReady,
        safetyValidation,
        safetyOverrideArmed,
        addConsoleLog,
    } = useCNCStore();

    // Push the parsed G-code to the backend feeder as soon as it's available and
    // the backend has a live controller instance. Gating on controllerReady (not
    // just `connected`) avoids a race: `connected` flips true the instant the
    // serial port opens, but the backend's controller instance isn't assigned
    // until firmware detection finishes ~100-200ms later. Firing loadFile()
    // before that made CNCEngine.js hard-reject with no retry, leaving
    // fileLoadedBackend stuck false and Start permanently unusable.
    useEffect(() => {
        if (!connected) return;
        if (!controllerReady) return;
        if (!rawGcodeContent) return;
        if (fileLoadedBackend) return;
        controller.loadFile(fileInfo?.name || 'job.gcode', rawGcodeContent);
    }, [connected, controllerReady, rawGcodeContent, fileLoadedBackend, fileInfo?.name]);

    const handlePlayPause = () => {
        if (!connected) return;
        if (!jobActive) {
            if (!fileLoadedBackend) {
                addConsoleLog('warning', 'File still loading on backend — try again in a moment.');
                return;
            }
            if (machineState === 'paused') {
                backendJobResume();
                addConsoleLog('info', 'Job resumed');
            } else {
                backendJobStart();
                addConsoleLog('info', 'Job started');
            }
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
        addConsoleLog('error', 'EMERGENCY STOP — abort sent (0x03)');
    };

    // Enable gate (gsender pattern):
    //  - serial connected
    //  - backend feeder has the lines (not just frontend parse)
    //  - no other job currently streaming
    //  - machine is not in alarm
    // When jobActive is true the button stays enabled so it can pause/resume.
    // ECSS Module 1 — block Start when the validator says the toolpath
    // would step outside the machine envelope. Stays disabled until a
    // touch-off or new file fixes the verdict — UNLESS the one-shot
    // override has been armed (Arm one-shot override button in the
    // banner), which clears Start for the next press.
    const ecssBlocked = !!safetyValidation?.blocked
        && !safetyValidation?.cleared
        && !jobActive
        && !safetyOverrideArmed;
    const isJobDisabled =
        !connected ||
        gcode.length === 0 ||
        !fileLoadedBackend ||
        machineState === 'alarm' ||
        ecssBlocked;
    const canStop = connected && (jobActive || machineState === 'paused');

    // Only render if there's a file loaded
    if (gcode.length === 0) return null;

    return (
        <>
            <div className="job-control-bar">
                <button
                    className={`job-play-btn ${jobActive && machineState !== 'paused' ? 'running' : ''} ${ecssBlocked ? 'ecss-blocked' : ''}`}
                    onClick={handlePlayPause}
                    disabled={isJobDisabled}
                    title={
                        ecssBlocked
                            ? `Blocked by pre-flight check — see banner above (${safetyValidation?.issues?.length || 0} issue${(safetyValidation?.issues?.length || 0) === 1 ? '' : 's'}).`
                            : jobActive && machineState !== 'paused' ? 'Pause' : 'Start'
                    }
                >
                    {jobActive && machineState !== 'paused' ? <Pause size={16} /> : <Play size={16} />}
                </button>

                <div className="job-info">
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
                    disabled={!connected}
                    title="Run Outline"
                >
                    <Maximize2 size={14} />
                </button>

                <button
                    className="job-startfrom-btn"
                    onClick={() => setShowStartFromLine(true)}
                    disabled={!connected || gcode.length === 0}
                    title="Start From Line"
                >
                    <SkipForward size={14} />
                </button>

                <button
                    className="job-stop-btn"
                    onClick={handleStop}
                    disabled={!canStop}
                    title="Stop"
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