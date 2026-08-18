import { Buffer } from 'buffer'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { SolanaProviders } from './components/SolanaProviders.tsx'
import './index.css'
import './lib/appkit'
import App from './App.tsx'

// @solana/web3.js and @coral-xyz/anchor expect Node's ambient `Buffer`
// global (see vite.config.ts's matching `global` define) — must run before
// anything else in this file imports code that touches it.
window.Buffer = window.Buffer || Buffer

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <SolanaProviders>
      <App />
    </SolanaProviders>
  </StrictMode>,
)
