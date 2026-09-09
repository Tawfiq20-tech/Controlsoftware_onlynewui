/**
 * SectionFirmwareUpdate — "Update Firmware" panel for EasyCNC's STM32H723
 * board. No BOOT0 pin/button interaction required: entering the DFU
 * bootloader is triggered over the existing RSP link (RSP_OP_ENTER_BOOTLOADER),
 * then the actual image write happens over USB DFU. Works whether the host
 * running this control software is a laptop or a Raspberry Pi.
 *
 * Flow: pick a .hex file -> read it client-side as text -> emit
 * 'firmware:flash' with boardType 'EASYCNC' -> render the flash:* event
 * stream live -> tell the user to reconnect once the device re-enumerates.
 */
import { useEffect, useRef, useState } from 'react';
import { Cpu, UploadCloud, AlertTriangle, CheckCircle2 } from 'lucide-react';
import controller from '../../utils/controller';
import { useCNCStore } from '../../stores/cncStore';

interface LogLine { type: 'info' | 'error' | 'success'; content: string; }

export default function SectionFirmwareUpdate() {
    const connected = useCNCStore((s) => s.connected);
    const firmwareVersion = useCNCStore((s) => s.firmwareVersion);
    const connectedPortInfo = useCNCStore((s) => s.connectedPortInfo);
    const machineState = useCNCStore((s) => s.machineState);

    const [file, setFile] = useState<File | null>(null);
    const [confirming, setConfirming] = useState(false);
    const [flashing, setFlashing] = useState(false);
    const [progress, setProgress] = useState<number | null>(null);
    const [log, setLog] = useState<LogLine[]>([]);
    const [done, setDone] = useState<'success' | 'error' | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const s = controller.socket;
        if (!s) return;

        const onMessage = (m: { type: 'info' | 'error' | 'success'; content: string }) => {
            setLog((prev) => [...prev, m]);
        };
        const onProgress = (p: { percent: number }) => setProgress(p.percent);
        const onError = (message: string) => {
            setLog((prev) => [...prev, { type: 'error', content: message }]);
            setFlashing(false);
            setDone('error');
        };
        const onEnd = () => {
            setFlashing(false);
            setDone('success');
        };

        s.on('flash:message', onMessage);
        s.on('flash:progress', onProgress);
        s.on('flash:error', onError);
        s.on('flash:end', onEnd);

        return () => {
            s.off('flash:message', onMessage);
            s.off('flash:progress', onProgress);
            s.off('flash:error', onError);
            s.off('flash:end', onEnd);
        };
    }, []);

    const pickFile = (f: File | null) => {
        setFile(f);
        setConfirming(false);
        setDone(null);
        setLog([]);
        setProgress(null);
    };

    const startFlash = () => {
        if (!file || !controller.socket?.connected || !connectedPortInfo) return;

        setFlashing(true);
        setConfirming(false);
        setDone(null);
        setProgress(0);
        setLog([{ type: 'info', content: `Reading ${file.name}...` }]);

        const reader = new FileReader();
        reader.onload = () => {
            const hexData = reader.result as string;
            controller.socket?.emit(
                'firmware:flash',
                { port: connectedPortInfo.port, boardType: 'EASYCNC', hexData },
                (err?: { message?: string } | null) => {
                    if (err) {
                        setLog((prev) => [...prev, { type: 'error', content: err.message || String(err) }]);
                        setFlashing(false);
                        setDone('error');
                    }
                },
            );
        };
        reader.onerror = () => {
            setLog((prev) => [...prev, { type: 'error', content: 'Could not read the selected file.' }]);
            setFlashing(false);
            setDone('error');
        };
        reader.readAsText(file);
    };

    const reset = () => {
        pickFile(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
    };

    return (
        <div className="settings-section">
            <div className="settings-section-header">
                <div>
                    <h3>Update firmware</h3>
                    <p className="settings-section-sub">
                        Flash a new firmware image over your existing connection -- no BOOT0
                        button, no cable swap. Works the same whether this app is running on
                        a laptop or a Raspberry Pi.
                    </p>
                </div>
            </div>

            <div className="settings-detect">
                <span className={`dot ${connected ? 'ok' : 'off'}`} />
                {connected
                    ? <span>Connected on {connectedPortInfo?.port ?? 'unknown port'} -- running firmware <b>{firmwareVersion || 'unknown'}</b></span>
                    : <span className="dim">Not connected -- connect to the machine before flashing.</span>}
            </div>

            {connected && machineState !== 'idle' && !flashing && (
                <div className="settings-error">
                    <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                    Machine is not idle (state: {machineState}). Finish or stop the current job first --
                    the firmware refuses to enter the bootloader unless it's idle.
                </div>
            )}

            {!flashing && done !== 'success' && (
                <div className="settings-form">
                    <h4>1. Choose firmware file</h4>
                    <label>
                        Intel HEX file (.hex)
                        <input
                            ref={fileInputRef}
                            type="file"
                            accept=".hex"
                            onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
                        />
                    </label>

                    {file && !confirming && (
                        <div className="settings-form-actions">
                            <button
                                className="settings-btn primary"
                                disabled={!connected}
                                onClick={() => setConfirming(true)}
                            >
                                <UploadCloud size={14} /> Flash {file.name}
                            </button>
                        </div>
                    )}

                    {file && confirming && (
                        <div className="settings-error" style={{ color: '#fde047', borderColor: 'rgba(250, 204, 21, 0.4)', background: 'rgba(250, 204, 21, 0.1)' }}>
                            <AlertTriangle size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                            This will interrupt the current connection and reboot the board into a new
                            firmware image. Don't power off the machine during the flash. Continue?
                            <div className="settings-form-actions" style={{ marginTop: 10 }}>
                                <button className="settings-btn" onClick={() => setConfirming(false)}>Cancel</button>
                                <button className="settings-btn primary" onClick={startFlash}>Yes, flash now</button>
                            </div>
                        </div>
                    )}
                </div>
            )}

            {(flashing || log.length > 0) && (
                <div className="settings-form">
                    <h4>{flashing ? 'Flashing...' : done === 'success' ? 'Flash complete' : 'Flash log'}</h4>

                    {progress !== null && flashing && (
                        <div className="settings-axis-bar" style={{ height: 8 }}>
                            <div className="bar-fill" style={{ width: `${Math.min(100, Math.max(0, progress))}%` }} />
                        </div>
                    )}

                    <div className="settings-file-list" style={{ maxHeight: 220, overflowY: 'auto', fontFamily: 'ui-monospace, SF Mono, Menlo, monospace' }}>
                        {log.map((l, i) => (
                            <div key={i} className="settings-file-row" style={{
                                color: l.type === 'error' ? '#fca5a5' : l.type === 'success' ? '#4ade80' : '#cbd5e1',
                            }}>
                                <span>{l.content}</span>
                            </div>
                        ))}
                    </div>

                    {done === 'success' && (
                        <div className="settings-result" style={{ color: '#4ade80' }}>
                            <CheckCircle2 size={14} style={{ verticalAlign: 'text-bottom', marginRight: 6 }} />
                            Device is rebooting into the new firmware and will re-enumerate. Reconnect once it reappears.
                        </div>
                    )}

                    {!flashing && (
                        <div className="settings-form-actions">
                            <button className="settings-btn" onClick={reset}>
                                <Cpu size={14} /> {done === 'success' ? 'Flash another file' : 'Try again'}
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
