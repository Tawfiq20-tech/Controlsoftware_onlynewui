import { useState } from 'react';
import { Play, Pause, Square, Zap, SkipForward, Maximize2 } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    backendJobStart,
    backendJobPause,
    backendJobResume,
    backendJobStop,
    backendSoftReset,
} from '../utils/backendConnection';
import StartFromLine from './StartFromLine';
import RunOutline from './RunOutline';
import controller from '../utils/controller';
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
        fileInfo,
        rawGcodeContent,
        safetyValidation,
        safetyOverrideArmed,
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
        if (!jobActive) {
            if (!fileLoadedBackend) {
                if (rawGcodeContent) {
                    controller.loadFile(fileInfo?.name || 'job.gcode', rawGcodeContent);
                    addConsoleLog('info', 'Syncing G-code to controller and starting job...');
                    setTimeout(() => {
                        backendJobStart();
                    }, 250);
                    return;
                }
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
    //  - G-code parsed and present in store
    //  - machine is not in alarm
    //  - no ECSS bounds violation
    const ecssBlocked = !!safetyValidation?.blocked
        && !safetyValidation?.cleared
        && !jobActive
        && !safetyOverrideArmed;
    const isJobDisabled =
        !connected ||
        gcode.length === 0 ||
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