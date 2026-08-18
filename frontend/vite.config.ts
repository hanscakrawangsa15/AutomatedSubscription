import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // @solana/web3.js and @coral-xyz/anchor assume Node's ambient `Buffer`/
  // `global` — unlike tronweb/ethers, they don't ship a browser-safe shim
  // of their own. vite-plugin-node-polyfills would normally handle this,
  // but it's incompatible with this project's Vite 8 (rolldown) build as
  // of this writing (`Error: Expecting folder to folder mapping` from its
  // dep-optimizer hook) — main.tsx assigns `window.Buffer`/`window.global`
  // directly instead, the minimal equivalent for what these two packages
  // actually need.
  define: {
    global: 'globalThis',
  },
})
