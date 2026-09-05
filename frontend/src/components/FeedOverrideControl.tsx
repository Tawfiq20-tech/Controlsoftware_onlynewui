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
    const { connected, feedOverridePct, addConsoleLog } = useCNCStore();

    const withLog = (fn: () => void, label: string) => () => {
        if (!connected) return;
        fn();
        addConsoleLog('info', `Feed override: ${label}`);
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
                    onClick={withLog(backendFeedOverrideCoarseMinus, '-10%')}
                    disabled={!connected}
                    title="Decrease feed 10%"
                >
                    -10%
                </button>
                <button
                    className="feed-override-btn"
                    onClick={withLog(backendFeedOverrideFineMinus, '-1%')}
                    disabled={!connected}
                    title="Decrease feed 1%"
                >
                    -1%
                </button>
                <button
                    className="feed-override-btn reset"
                    onClick={withLog(backendFeedOverrideReset, 'reset to 100%')}
                    disabled={!connected}
                    title="Reset to 100%"
                >
                    <RotateCcw size={12} />
                </button>
                <button
                    className="feed-override-btn"
                    onClick={withLog(backendFeedOverrideFinePlus, '+1%')}
                    disabled={!connected}
                    title="Increase feed 1%"
                >
                    +1%
                </button>
                <button
                    className="feed-override-btn"
                    onClick={withLog(backendFeedOverrideCoarsePlus, '+10%')}
                    disabled={!connected}
                    title="Increase feed 10%"
                >
                    +10%
                </button>
            </div>
        </div>
    );
}
