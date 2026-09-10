import { Gauge, RotateCcw } from 'lucide-react';
import { useCNCStore } from '../stores/cncStore';
import {
    backendFeedOverrideReset,
    backendFeedOverrideCoarsePlus,
    backendFeedOverrideCoarseMinus,
    backendFeedOverrideFinePlus,
    backendFeedOverrideFineMinus,
} from '../utils/backendConnection';
import './FeedOverrideControl.css';

export default function FeedOverrideControl() {
    const { connected, feedOverridePct, setFeedOverridePct, addConsoleLog } = useCNCStore();

    const handleFeedChange = (fn: () => void, delta: number, label: string) => () => {
        if (!connected) return;
        const nextPct = delta === 0 ? 100 : Math.min(150, Math.max(50, Math.round(feedOverridePct + delta)));
        setFeedOverridePct(nextPct);
        fn();
        addConsoleLog('info', `Feed override: ${label} (${nextPct}%)`);
    };

    return (
        <div className={`feed-override-control ${!connected ? 'disabled' : ''}`}>
            <div className="feed-override-header">
                <Gauge size={13} />
                <span className="feed-override-title">Speed (Feed Override)</span>
                <span className="feed-override-pct">{feedOverridePct.toFixed(0)}%</span>
            </div>

            <div className="feed-override-buttons">
                <button
                    className="feed-override-btn"
                    onClick={handleFeedChange(backendFeedOverrideCoarseMinus, -10, '-10%')}
                    disabled={!connected}
                    title="Decrease feed 10%"
                >
                    -10%
                </button>
                <button
                    className="feed-override-btn"
                    onClick={handleFeedChange(backendFeedOverrideFineMinus, -1, '-1%')}
                    disabled={!connected}
                    title="Decrease feed 1%"
                >
                    -1%
                </button>
                <button
                    className="feed-override-btn reset"
                    onClick={handleFeedChange(backendFeedOverrideReset, 0, 'reset to 100%')}
                    disabled={!connected}
                    title="Reset to 100%"
                >
                    <RotateCcw size={12} />
                </button>
                <button
                    className="feed-override-btn"
                    onClick={handleFeedChange(backendFeedOverrideFinePlus, 1, '+1%')}
                    disabled={!connected}
                    title="Increase feed 1%"
                >
                    +1%
                </button>
                <button
                    className="feed-override-btn"
                    onClick={handleFeedChange(backendFeedOverrideCoarsePlus, 10, '+10%')}
                    disabled={!connected}
                    title="Increase feed 10%"
                >
                    +10%
                </button>
            </div>
        </div>
    );
}
