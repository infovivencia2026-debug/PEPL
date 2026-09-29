/**
 * The assistant drawer: ask in plain words, get an answer read from your own
 * records with the rows it came from. It is question-and-answer, not a chat —
 * the empty state says so, so nobody waits for a conversation.
 */
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { MessageCircleQuestion, Send, ThumbsDown, ThumbsUp, X } from 'lucide-react'
import { domainApi } from '../domainApi'
import { Button, ErrorBox } from '../ui'
import { useDialogFocus } from '../useDialogFocus'

interface Source { type: string; id?: string; label: string }
interface Answer { intent: string | null; confidence: number; text: string; sources: Source[]; suggestions: string[]; queryId?: string | null }
const HREF: Record<string, (id?: string) => string> = {
  policy: () => '#/engage', payslip: () => '#/payroll', leave_request: () => '#/leave', leave_ledger: () => '#/leave',
  daily_attendance: () => '#/attendance', holidays: () => '#/leave', inbox: () => '#/approvals', employee_assignment: () => '#/people', payroll_period: () => '#/payroll',
}

export function AssistantDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<Answer | null>(null)
  const [examples, setExamples] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [rated, setRated] = useState<boolean | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (open) { input.current?.focus(); if (!examples.length) domainApi<{ examples: string[] }>('/assistant/intents').then((r) => setExamples(r.examples)).catch(() => undefined) } }, [open, examples.length])
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape' && open) onClose() }
    window.addEventListener('keydown', esc); return () => window.removeEventListener('keydown', esc)
  }, [open, onClose])
  async function ask(q: string) {
    setBusy(true); setError(''); setRated(null)
    try { setAnswer(await domainApi<Answer>('/assistant/ask', { question: q })) } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }
  const submit = (e: FormEvent) => { e.preventDefault(); if (question.trim()) void ask(question.trim()) }
  // Keyboard containment: Tab stays inside, Escape closes, focus returns to
  // whatever opened it.
  const dialogRef = useDialogFocus<HTMLElement>(open, onClose)
  if (!open) return null
  return (
    <div className="assistant-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <aside ref={dialogRef} className="assistant" role="dialog" aria-modal="true" aria-label="Ask PEPL">
        <header>
          <h2><MessageCircleQuestion size={18} aria-hidden="true" /> Ask PEPL</h2>
          <button type="button" className="btn ghost" onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button>
        </header>
        <form onSubmit={submit}>
          <label className="field"><span className="sr-only">Your question</span>
            <input ref={input} value={question} maxLength={500} onChange={(e) => setQuestion(e.target.value)} placeholder="How many leaves do I have left?" />
          </label>
          <Button disabled={busy || !question.trim()}><Send size={15} aria-hidden="true" />{busy ? 'Looking…' : 'Ask'}</Button>
        </form>
        {error && <ErrorBox message={error} />}
        {!answer ? (
          <div className="assistant-empty">
            <p>One question, one answer, read from your own records. It does not remember a conversation — ask each thing on its own.</p>
            <ul className="chip-list">{examples.map((e) => <li key={e}><button type="button" className="chip" onClick={() => { setQuestion(e); void ask(e) }}>{e}</button></li>)}</ul>
          </div>
        ) : (
          <div className="assistant-answer" aria-live="polite">
            <p className="answer-text">{answer.text}</p>
            {answer.sources.length > 0 && (
              <p className="sources">Sources: {answer.sources.map((s, i) => (
                <a key={i} href={HREF[s.type]?.(s.id) ?? '#/dashboard'} className="chip">{s.label}</a>
              ))}</p>
            )}
            {answer.queryId && (
              <p className="rate">
                Was this useful?
                <button type="button" className={`icon-btn ${rated === true ? 'on' : ''}`} aria-label="Yes" onClick={() => { setRated(true); void domainApi('/assistant/feedback', { queryId: answer.queryId, helpful: true }) }}><ThumbsUp size={15} /></button>
                <button type="button" className={`icon-btn ${rated === false ? 'on' : ''}`} aria-label="No" onClick={() => { setRated(false); void domainApi('/assistant/feedback', { queryId: answer.queryId, helpful: false }) }}><ThumbsDown size={15} /></button>
                {rated !== null && <em>Thank you.</em>}
              </p>
            )}
            {answer.suggestions.length > 0 && (
              <ul className="chip-list">{answer.suggestions.map((s) => <li key={s}><button type="button" className="chip" onClick={() => { setQuestion(s); void ask(s) }}>{s}</button></li>)}</ul>
            )}
          </div>
        )}
      </aside>
    </div>
  )
}
