import { useState, useEffect } from 'react';
import { Wifi, X } from 'lucide-react';
import { SerialConnection, type PortInfo } from '../utils/serialConnection';
import './PortSelectionModal.css';

interface PortSelectionModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelectPort: (port: SerialPort) => void;
}

export default function PortSelectionModal({ isOpen, onClose, onSelectPort }: PortSelectionModalProps) {
    const [availablePorts, setAvailablePorts] = useState<PortInfo[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (isOpen) {
            loadPorts();
        }
    }, [isOpen]);

    const loadPorts = async () => {
        setLoading(true);
        setError(null);
        
        try {
            const ports = await SerialConnection.getAvailablePorts();
            setAvailablePorts(ports);
            
            if (ports.length === 0) {
                setError('No previously authorized ports found. Click "Add New Port" to select a device.');
            }
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load ports');
        } finally {
            setLoading(false);
        }
    };

    const handleRequestNewPort = async () => {
        try {
            const connection = new SerialConnection();
            const port = await connection.requestPort();
            onSelectPort(port);
            onClose();
        } catch (err) {
            if (err instanceof Error && err.message.includes('No port selected')) {
                // User cancelled, ignore
                return;
            }
            setError(err instanceof Error ? err.message : 'Failed to request port');
        }
    };

    const handleSelectPort = (port: SerialPort) => {
        onSelectPort(port);
        onClose();
    };

    if (!isOpen) return null;

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                    <div className="modal-title">
                        <Wifi size={20} />
                        <h2>Select Serial Port</h2>
                    </div>
                    <button className="modal-close" onClick={onClose}>
                        <X size={18} />
                    </button>
                </div>

                <div className="modal-body">
                    {loading && (
                        <div className="modal-loading">
                            <div className="spinner"></div>
                            <p>Loading ports...</p>
                        </div>
                    )}

                    {error && (
                        <div className="modal-error">
                            <p>{error}</p>
                        </div>
                    )}

                    {!loading && availablePorts.length > 0 && (
                        <div className="port-list">
                            <p className="port-list-label">Previously Authorized Ports:</p>
                            {availablePorts.map((portInfo, index) => (
                                <button
                                    key={index}
                                    className="port-item"
                                    onClick={() => handleSelectPort(portInfo.port)}
                                >
                                    <div className="port-icon">
                                        <Wifi size={16} />
                                    </div>
                                    <div className="port-info">
                                        <div className="port-name">{portInfo.displayName}</div>
                                        {portInfo.info.usbVendorId !== undefined && (
                                            <div className="port-details">
                                                VID: 0x{portInfo.info.usbVendorId.toString(16).toUpperCase().padStart(4, '0')} | 
                                                PID: 0x{(portInfo.info.usbProductId || 0).toString(16).toUpperCase().padStart(4, '0')}
                                            </div>
                                        )}
                                    </div>
                                </button>
                            ))}
                        </div>
                    )}

                    <button className="btn-add-port" onClick={handleRequestNewPort}>
                        <Wifi size={16} />
                        Add New Port
                    </button>

                    <div className="modal-info">
                        <p>
                            <strong>Note:</strong> Make sure your CNC controller is connected via USB. 
                            Common controllers include GRBL, grblHAL, and compatible devices.
                        </p>
                    </div>
                </div>
            </div>
        </div>
    );
}
