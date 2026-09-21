import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Inbox, Mail, MessageCircle, PenLine, RefreshCw, Send, Users } from 'lucide-react'
import { ApiError, fullName } from './api'
import { domainApi } from './domainApi'
import { on } from './live'
import type { Employee, Workspace } from './types'
import { Mailbox } from './Mailbox'
import { ChatWorkspace } from './ChatWorkspace'

type Conversation = { id: string; kind: 'dm' | 'group'; title: string | null; last_message_body: string | null; unread: number; is_readonly: boolean }
type Message = { id: number; body: string | null; sender_user_id: string | null; sent_at: string; edited_at: string | null; deleted_at: string | null }
type Folder = { id: string; name: string; unread: number; role: string | null }
type Envelope = { id: string; subject: string | null; from_name: string | null; from_address: string | null; preview: string | null; received_at: string; is_seen: boolean }
type OpenedMail = { envelope: Envelope; body_text: string | null; body_html: string | null }
type DirectoryEmployee = Employee & { employee_id?: string; user_id?: string | null }

const request = domainApi

const htmlText = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent ?? ''
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!).replace(/\n/g, '<br>')

export function Communications(props: { mode: 'chat' | 'mail'; data: Workspace }) {
  return props.mode === 'mail' ? <Mailbox data={props.data} /> : <ChatWorkspace data={props.data} />
}

function ChatCommunications({ mode, data }: { mode: 'chat' | 'mail'; data: Workspace }) {
  const mail = mode === 'mail'
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [messages, setMessages] = useState<Message[]>([])
  const [folder, setFolder] = useState('')
  const [selected, setSelected] = useState('')
  const [query, setQuery] = useState('')
  const [body, setBody] = useState('')
  const [to, setTo] = useState('')
  const [subject, setSubject] = useState('')
  const [opened, setOpened] = useState<OpenedMail | null>(null)
  const [compose, setCompose] = useState(false)
  const [creating, setCreating] = useState(false)
  const [directory, setDirectory] = useState<DirectoryEmployee[]>([])
  const [participants, setParticipants] = useState<string[]>([])
  const [group, setGroup] = useState(false)
  const [conversationTitle, setConversationTitle] = useState('')
  const [hasMore, setHasMore] = useState(false)
  const [loadingOlder, setLoadingOlder] = useState(false)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [disabled, setDisabled] = useState(false)
  const [notice, setNotice] = useState('')
  const [draftId, setDraftId] = useState<string | null>(null)
  const sequence = useRef(0)
  const sendKey = useRef(crypto.randomUUID())
  const thread = useRef<HTMLDivElement>(null)

  const fail = useCallback((caught: unknown) => {
    const moduleKey = caught instanceof ApiError ? String(caught.details?.key ?? '') : ''
    if (caught instanceof ApiError && caught.isModuleUnavailable && ['chat.enabled', 'mail.enabled'].includes(moduleKey)) setDisabled(true)
    else setError(caught instanceof Error ? caught.message : 'Please try again.')
  }, [])

  const refresh = useCallback(async () => {
    const seq = ++sequence.current
    setLoading(true); setError('')
    try {
      if (mail) {
        const result = await request<{ folders: Folder[] }>('/mail/folders')
        if (seq !== sequence.current) return
        setFolders(result.folders)
        const current = folder || result.folders.find(item => item.role === 'inbox')?.id || result.folders[0]?.id || ''
        if (current) {
          setFolder(current)
          const list = await request<{ envelopes: Envelope[] }>(`/mail/messages?folderId=${current}&q=${encodeURIComponent(query)}`)
          if (seq === sequence.current) setEnvelopes(list.envelopes)
        }
      } else {
        const result = await request<{ conversations: Conversation[] }>('/chat/conversations')
        if (seq === sequence.current) setConversations(result.conversations)
      }
    } catch (caught) { if (seq === sequence.current) fail(caught) }
    finally { if (seq === sequence.current) setLoading(false) }
  }, [mail, folder, query, fail])

  const loadConversation = useCallback(async (id: string) => {
    const result = await request<{ messages: Message[]; hasMore: boolean }>(`/chat/conversations/${id}/messages`)
    setMessages(result.messages); setHasMore(result.hasMore)
    const highest = result.messages.at(-1)?.id
    if (highest) requestAnimationFrame(() => {
      void request(`/chat/conversations/${id}/read`, { upToMessageId: highest })
        .then(() => setConversations(items => items.map(item => item.id === id ? { ...item, unread: 0 } : item)))
        .catch(fail)
    })
  }, [fail])

  const loadOlder = useCallback(async () => {
    const beforeId = messages[0]?.id
    if (!selected || !beforeId || !hasMore || loadingOlder) return
    setLoadingOlder(true)
    const element = thread.current
    const oldHeight = element?.scrollHeight ?? 0
    try {
      const result = await request<{ messages: Message[]; hasMore: boolean }>(`/chat/conversations/${selected}/messages?beforeId=${beforeId}`)
      setMessages(current => [...result.messages, ...current]); setHasMore(result.hasMore)
      requestAnimationFrame(() => { if (element) element.scrollTop = element.scrollHeight - oldHeight })
    } catch (caught) { fail(caught) } finally { setLoadingOlder(false) }
  }, [messages, selected, hasMore, loadingOlder, fail])

  useEffect(() => { void refresh(); return () => { sequence.current++ } }, [refresh])
  useEffect(() => {
    if (mail) {
      const stopDelivered = on('mail.delivered', () => void refresh())
      const stopReceived = on('mail.received', () => {
        // refresh() always updates the folder rail and reloads the active folder.
        // The event is user-scoped server-side, so no account filtering is needed here.
        void refresh()
      })
      return () => { stopDelivered(); stopReceived() }
    }
    const stopConversation = on('chat.conversation', () => void refresh())
    const stopMessage = on('chat.message', () => void refresh())
    return () => { stopConversation(); stopMessage() }
  }, [mail, refresh])
  useEffect(() => {
    if (mail || !selected) return
    let active = true
    void loadConversation(selected).catch(fail)
    const unsubscribe = on('chat.message', event => {
      if (active && event.data.conversationId === selected) void loadConversation(selected).catch(fail)
    })
    return () => { active = false; unsubscribe() }
  }, [selected, mail, loadConversation, fail])

  const openMail = async (item: Envelope) => {
    setSelected(item.id); setCompose(false); setOpened(null)
    try { setOpened(await request(`/mail/messages/${item.id}`)); void refresh() } catch (caught) { fail(caught) }
  }
  const saveDraft = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      const saved = await request<{ id: string }>('/mail/drafts', { to: to.split(',').map(value => value.trim()).filter(Boolean), subject, bodyHtml: escapeHtml(body), draftId: draftId ?? undefined })
      setDraftId(saved.id); setNotice('Draft saved. It will be removed automatically when sent.'); void refresh()
    } catch (caught) { fail(caught) } finally { setBusy(false) }
  }
  const send = async () => {
    if (busy) return
    setBusy(true); setError('')
    try {
      if (mail) {
        const result = await request<{ deliveredTo: string[]; queuedFor: string[] }>('/mail/messages', {
          to: to.split(',').map(value => value.trim()).filter(Boolean), subject, bodyHtml: escapeHtml(body), idempotencyKey: sendKey.current, draftId: draftId ?? undefined,
        })
        setNotice(`Sent to ${result.deliveredTo.length} colleague${result.deliveredTo.length === 1 ? '' : 's'}${result.queuedFor.length ? `; ${result.queuedFor.length} queued for external delivery` : ''}.`)
        setCompose(false); setTo(''); setSubject(''); setDraftId(null)
      } else {
        await request(`/chat/conversations/${selected}/messages`, { body, clientMessageId: sendKey.current })
        setNotice('Message sent.'); await loadConversation(selected)
      }
      sendKey.current = crypto.randomUUID(); setBody(''); void refresh()
    } catch (caught) { fail(caught) } finally { setBusy(false) }
  }
  const beginConversation = async () => {
    setCreating(true); setSelected(''); setError('')
    try {
      const result = await request<{ employees: DirectoryEmployee[] }>('/employees?limit=200')
      setDirectory(result.employees.filter(employee => employee.user_id && employee.user_id !== data.user.id))
    } catch (caught) { fail(caught) }
  }
  const createConversation = async () => {
    setBusy(true); setError('')
    try {
      const result = await request<{ id: string }>('/chat/conversations', { kind: group ? 'group' : 'dm', title: group ? conversationTitle : undefined, participantUserIds: participants })
      setCreating(false); setParticipants([]); setConversationTitle(''); setSelected(result.id); void refresh()
    } catch (caught) { fail(caught) } finally { setBusy(false) }
  }

  const current = conversations.find(conversation => conversation.id === selected)
  return <section className="comms-page">
    <header className="comms-heading"><div><span className="comms-eyebrow">PEPL CONNECT</span><h1>{mail ? 'Mailbox' : 'Team chat'}</h1><p>{mail ? 'A calmer home for your work conversations.' : 'Keep your people and conversations close.'}</p></div><button className="btn secondary" onClick={() => void refresh()} aria-label="Refresh conversations"><RefreshCw size={16} /></button></header>
    {error && <p role="alert" className="comms-error">{error}</p>}{notice && <p role="status" aria-live="polite">{notice}</p>}
    <div className={`comms-shell ${selected || compose || creating ? 'has-selection' : ''}`}>
      <aside className="comms-sidebar"><div className="comms-account"><span>{mail ? <Mail /> : <MessageCircle />}</span><div><strong>{data.user.full_name}</strong><small>{data.user.email}</small></div></div>
        <button className="btn primary" disabled={disabled || loading} onClick={() => mail ? (setCompose(true), setSelected(''), setOpened(null)) : void beginConversation()}>{mail ? <PenLine size={16} /> : <Users size={16} />}{mail ? 'Compose mail' : 'New conversation'}</button>
        <label className="comms-search"><span>{mail ? 'Search mailbox' : 'Find a conversation'}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search…" disabled={disabled} /></label>
        {mail ? <nav aria-label="Mail folders">{folders.map(item => <button key={item.id} className={folder === item.id ? 'active' : ''} onClick={() => { setFolder(item.id); setSelected(''); setOpened(null); setCompose(false) }}><Inbox size={16} />{item.name}<small>{item.unread || ''}</small></button>)}</nav> : <div className="comms-conversations">{conversations.filter(conversation => (conversation.title ?? 'Direct message').toLowerCase().includes(query.toLowerCase())).map(conversation => <button key={conversation.id} className={selected === conversation.id ? 'active' : ''} onClick={() => { setSelected(conversation.id); setMessages([]); setCreating(false) }}><strong>{conversation.title || 'Direct message'}</strong><small>{conversation.last_message_body || 'Start the conversation'}</small>{conversation.unread > 0 && <b>{conversation.unread}</b>}</button>)}</div>}
        <div className="comms-sidebar-note">{mail ? 'Your mailbox, thoughtfully organised.' : 'A shared space for better teamwork.'}</div>
      </aside>
      <div className="comms-main">
        {(selected || compose || creating) && <button className="btn ghost comms-back" onClick={() => { setSelected(''); setCompose(false); setCreating(false); setOpened(null) }}><ArrowLeft size={15} />Back</button>}
        {disabled ? <div className="comms-empty"><span>{mail ? <Mail size={36} /> : <MessageCircle size={36} />}</span><h2>{mail ? 'Your mailbox is ready for setup' : 'Bring your team together'}</h2><p>{mail ? 'Mail' : 'Chat'} is switched off for this company. An administrator can enable it in Settings.</p>{data.permissions.includes('settings.write') && <a className="btn primary" href="#/settings">Open settings</a>}</div>
          : creating ? <form className="comms-compose" onSubmit={event => { event.preventDefault(); void createConversation() }}><h2>Start a conversation</h2><label>Conversation type<select value={group ? 'group' : 'dm'} onChange={event => { setGroup(event.target.value === 'group'); setParticipants([]) }}><option value="dm">Direct message</option><option value="group">Group</option></select></label>{group && <label>Group name<input required value={conversationTitle} onChange={event => setConversationTitle(event.target.value)} /></label>}<fieldset className="participant-picker"><legend>Choose {group ? 'colleagues' : 'a colleague'}</legend>{directory.map(employee => <label key={employee.user_id}><input type={group ? 'checkbox' : 'radio'} name="participant" checked={participants.includes(employee.user_id!)} onChange={() => setParticipants(currentParticipants => group ? currentParticipants.includes(employee.user_id!) ? currentParticipants.filter(id => id !== employee.user_id) : [...currentParticipants, employee.user_id!] : [employee.user_id!])} /><span>{fullName(employee)}</span><small>{employee.designation ?? employee.department ?? 'Employee'}</small></label>)}</fieldset><footer><button className="btn primary" disabled={busy || participants.length === 0}><MessageCircle size={16} />Create conversation</button></footer></form>
          : compose ? <form className="comms-compose" onSubmit={event => { event.preventDefault(); void send() }}><h2>{draftId ? 'Continue draft' : 'New message'}</h2><label>To<input required value={to} onChange={event => setTo(event.target.value)} placeholder="name@company.com, colleague@company.com" /></label><label>Subject<input required value={subject} onChange={event => setSubject(event.target.value)} /></label><label className="comms-body-label">Message<textarea required value={body} onChange={event => setBody(event.target.value)} placeholder="Write something thoughtful…" /></label><footer><button className="btn secondary" type="button" disabled={busy} onClick={() => void saveDraft()}>Save draft</button><button className="btn primary" disabled={busy}><Send size={16} />{busy ? 'Saving…' : 'Send mail'}</button></footer></form>
          : mail && opened ? <article className="comms-reader"><h2>{opened.envelope.subject || '(No subject)'}</h2><p>{opened.envelope.from_name || opened.envelope.from_address}</p><time>{new Date(opened.envelope.received_at).toLocaleString()}</time><div>{opened.body_text ?? htmlText(opened.body_html ?? '')}</div></article>
          : mail && envelopes.length ? <div className="comms-mail-list">{envelopes.map(item => <button key={item.id} onClick={() => void openMail(item)} className={item.is_seen ? '' : 'unread'}><span className="comms-letter">{(item.from_name || item.from_address || 'M')[0]}</span><div><strong>{item.subject || '(No subject)'}</strong><small>{item.from_name || item.from_address}</small><p>{item.preview}</p></div><time>{new Date(item.received_at).toLocaleDateString()}</time></button>)}</div>
          : !mail && selected ? <div className="comms-thread"><h2>{current?.title || 'Direct message'}</h2><div className="comms-messages" ref={thread} onScroll={event => { if (event.currentTarget.scrollTop < 20) void loadOlder() }}>{hasMore && <button className="load-older" disabled={loadingOlder} onClick={() => void loadOlder()}>{loadingOlder ? 'Loading…' : 'Load earlier messages'}</button>}{messages.map(message => <article key={message.id} className={message.sender_user_id === data.user.id ? 'own' : ''}><p>{message.deleted_at ? <em>This message was deleted</em> : message.body}</p><time>{new Date(message.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{message.edited_at && ' · edited'}</time></article>)}</div><form onSubmit={event => { event.preventDefault(); void send() }}><textarea aria-label="Message" required value={body} onChange={event => setBody(event.target.value)} placeholder="Write a message…" disabled={current?.is_readonly} /><button className="btn primary" disabled={busy || current?.is_readonly || !body.trim()}><Send size={16} />Send</button></form></div>
          : <div className="comms-empty"><span>{mail ? <Inbox size={36} /> : <MessageCircle size={36} />}</span><h2>{loading ? 'Loading your workspace…' : mail ? 'A little room to breathe' : 'Your conversations live here'}</h2><p>{loading ? 'Fetching your latest conversations.' : mail ? 'No messages in this folder. Compose a mail to start a conversation.' : 'Select a conversation or start a new one.'}</p></div>}
      </div>
    </div>
  </section>
}
