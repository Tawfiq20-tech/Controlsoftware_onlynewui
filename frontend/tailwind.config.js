/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // Preserve existing custom colors from CSS variables
        'primary': {
          DEFAULT: 'oklch(0.7214 0.1337 49.9802)', // --primary-accent
          hover: 'oklch(0.6716 0.1368 48.5130)', // --primary-hover
        },
        'bg': {
          main: 'oklch(0.1797 0.0043 308.1928)', // --bg-main
          sidebar: 'oklch(0.1822 0 0)', // --bg-sidebar
          panel: 'oklch(0.2520 0 0)', // --bg-panel
          input: 'oklch(0.1797 0.0043 308.1928)', // --bg-input
          hover: 'oklch(0.22 0 0 / 0.5)', // --bg-hover
          elevated: 'oklch(0.25 0 0 / 0.9)', // --bg-elevated
        },
        'border': {
          ui: 'oklch(0.2520 0 0)', // --border-ui
          hover: 'oklch(0.35 0 0)', // --border-hover
          subtle: 'oklch(0.3 0 0 / 0.4)', // --border-subtle
        },
        'text': {
          main: 'oklch(0.8109 0 0)', // --text-main
          dim: 'oklch(0.6268 0 0)', // --text-dim
          bright: 'oklch(0.95 0 0)', // --text-bright
        },
        'status': {
          danger: 'oklch(0.65 0.2 15)', // --danger
          success: 'oklch(0.7 0.15 145)', // --success
          warning: 'oklch(0.78 0.14 80)', // --warning
          info: 'oklch(0.7 0.12 240)', // --info
        },
        // Jog pad colors (preserve existing)
        'jog': {
          segment: '#8fa3b3',
          'segment-hover': '#9fb5c7',
          stop: '#dc2626',
          'stop-hover': '#ef4444',
          'stop-active': '#b91c1c',
          'z-disabled': '#6a7b8a',
        }
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'Consolas', 'Monaco', 'monospace'],
      },
      spacing: {
        '1': '4px',   // --space-1
        '2': '8px',   // --space-2
        '3': '12px',  // --space-3
        '4': '16px',  // --space-4
        '5': '24px',  // --space-5
        '6': '32px',  // --space-6
        '8': '48px',  // --space-8
      },
      borderRadius: {
        'xs': '2px',   // --radius-xs
        'sm': '4px',   // --radius-sm
        'md': '8px',   // --radius-md
        'lg': '12px',  // --radius-lg
        'xl': '16px',  // --radius-xl
      },
      transitionDuration: {
        'fast': '0.15s', // --transition-fast
        'medium': '0.25s', // --transition-medium
        'slow': '0.4s', // --transition-slow
      }
    },
  },
  plugins: [],
}