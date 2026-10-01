import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { ErrorBoundary } from './ErrorBoundary'
import './styles.css'
import { registerPeplWorker } from './push'

void registerPeplWorker().catch(() => {
  // Push is optional; unsupported or policy-blocked workers must not block PEPL.
})
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary><App /></ErrorBoundary>
  </React.StrictMode>,
)
