import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
    plugins: [react()],
    server: {
        port: 3000,
        host: '0.0.0.0',
        open: true,
        // xfwd adds X-Forwarded-For so the backend can tell a LAN device
        // using this dev server from the operator at the PC (otherwise every
        // proxied request arrives from localhost and skips the PIN gate).
        proxy: {
            '/api': {
                target: 'http://localhost:4000',
                changeOrigin: true,
                xfwd: true
            },
            '/socket.io': {
                target: 'http://localhost:4000',
                ws: true,
                changeOrigin: true,
                xfwd: true
            }
        }
    }
})
