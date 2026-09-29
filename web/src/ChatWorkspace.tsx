import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Megaphone, MessageCircle, MoreHorizontal, RefreshCw, Send, Users, X } from 'lucide-react'
import { fullName, dateTimeLabel, timeLabel } from './api'
import { domainApi } from './domainApi'
import { on } from './live'
import { RichEditor } from './Mailbox'
import type { Employee, Workspace } from './types'
import { useDialogFocus } from './useDialogFocus'

type Conversation = { id: string; kind: 'dm' | 'group' | 'announcement'; title: string | null; last_message_body: string | null; unread: number; is_readonly: boolean }
type Message = { id: number; body: string | null; sender_user_id: string | null; sent_at: string; edited_at: string | null; deleted_at: string | null; content_type: string; hrms_ref: { announcementId?: string } | null }
type Announcement = { id: string; title: string; body_html: string; author_user_id: string | null; publish_at: string; expires_at: string | null; requires_acknowledgement: boolean; acknowledged_at: string | null; viewed_at: string | null; in_audience: boolean; delivered: number; acknowledged: number; message_id: number | null; conversation_id: string | null }
type DirectoryEmployee = Employee & { user_id?: string | null }
type Pending = { user_id: string; full_name: string | null; email: string; viewed_at: string | null }

export function ChatWorkspace({ data }: { data: Workspace }) {
  const [conversations, setConversations] = useState<Conversation[]>([]); const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [selected, setSelected] = useState(''); const [messages, setMessages] = useState<Message[]>([]); const [hasMore, setHasMore] = useState(false)
  const [creating, setCreating] = useState<'conversation' | 'announcement' | null>(null); const [directory, setDirectory] = useState<DirectoryEmployee[]>([])
  const [participants, setParticipants] = useState<string[]>([]); const [group, setGroup] = useState(false); const [title, setTitle] = useState(''); const [body, setBody] = useState('')
  const [announcementBody, setAnnouncementBody] = useState('<p><br></p>'); const [requiresAck, setRequiresAck] = useState(false); const [expiresAt, setExpiresAt] = useState(''); const [everyone, setEveryone] = useState(true)
  const [pending, setPending] = useState<Pending[] | null>(null); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('')
  // Hand-rolled dialog: keep Tab inside it and give focus back on close.
  const dialogRef = useDialogFocus<HTMLElement>(Boolean(pending), () => setPending(null))
  const thread = useRef<HTMLDivElement>(null); const sendKey = useRef(crypto.randomUUID())
  const current = conversations.find(item => item.id === selected)
  const announcementChannel = conversations.find(item => item.kind === 'announcement')

  const fail = (caught: unknown) => setError(caught instanceof Error ? caught.message : 'Please try again.')
  const refresh = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [chat, news] = await Promise.all([
        domainApi<{ conversations: Conversation[] }>('/chat/conversations'),
        data.permissions.includes('announcement.read') ? domainApi<{ announcements: Announcement[] }>('/announcements') : Promise.resolve({ announcements: [] }),
      ])
      const ordered = [...chat.conversations].sort((a, b) => Number(b.kind === 'announcement') - Number(a.kind === 'announcement'))
      setConversations(ordered); setAnnouncements(news.announcements)
      if (!selected && location.hash.includes('/chat/announcements')) setSelected(ordered.find(item => item.kind === 'announcement')?.id ?? '')
    } catch (caught) { fail(caught) } finally { setLoading(false) }
  }, [data.permissions, selected])
  const loadMessages = useCallback(async (id: string) => {
    try {
      const result = await domainApi<{ messages: Message[]; hasMore: boolean }>(`/chat/conversations/${id}/messages`)
      setMessages(result.messages); setHasMore(result.hasMore)
      const highest = result.messages.at(-1)?.id
      if (highest) void domainApi(`/chat/conversations/${id}/read`, { upToMessageId: highest }).then(() => setConversations(items => items.map(item => item.id === id ? { ...item, unread: 0 } : item))).catch(fail)
    } catch (caught) { fail(caught) }
  }, [])
  useEffect(() => { void refresh() }, [refresh])
  useEffect(() => { if (selected) void loadMessages(selected) }, [selected, loadMessages])
  useEffect(() => {
    const update = () => { void refresh(); if (selected) void loadMessages(selected) }
    const stops = [on('chat.message', update), on('chat.conversation', update), on('announcement.published', update), on('announcement.withdrawn', update)]
    return () => stops.forEach(stop => stop())
  }, [refresh, loadMessages, selected])

  const getDirectory = async () => { if (directory.length) return; try { setDirectory((await domainApi<{ employees: DirectoryEmployee[] }>('/employees?limit=200')).employees.filter(employee => employee.user_id && employee.user_id !== data.user.id)) } catch (caught) { fail(caught) } }
  const start = (kind: 'conversation' | 'announcement') => { setCreating(kind); setSelected(''); setTitle(''); setParticipants([]); setError(''); void getDirectory() }
  const createConversation = async () => {
    setBusy(true)
    try { const result = await domainApi<{ id: string }>('/chat/conversations', { kind: group ? 'group' : 'dm', title: group ? title : undefined, participantUserIds: participants }); setCreating(null); setSelected(result.id); await refresh() } catch (caught) { fail(caught) } finally { setBusy(false) }
  }
  const createAnnouncement = async () => {
    setBusy(true)
    try {
      const result = await domainApi<Announcement>('/announcements', { title, bodyHtml: announcementBody, requiresAcknowledgement: requiresAck, expiresAt: expiresAt || null, ...(!everyone ? { audienceUserIds: participants } : {}) })
      setCreating(null); setSelected(result.conversation_id ?? announcementChannel?.id ?? ''); setNotice('Announcement published to Team chat.'); await refresh()
    } catch (caught) { fail(caught) } finally { setBusy(false) }
  }
  const send = async () => {
    if (!selected || !body.trim()) return
    setBusy(true)
    try { await domainApi(`/chat/conversations/${selected}/messages`, { body, clientMessageId: sendKey.current }); sendKey.current = crypto.randomUUID(); setBody(''); await loadMessages(selected); await refresh() } catch (caught) { fail(caught) } finally { setBusy(false) }
  }
  const loadOlder = async () => {
    const beforeId = messages[0]?.id; if (!beforeId || !selected || busy) return
    setBusy(true); const oldHeight = thread.current?.scrollHeight ?? 0
    try { const result = await domainApi<{ messages: Message[]; hasMore: boolean }>(`/chat/conversations/${selected}/messages?beforeId=${beforeId}`); setMessages(existing => [...result.messages, ...existing]); setHasMore(result.hasMore); requestAnimationFrame(() => { if (thread.current) thread.current.scrollTop = thread.current.scrollHeight - oldHeight }) } catch (caught) { fail(caught) } finally { setBusy(false) }
  }
  const acknowledge = async (id: string) => { setBusy(true); try { await domainApi(`/announcements/${id}/acknowledge`, {}); setAnnouncements(items => items.map(item => item.id === id ? { ...item, acknowledged_at: new Date().toISOString() } : item)); setNotice('Acknowledged. Thank you.') } catch (caught) { fail(caught) } finally { setBusy(false) } }
  const showPending = async (id: string) => { try { setPending((await domainApi<{ pending: Pending[] }>(`/announcements/${id}/pending`)).pending) } catch (caught) { fail(caught) } }
  const withdraw = async (id: string) => { const reason = window.prompt('Why are you withdrawing this announcement?'); if (!reason?.trim()) return; try { await domainApi(`/announcements/${id}/withdraw`, { reason }); setNotice('Announcement withdrawn.'); await refresh(); if (selected) await loadMessages(selected) } catch (caught) { fail(caught) } }

  return <section className="comms-page chat-workspace">
    <header className="comms-heading"><div><span className="comms-eyebrow">PEPL CONNECT</span><h1>Team chat</h1><p>Messages and company announcements in one place.</p></div><button className="btn secondary" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</button></header>
    {error && <p className="comms-error" role="alert">{error}</p>}{notice && <p role="status" aria-live="polite" className="success-note">{notice}</p>}
    <div className={`comms-shell ${selected || creating ? 'has-selection' : ''}`}>
      <aside className="comms-sidebar"><div className="comms-account"><span><MessageCircle /></span><div><strong>{data.user.full_name}</strong><small>{data.user.email}</small></div></div>
        <button className="btn primary" onClick={() => start('conversation')}><Users size={16} />New conversation</button>
        <div className="comms-conversations">{conversations.map(item => <button key={item.id} className={`${selected === item.id ? 'active' : ''} ${item.kind === 'announcement' ? 'announcement-channel' : ''}`} onClick={() => { setSelected(item.id); setCreating(null); setMessages([]) }}>{item.kind === 'announcement' && <Megaphone size={17} />}<span><strong>{item.title || 'Direct message'}</strong><small>{item.last_message_body || (item.kind === 'announcement' ? 'Company updates' : 'Start the conversation')}</small></span>{item.unread > 0 && <b>{item.unread}</b>}</button>)}</div>
        {data.permissions.includes('announcement.create') && <button className="comms-announcement-action" onClick={() => start('announcement')}><Megaphone size={15} />New announcement</button>}
      </aside>
      <main className="comms-main">
        {(selected || creating) && <button className="btn ghost comms-back" onClick={() => { setSelected(''); setCreating(null) }}><ArrowLeft size={15} />Back</button>}
        {creating === 'conversation' ? <form className="comms-compose" onSubmit={event => { event.preventDefault(); void createConversation() }}><h2>Start a conversation</h2><label>Conversation type<select value={group ? 'group' : 'dm'} onChange={event => { setGroup(event.target.value === 'group'); setParticipants([]) }}><option value="dm">Direct message</option><option value="group">Group</option></select></label>{group && <label>Group name<input required value={title} onChange={event => setTitle(event.target.value)} /></label>}<fieldset className="participant-picker"><legend>Choose {group ? 'colleagues' : 'a colleague'}</legend>{directory.map(employee => <label key={employee.user_id}><input type={group ? 'checkbox' : 'radio'} name="participant" checked={participants.includes(employee.user_id!)} onChange={() => setParticipants(currentParticipants => group ? currentParticipants.includes(employee.user_id!) ? currentParticipants.filter(id => id !== employee.user_id) : [...currentParticipants, employee.user_id!] : [employee.user_id!])} /><span>{fullName(employee)}</span><small>{employee.designation ?? employee.department ?? 'Employee'}</small></label>)}</fieldset><footer><button className="btn primary" disabled={busy || !participants.length}>Create conversation</button></footer></form>
        : creating === 'announcement' ? <form className="announcement-composer" onSubmit={event => { event.preventDefault(); void createAnnouncement() }}><header><div><span>COMPANY UPDATE</span><h2>New announcement</h2></div><Megaphone size={25} /></header><label>Title<input required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} placeholder="What should everyone know?" /></label><div><span className="field-label">Message</span><RichEditor html={announcementBody} onChange={setAnnouncementBody} /></div><div className="announcement-options"><label><input type="checkbox" checked={requiresAck} onChange={event => setRequiresAck(event.target.checked)} />Requires acknowledgement</label><label>Expires on<input type="date" value={expiresAt} onChange={event => setExpiresAt(event.target.value)} /></label><label>Audience<select value={everyone ? 'all' : 'selected'} onChange={event => setEveryone(event.target.value === 'all')}><option value="all">Everyone</option><option value="selected">Choose people</option></select></label></div>{!everyone && <fieldset className="participant-picker"><legend>People receiving this announcement</legend>{directory.map(employee => <label key={employee.user_id}><input type="checkbox" checked={participants.includes(employee.user_id!)} onChange={() => setParticipants(current => current.includes(employee.user_id!) ? current.filter(id => id !== employee.user_id) : [...current, employee.user_id!])} /><span>{fullName(employee)}</span><small>{employee.department ?? 'Employee'}</small></label>)}</fieldset>}<footer><button type="button" className="btn secondary" onClick={() => setCreating(null)}>Cancel</button><button className="btn primary" disabled={busy || !title.trim() || (!everyone && !participants.length)}><Megaphone size={16} />Publish announcement</button></footer></form>
        : selected ? <div className="comms-thread"><h2>{current?.kind === 'announcement' ? <><Megaphone size={19} />Announcements</> : current?.title || 'Direct message'}</h2><div className="comms-messages" ref={thread} onScroll={event => { if (event.currentTarget.scrollTop < 20 && hasMore) void loadOlder() }}>{hasMore && <button className="load-older" disabled={busy} onClick={() => void loadOlder()}>Load earlier messages</button>}{messages.map(message => {
          const news = message.content_type === 'announcement' ? announcements.find(item => item.id === message.hrms_ref?.announcementId) : undefined
          return news ? <article className="announcement-card" key={message.id}><header><span><Megaphone size={17} /></span><div><small>ANNOUNCEMENT</small><h3>{news.title}</h3><time>{dateTimeLabel(news.publish_at)}</time></div>{news.author_user_id === data.user.id && <button aria-label="Announcement actions" onClick={() => void withdraw(news.id)}><MoreHorizontal size={17} /></button>}</header><iframe title={news.title} sandbox="" srcDoc={news.body_html} /><footer>{news.requires_acknowledgement && news.in_audience ? news.acknowledged_at ? <span className="acknowledged"><Check size={15} />Acknowledged {dateTimeLabel(news.acknowledged_at)}</span> : <button className="btn primary" disabled={busy} onClick={() => void acknowledge(news.id)}>Acknowledge</button> : <span>Shared for your information</span>}{news.author_user_id === data.user.id && <button className="announcement-stat" onClick={() => void showPending(news.id)}>{news.acknowledged}/{news.delivered} acknowledged</button>}</footer></article> : <article key={message.id} className={message.sender_user_id === data.user.id ? 'own' : ''}><p>{message.deleted_at ? <em>This message was deleted</em> : message.body}</p><time>{timeLabel(message.sent_at)}{message.edited_at && ' · edited'}</time></article>
        })}</div>{current?.kind === 'announcement' ? <div className="readonly-channel">{data.permissions.includes('announcement.create') ? <button className="btn primary" onClick={() => start('announcement')}><Megaphone size={16} />New announcement</button> : <><Megaphone size={17} /><span>Only HR can post in this channel.</span></>}</div> : <form onSubmit={event => { event.preventDefault(); void send() }}><textarea aria-label="Message" required value={body} onChange={event => setBody(event.target.value)} placeholder="Write a message…" /><button className="btn primary" disabled={busy || !body.trim()}><Send size={16} />Send</button></form>}</div>
        : <div className="comms-empty"><span><MessageCircle size={36} /></span><h2>{loading ? 'Loading conversations…' : 'Your conversations live here'}</h2><p>Select a conversation, or start a new one.</p></div>}
      </main>
    </div>
    {pending && <div className="mail-modal-backdrop"><section ref={dialogRef} className="mail-modal" role="dialog" aria-modal="true" aria-labelledby="pending-title"><header><div><span>FOLLOW UP</span><h2 id="pending-title">Awaiting acknowledgement</h2></div><button className="mail-icon-button" onClick={() => setPending(null)} aria-label="Close"><X size={17} /></button></header>{pending.length ? <div className="pending-list">{pending.map(person => <article key={person.user_id}><strong>{person.full_name || person.email}</strong><small>{person.email} · {person.viewed_at ? 'Viewed' : 'Not viewed'}</small></article>)}</div> : <p className="success-note">Everyone has acknowledged.</p>}</section></div>}
  </section>
}
