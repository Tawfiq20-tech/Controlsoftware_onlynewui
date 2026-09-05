import { Component, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
    children: ReactNode;
    fallbackMessage?: string;
}

interface State {
    hasError: boolean;
    error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
    constructor(props: Props) {
        super(props);
        this.state = { hasError: false, error: null };
    }

    static getDerivedStateFromError(error: Error): State {
        return { hasError: true, error };
    }

    componentDidCatch(error: Error, info: React.ErrorInfo) {
        console.error('[ErrorBoundary]', error, info.componentStack);
    }

    handleReset = () => {
        this.setState({ hasError: false, error: null });
    };

    render() {
        if (this.state.hasError) {
            return (
                <div style={{
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    justifyContent: 'center',
                    height: '100%',
                    gap: 12,
                    padding: 24,
                    color: 'rgba(255,255,255,0.7)',
                    background: 'rgba(20,20,24,0.95)',
                }}>
                    <AlertTriangle size={32} color="#e74c3c" />
                    <p style={{ fontSize: 14, fontWeight: 600 }}>
                        {this.props.fallbackMessage || 'Something went wrong'}
                    </p>
                    <p style={{ fontSize: 12, opacity: 0.6, maxWidth: 400, textAlign: 'center' }}>
                        {this.state.error?.message}
                    </p>
                    <button
                        onClick={this.handleReset}
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            padding: '6px 16px',
                            border: '1px solid rgba(255,255,255,0.15)',
                            borderRadius: 6,
                            background: 'rgba(255,255,255,0.06)',
                            color: 'rgba(255,255,255,0.8)',
                            cursor: 'pointer',
                            fontSize: 13,
                        }}
                    >
                        <RefreshCw size={14} />
                        Retry
                    </button>
                </div>
            );
        }

        return this.props.children;
    }
}
