import { useEffect, useRef } from 'react';
import { useCNCStore } from '../stores/cncStore';
import {
    connectBackendSocket,
    requestBackendPorts,
    connectToBackendPort,
    type BackendPort,
} from '../utils/backendConnection';
import { lastDeviceStorage } from '../utils/localStorage';

// Tawfiq msg11358: "auto connect does not work, i needed to connect
// manually". Root cause was two-fold and both parts lived only inside
// DevicePanel.tsx, which App.tsx mounts ONLY when activeHeaderTab ===
// 'Device' (default tab is 'Prepare'):
//   1. connectBackendSocket() -- the Socket.IO handshake to the backend
//      itself -- only ever ran from DevicePanel's mount effect, so if the
//      user never visited the Device tab, the frontend never even talked
//      to the backend, let alone auto-connected to a serial port.
//   2. The auto-connect poll (candidate-port detection + connect) was a
//      useEffect inside DevicePanel, so navigating to Prepare/Carve to
//      actually work unmounted it (its cleanup clears the interval),
//      killing auto-connect the moment the user left the Device tab --
//      which is exactly the normal workflow.
// Fix (matches how gsender's Connection component is mounted in its
// always-visible TopBar, not a tab-gated panel): this hook owns both
// pieces and is called once, unconditionally, from the always-mounted
// AppInner() root in App.tsx -- so it runs regardless of which header
// tab is active.
export function useAutoConnect(): void {
    const { connected, connectionStatus, backendSocketConnected } = useCNCStore();

    useEffect(() => {
        connectBackendSocket().catch((err) => {
            console.warn('[useAutoConnect] Backend socket not reachable yet:', err?.message ?? err);
        });
    }, []);

    const seenPortPathsRef = useRef<Set<string> | null>(null);
    const attemptedPortPathsRef = useRef<Set<string>>(new Set());

    useEffect(() => {
        if (connected || connectionStatus === 'connecting' || !backendSocketConnected) return;
        let cancelled = false;

        const connectToPort = async (port: BackendPort) => {
            try {
                useCNCStore.getState().setConnectionStatus('connecting');
                const { appPreferences } = useCNCStore.getState();
                const baudRate = appPreferences?.baudRate ?? 115200;
                const rtscts = appPreferences?.rtscts ?? false;
                console.log(`[useAutoConnect] Connecting: ${port.port}, baudRate=${baudRate}, rtscts=${rtscts}`);
                await connectToBackendPort(port.port, { baudRate, rtscts });
                useCNCStore.getState().setConnectedPortInfo(
                    { port: port.port, manufacturer: port.manufacturer, vendorId: port.vendorId, productId: port.productId }
                );
                if (port.vendorId && port.productId) {
                    lastDeviceStorage.save({ vendorId: port.vendorId, productId: port.productId });
                }
            } catch (err) {
                console.error('[useAutoConnect] Connection failed:', err);
                useCNCStore.getState().setConnectionStatus('error');
            }
        };

        const poll = async () => {
            let ports: BackendPort[];
            try {
                ports = await requestBackendPorts();
            } catch {
                return; // backend not reachable yet -- next tick retries
            }
            if (cancelled) return;
            const currentPaths = new Set(ports.map((p) => p.port));
            const prevPaths = seenPortPathsRef.current;
            for (const path of attemptedPortPathsRef.current) {
                if (!currentPaths.has(path)) attemptedPortPathsRef.current.delete(path);
            }
            let candidate: BackendPort | null = null;
            if (prevPaths === null) {
                const lastDevice = lastDeviceStorage.load();
                if (lastDevice) {
                    candidate = ports.find(
                        (p) => p.vendorId === lastDevice.vendorId && p.productId === lastDevice.productId
                    ) ?? null;
                }
            } else {
                const newlyAppeared = ports.filter((p) => !prevPaths.has(p.port));
                if (newlyAppeared.length === 1) candidate = newlyAppeared[0];
            }
            seenPortPathsRef.current = currentPaths;
            if (candidate && !attemptedPortPathsRef.current.has(candidate.port)) {
                attemptedPortPathsRef.current.add(candidate.port);
                await connectToPort(candidate);
            }
        };

        poll();
        const interval = setInterval(poll, 3000);
        return () => {
            cancelled = true;
            clearInterval(interval);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [connected, connectionStatus, backendSocketConnected]);
}
