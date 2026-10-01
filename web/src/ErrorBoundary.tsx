import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * A render error in any screen used to blank the whole app: React unmounts the tree and the person
 * is left on an empty page. This keeps the failure to a message with a way out.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true } }
  componentDidCatch(error: Error, info: ErrorInfo): void { console.error('screen crashed', error, info.componentStack) }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    return (
      <main role="alert" style={{ maxWidth: 480, margin: '12vh auto', padding: 24, textAlign: 'center' }}>
        <h1>Something went wrong</h1>
        <p>This screen could not be shown. Your work elsewhere is safe.</p>
        <button className="btn primary" onClick={() => window.location.reload()}>Reload</button>
      </main>
    )
  }
}
