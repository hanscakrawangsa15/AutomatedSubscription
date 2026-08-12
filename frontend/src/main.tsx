import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { WalletProvider } from '@tronweb3/tronwallet-adapter-react-hooks'
import { TronLinkAdapter } from '@tronweb3/tronwallet-adapters'
import './index.css'
import './lib/appkit'
import App from './App.tsx'

// Additive alongside AppKit above — TronLink is a separate wallet ecosystem
// from the eip155 wallets AppKit handles, so it gets its own React context
// provider rather than trying to route through AppKit's adapter system.
const tronAdapters = [new TronLinkAdapter()]

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WalletProvider adapters={tronAdapters} onError={(err) => console.error("[TronLink]", err)}>
      <App />
    </WalletProvider>
  </StrictMode>,
)
