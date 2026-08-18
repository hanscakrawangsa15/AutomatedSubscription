import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AdminApp } from './AdminApp.tsx'
import { ToastProvider } from './components/Toast.tsx'

// No router — /admin is the only other "page" this app has, so a plain
// path check is enough rather than pulling in a routing library for two
// routes. Requires the production static-file server to fall back to
// index.html for /admin (an SPA rewrite rule), same as it already must for
// any deep link into the main app.
const isAdmin = window.location.pathname.startsWith('/admin')

// AppKit (WalletConnect) initialization has real network/setup cost and is
// irrelevant to the admin panel — only load it for the subscribe flow.
if (!isAdmin) {
  import('./lib/appkit')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ToastProvider>{isAdmin ? <AdminApp /> : <App />}</ToastProvider>
  </StrictMode>,
)
