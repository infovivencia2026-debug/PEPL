import { useCallback, useEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react'
import {
  Archive, ArrowLeft, Bold, Check, ChevronDown, Forward, Inbox, Italic, Link2, List,
  ListOrdered, Mail, MailOpen, Menu, MoreHorizontal, Paperclip, PenLine, Plus,
  Quote, Redo2, Reply, ReplyAll, Search, Send, Settings, Star, Trash2, Underline,
  Upload, X,
} from 'lucide-react'
import { ApiError, dateTimeLabel } from './api'
import { decodeBase64, domainApi, downloadFile } from './domainApi'
import { on } from './live'
import type { Workspace } from './types'
import { useDialogFocus } from './useDialogFocus'
import { PasswordInput } from './ui'

type Folder = { id: string; name: string; unread: number; role: string | null }
type Envelope = {
  id: string; folder_id: string; source: string; thread_key: string | null
  from_name: string | null; from_address: string | null; to_addresses: string[]
  cc_addresses: string[]; bcc_addresses: string[]; message_id: string | null
  in_reply_to: string | null; subject: string | null; preview: string | null
  sent_at: string | null; received_at: string; is_seen: boolean; is_flagged: boolean
  is_answered: boolean; is_draft: boolean; has_attachment: boolean
  attachment_document_ids: string[]
}
type Attachment = {
  document_id: string; file_name: string; content_type: string; size_bytes: number
  is_inline: boolean; content_id: string | null; url: string
}
type Opened = { envelope: Envelope; body_html: string | null; body_text: string | null; attachments: Attachment[] }
type Suggestion = { email: string; name: string | null; source: 'colleague' | 'recent' }
type Uploaded = { documentId: string; fileName: string; contentType: string; sizeBytes: number }
type SettingsData = { signature_html: string | null; reply_to: string | null; display_name: string | null }
type MailAccount = { id: string; email: string; display_name: string | null; label: string | null; is_default: boolean; provider: string; status: string; last_error: string | null; imap_host: string | null; smtp_host: string | null }
type ComposePreset = {
  to?: string[]; cc?: string[]; bcc?: string[]; subject?: string; html?: string
  attachments?: Uploaded[]; inReplyTo?: string; threadKey?: string; draftId?: string
}

const request = domainApi
const standardOrder: Record<string, number> = { inbox: 0, starred: 1, sent: 2, drafts: 3, archive: 4, trash: 5 }
const unique = (values: string[]) => [...new Set(values.map(value => value.trim().toLowerCase()).filter(Boolean))]
const humanSize = (bytes: number) => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
const escapeText = (value: string) => value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!)
const replySubject = (subject: string | null) => /^re:/i.test(subject ?? '') ? subject ?? '' : `Re: ${subject ?? ''}`
const forwardSubject = (subject: string | null) => /^fwd:/i.test(subject ?? '') ? subject ?? '' : `Fwd: ${subject ?? ''}`
const quoteHtml = (message: Opened) => `<br><blockquote class="mail-quote"><p>On ${dateTimeLabel(message.envelope.received_at)}, ${escapeText(message.envelope.from_name || message.envelope.from_address || 'Sender')} wrote:</p>${message.body_html || `<pre>${escapeText(message.body_text ?? '')}</pre>`}</blockquote>`

function RecipientField({ label, value, onChange, accountId, autoFocus = false }: { label: string; value: string[]; onChange: (next: string[]) => void; accountId?: string; autoFocus?: boolean }) {
  const [input, setInput] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  useEffect(() => {
    if (input.trim().length < 2) { setSuggestions([]); return }
    const timer = window.setTimeout(() => {
      void request<{ suggestions: Suggestion[] }>(`/mail/recipients?q=${encodeURIComponent(input.trim())}${accountId ? `&accountId=${accountId}` : ''}`)
        .then(result => setSuggestions(result.suggestions.filter(item => !value.includes(item.email))))
        .catch(() => setSuggestions([]))
    }, 180)
    return () => window.clearTimeout(timer)
  }, [input, value, accountId])
  const add = (raw: string) => {
    const addresses = raw.split(/[,;\s]+/).map(item => item.trim()).filter(item => item.includes('@'))
    if (!addresses.length) return
    onChange(unique([...value, ...addresses])); setInput(''); setSuggestions([])
  }
  return <div className="mail-recipient-field">
    <span>{label}</span>
    <div className="mail-chip-input" onClick={event => event.currentTarget.querySelector('input')?.focus()}>
      {value.map(address => <span className="mail-address-chip" key={address}>{address}<button type="button" aria-label={`Remove ${address}`} onClick={() => onChange(value.filter(item => item !== address))}><X size={12} /></button></span>)}
      <input autoFocus={autoFocus} value={input} aria-label={`${label} recipient`} placeholder={value.length ? '' : 'Name or email'} onChange={event => setInput(event.target.value)} onBlur={() => window.setTimeout(() => setSuggestions([]), 150)} onKeyDown={event => {
        if (event.key === 'Enter' || event.key === ',' || event.key === ';') { event.preventDefault(); add(input) }
        if (event.key === 'Backspace' && !input && value.length) onChange(value.slice(0, -1))
      }} />
    </div>
    {suggestions.length > 0 && <div className="mail-suggestions" role="listbox">{suggestions.map(item => <button type="button" role="option" key={item.email} onMouseDown={event => { event.preventDefault(); add(item.email) }}><b>{item.name || item.email}</b><small>{item.name ? item.email : item.source === 'recent' ? 'Recent recipient' : ''}</small></button>)}</div>}
  </div>
}

function EditorToolbar({ editor }: { editor: RefObject<HTMLDivElement | null> }) {
  const command = (name: string, value?: string) => { editor.current?.focus(); document.execCommand(name, false, value) }
  const addLink = () => { const url = window.prompt('Link address'); if (url) command('createLink', url) }
  const addImage = (file?: File) => {
    if (!file || !file.type.startsWith('image/')) return
    const reader = new FileReader()
    reader.onload = () => command('insertImage', String(reader.result))
    reader.readAsDataURL(file)
  }
  return <div className="mail-editor-toolbar" aria-label="Formatting toolbar">
    <button type="button" title="Bold" onClick={() => command('bold')}><Bold size={15} /></button>
    <button type="button" title="Italic" onClick={() => command('italic')}><Italic size={15} /></button>
    <button type="button" title="Underline" onClick={() => command('underline')}><Underline size={15} /></button>
    <i />
    <button type="button" title="Heading" onClick={() => command('formatBlock', 'h2')}>H</button>
    <button type="button" title="Bulleted list" onClick={() => command('insertUnorderedList')}><List size={15} /></button>
    <button type="button" title="Numbered list" onClick={() => command('insertOrderedList')}><ListOrdered size={15} /></button>
    <button type="button" title="Quote" onClick={() => command('formatBlock', 'blockquote')}><Quote size={15} /></button>
    <button type="button" title="Link" onClick={addLink}><Link2 size={15} /></button>
    <select aria-label="Text colour" title="Text colour" defaultValue="" onChange={event => { if (event.target.value) command('foreColor', event.target.value); event.target.value = '' }}><option value="">A</option><option value="#163c37">Green</option><option value="#e75c43">Coral</option><option value="#111827">Black</option></select>
    <select aria-label="Alignment" title="Alignment" defaultValue="" onChange={event => { if (event.target.value) command(event.target.value); event.target.value = '' }}><option value="">Align</option><option value="justifyLeft">Left</option><option value="justifyCenter">Centre</option><option value="justifyRight">Right</option></select>
    <button type="button" title="Insert table" onClick={() => command('insertHTML', '<table><tbody><tr><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>')}>▦</button>
    <label className="mail-inline-image" title="Inline image"><Upload size={15} /><input type="file" accept="image/*" onChange={event => { addImage(event.target.files?.[0]); event.target.value = '' }} /></label>
  </div>
}

export function RichEditor({ html, onChange, compact = false }: { html: string; onChange: (html: string) => void; compact?: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { if (ref.current && ref.current.innerHTML !== html) ref.current.innerHTML = html }, [html])
  return <div className={`mail-editor ${compact ? 'compact' : ''}`}>
    <EditorToolbar editor={ref} />
    <div ref={ref} className="mail-editor-canvas" contentEditable suppressContentEditableWarning role="textbox" aria-multiline="true" aria-label="Message body" onInput={event => onChange(event.currentTarget.innerHTML)} />
  </div>
}

export function Mailbox({ data }: { data: Workspace }) {
  const disabled = !data.modules.mail
  const self = data.user.email.toLowerCase()
  const [folders, setFolders] = useState<Folder[]>([])
  const [accounts, setAccounts] = useState<MailAccount[]>([]); const [accountId, setAccountId] = useState(''); const [fromAccountId, setFromAccountId] = useState('')
  const [accountMenu, setAccountMenu] = useState(false); const [accountDialog, setAccountDialog] = useState<'add' | 'manage' | null>(null); const [accountTab, setAccountTab] = useState<'company' | 'external'>('company')
  const [accountUnread, setAccountUnread] = useState<Record<string, number>>({})
  const [accountForm, setAccountForm] = useState({ email: '', label: '', displayName: '', imapHost: '', imapPort: '993', imapSecure: true, smtpHost: '', smtpPort: '587', smtpSecure: false, username: '', password: '' })
  const [folderId, setFolderId] = useState('')
  const [envelopes, setEnvelopes] = useState<Envelope[]>([])
  const [opened, setOpened] = useState<Opened | null>(null)
  const [compose, setCompose] = useState(false)
  const [to, setTo] = useState<string[]>([]); const [cc, setCc] = useState<string[]>([]); const [bcc, setBcc] = useState<string[]>([])
  const [showCc, setShowCc] = useState(false); const [showBcc, setShowBcc] = useState(false)
  const [subject, setSubject] = useState(''); const [bodyHtml, setBodyHtml] = useState('')
  const [attachments, setAttachments] = useState<Uploaded[]>([])
  const [draftId, setDraftId] = useState<string>(); const [inReplyTo, setInReplyTo] = useState<string>(); const [threadKey, setThreadKey] = useState<string>()
  const [settingsData, setSettingsData] = useState<SettingsData>({ signature_html: null, reply_to: null, display_name: null })
  const [settingsOpen, setSettingsOpen] = useState(false); const [foldersOpen, setFoldersOpen] = useState(false)
  // Four hand-rolled dialogs. The shared Modal is a native <dialog> and gets
  // focus containment from the browser; these do not, so Tab used to leave the
  // dialog for the mail list behind it and Escape did nothing.
  const settingsRef = useDialogFocus<HTMLElement>(settingsOpen, () => setSettingsOpen(false))
  const foldersRef = useDialogFocus<HTMLElement>(foldersOpen, () => setFoldersOpen(false))
  const addRef = useDialogFocus<HTMLElement>(accountDialog === 'add', () => setAccountDialog(null))
  const manageRef = useDialogFocus<HTMLElement>(accountDialog === 'manage', () => setAccountDialog(null))
  const [selected, setSelected] = useState<string[]>([]); const [focusIndex, setFocusIndex] = useState(0)
  const [query, setQuery] = useState(''); const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false); const [notice, setNotice] = useState(''); const [error, setError] = useState('')
  const [folderName, setFolderName] = useState(''); const [editingFolder, setEditingFolder] = useState<Folder | null>(null)

  const presentError = (caught: unknown) => setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Please try again.')
  const currentFolder = folders.find(item => item.id === folderId)
  const currentAccount = accounts.find(item => item.id === accountId)
  const accountPath = (path: string, id = accountId) => `${path}${path.includes('?') ? '&' : '?'}accountId=${encodeURIComponent(id)}`
  const accountBody = <T extends Record<string, unknown>>(body: T, id = fromAccountId || accountId) => ({ ...body, accountId: id })
  const sortedFolders = [...folders].sort((a, b) => (a.role == null ? 20 : standardOrder[a.role] ?? 10) - (b.role == null ? 20 : standardOrder[b.role] ?? 10))

  const refresh = useCallback(async (preferredFolder?: string) => {
    if (disabled) { setLoading(false); return }
    try {
      if (!accountId) return
      const folderResult = await request<{ folders: Folder[] }>(accountPath('/mail/folders'))
      setFolders(folderResult.folders)
      const nextFolder = preferredFolder || (folderResult.folders.some(item => item.id === folderId) ? folderId : '') || folderResult.folders.find(item => item.role === 'inbox')?.id || folderResult.folders[0]?.id || ''
      if (nextFolder !== folderId) setFolderId(nextFolder)
      if (nextFolder) {
        const list = await request<{ envelopes: Envelope[] }>(accountPath(`/mail/messages?folderId=${encodeURIComponent(nextFolder)}${query ? `&q=${encodeURIComponent(query)}` : ''}`))
        setEnvelopes(list.envelopes); setSelected(current => current.filter(id => list.envelopes.some(item => item.id === id)))
      }
    } catch (caught) { presentError(caught) } finally { setLoading(false) }
  }, [disabled, folderId, query, accountId])

  useEffect(() => {
    if (disabled) { setLoading(false); return }
    void request<{ accounts: MailAccount[] }>('/mail/accounts').then(result => {
      setAccounts(result.accounts)
      const remembered = localStorage.getItem('pepl.mail.account')
      const chosen = result.accounts.find(item => item.id === remembered) ?? result.accounts.find(item => item.is_default) ?? result.accounts[0]
      if (chosen) { setAccountId(chosen.id); setFromAccountId(chosen.id) }
    }).catch(presentError)
  }, [disabled])
  useEffect(() => {
    if (!accountId) return
    localStorage.setItem('pepl.mail.account', accountId); setFolderId(''); setOpened(null); setCompose(false)
    void Promise.all([refresh(), request<SettingsData>(accountPath('/mail/settings')).then(setSettingsData).catch(presentError)])
  // refresh is called for the account boundary only; search has its own effect
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountId])
  useEffect(() => { if (!disabled && folderId) { const timer = window.setTimeout(() => void refresh(), 250); return () => window.clearTimeout(timer) } }, [query, folderId, disabled, refresh])
  useEffect(() => {
    if (disabled) return
    const update = () => void refresh()
    const stopReceived = on('mail.received', update); const stopDelivered = on('mail.delivered', update)
    return () => { stopReceived(); stopDelivered() }
  }, [disabled, refresh])

  const signature = settingsData.signature_html || ''
  const resetCompose = (preset: ComposePreset = {}) => {
    setFromAccountId(accountId)
    setTo(preset.to ?? []); setCc(preset.cc ?? []); setBcc(preset.bcc ?? [])
    setShowCc(Boolean(preset.cc?.length)); setShowBcc(Boolean(preset.bcc?.length))
    setSubject(preset.subject ?? ''); setBodyHtml(preset.html ?? `<p><br></p>${signature}`)
    setAttachments(preset.attachments ?? []); setDraftId(preset.draftId); setInReplyTo(preset.inReplyTo); setThreadKey(preset.threadKey)
    setOpened(null); setCompose(true); setDirty(false); setError(''); setNotice('')
  }
  const composeChange = <T,>(setter: Dispatch<SetStateAction<T>>, value: T) => { setter(value); setDirty(true) }

  const openMessage = async (item: Envelope) => {
    setCompose(false); setBusy(true); setError('')
    try {
      const result = await request<Opened>(accountPath(`/mail/messages/${item.id}`))
      if (result.envelope.is_draft) {
        resetCompose({ to: result.envelope.to_addresses, cc: result.envelope.cc_addresses, bcc: result.envelope.bcc_addresses, subject: result.envelope.subject ?? '', html: result.body_html ?? '', attachments: result.attachments.filter(file => !file.is_inline).map(file => ({ documentId: file.document_id, fileName: file.file_name, contentType: file.content_type, sizeBytes: file.size_bytes })), draftId: result.envelope.id, inReplyTo: result.envelope.in_reply_to ?? undefined, threadKey: result.envelope.thread_key ?? undefined })
      } else {
        setOpened(result)
        setEnvelopes(current => current.map(row => row.id === item.id ? { ...row, is_seen: true } : row))
        if (!item.is_seen) setFolders(current => current.map(folder => folder.id === item.folder_id ? { ...folder, unread: Math.max(0, folder.unread - 1) } : folder))
      }
    } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }

  const draftPayload = () => accountBody({ to, cc, bcc, subject, bodyHtml, draftId, inReplyTo, threadKey, attachmentDocumentIds: attachments.map(file => file.documentId) })
  const saveDraft = useCallback(async (quiet = false) => {
    if (!compose || !dirty || busy) return
    try {
      const result = await request<{ id: string }>('/mail/drafts', draftPayload())
      setDraftId(result.id); setDirty(false); if (!quiet) setNotice('Draft saved')
    } catch (caught) { presentError(caught) }
  // draftPayload reflects live composer state
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compose, dirty, busy, to, cc, bcc, subject, bodyHtml, draftId, inReplyTo, threadKey, attachments, fromAccountId, accountId])
  useEffect(() => { if (!compose || !dirty) return; const timer = window.setTimeout(() => void saveDraft(true), 10_000); return () => window.clearTimeout(timer) }, [compose, dirty, saveDraft])

  const uploadAttachment = async (file?: File) => {
    if (!file) return
    if (file.size > 10 * 1024 * 1024) { setError('Attachments can be up to 10 MB.'); return }
    setBusy(true); setError('')
    try {
      const base64 = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] ?? ''); reader.onerror = reject; reader.readAsDataURL(file) })
      const result = await request<Uploaded>('/mail/attachments', accountBody({ fileName: file.name, contentType: file.type || 'application/octet-stream', contentBase64: base64 }))
      setAttachments(current => [...current, result]); setDirty(true)
    } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }
  const send = async () => {
    if (!to.length) { setError('Add at least one recipient.'); return }
    setBusy(true); setError('')
    try {
      const result = await request<{ deliveredTo: string[]; queuedFor: string[] }>('/mail/messages', { ...draftPayload(), idempotencyKey: crypto.randomUUID() })
      const parts = []
      if (result.deliveredTo.length) parts.push(`Delivered to ${result.deliveredTo.length}`)
      if (result.queuedFor.length) parts.push(`Queued for ${result.queuedFor.length}`)
      setNotice(parts.join(' · ') || 'Message sent'); setCompose(false); setDirty(false); await refresh()
    } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }

  const reply = (kind: 'reply' | 'reply-all' | 'forward') => {
    if (!opened) return
    const envelope = opened.envelope
    const quote = quoteHtml(opened)
    if (kind === 'forward') {
      resetCompose({ subject: forwardSubject(envelope.subject), html: `<p><br></p>${signature}<hr><p><b>Forwarded message</b><br>From: ${escapeText(envelope.from_name || envelope.from_address || '')}<br>Date: ${dateTimeLabel(envelope.received_at)}<br>Subject: ${escapeText(envelope.subject ?? '')}</p>${opened.body_html || `<pre>${escapeText(opened.body_text ?? '')}</pre>`}`, attachments: opened.attachments.filter(file => !file.is_inline).map(file => ({ documentId: file.document_id, fileName: file.file_name, contentType: file.content_type, sizeBytes: file.size_bytes })) })
      return
    }
    const sender = envelope.from_address ? [envelope.from_address] : []
    const ownAddress = (accounts.find(item => item.id === accountId)?.email ?? self).toLowerCase()
    const everyone = kind === 'reply-all' ? unique([...envelope.to_addresses, ...envelope.cc_addresses]).filter(address => address !== ownAddress && !sender.includes(address)) : []
    resetCompose({ to: sender, cc: everyone, subject: replySubject(envelope.subject), html: `<p><br></p>${signature}${quote}`, inReplyTo: envelope.message_id ?? envelope.id, threadKey: envelope.thread_key ?? undefined })
  }

  const bulk = async (payload: { action: 'flag'; flag: 'seen' | 'unseen' | 'flagged' | 'unflagged' } | { action: 'move'; folderId: string } | { action: 'delete' }) => {
    if (!selected.length) return
    setBusy(true)
    try { await request('/mail/messages/bulk', accountBody({ ids: selected, ...payload }, accountId)); setSelected([]); await refresh() } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }
  const download = async (file: Attachment) => {
    try { const result = await request<{ fileName: string; contentType: string; contentBase64: string }>(accountPath(file.url.replace(/^\/api\/v1/, ''))); downloadFile(result.fileName, result.contentType, decodeBase64(result.contentBase64)) } catch (caught) { presentError(caught) }
  }
  const saveSettings = async () => {
    setBusy(true)
    try { const result = await request<SettingsData>('/mail/settings', accountBody(settingsData as Record<string, unknown>, accountId), 'PATCH'); setSettingsData(result); setSettingsOpen(false); setNotice('Mail settings saved') } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }
  const saveFolder = async () => {
    if (!folderName.trim()) return
    setBusy(true)
    try {
      if (editingFolder) await request(`/mail/folders/${editingFolder.id}`, accountBody({ name: folderName.trim() }, accountId), 'PATCH')
      else await request('/mail/folders', accountBody({ name: folderName.trim() }, accountId))
      setFolderName(''); setEditingFolder(null); await refresh()
    } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }
  const deleteFolder = async (folder: Folder) => {
    setBusy(true)
    try { await request(`/mail/folders/${folder.id}`, accountBody({}, accountId), 'DELETE'); setNotice(`${folder.name} deleted; its messages moved to Trash`); setEditingFolder(null); setFolderName(''); await refresh() } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }
  const reloadAccounts = async (switchTo?: string) => {
    const result = await request<{ accounts: MailAccount[] }>('/mail/accounts')
    setAccounts(result.accounts)
    if (switchTo && result.accounts.some(item => item.id === switchTo)) { setAccountId(switchTo); setFromAccountId(switchTo) }
  }
  const openAccountMenu = async () => {
    setAccountMenu(value => !value)
    if (accountMenu) return
    const counts = await Promise.all(accounts.map(async account => {
      try { const result = await request<{ folders: Folder[] }>(accountPath('/mail/folders', account.id)); return [account.id, result.folders.reduce((sum, folder) => sum + folder.unread, 0)] as const } catch { return [account.id, 0] as const }
    }))
    setAccountUnread(Object.fromEntries(counts))
  }
  const addAccount = async () => {
    setBusy(true); setError('')
    try {
      const body = accountTab === 'company' ? { email: accountForm.email, label: accountForm.label || undefined, displayName: accountForm.displayName || undefined } : { email: accountForm.email, label: accountForm.label || undefined, displayName: accountForm.displayName || undefined, imapHost: accountForm.imapHost, imapPort: Number(accountForm.imapPort), imapSecure: accountForm.imapSecure, smtpHost: accountForm.smtpHost, smtpPort: Number(accountForm.smtpPort), smtpSecure: accountForm.smtpSecure, username: accountForm.username, password: accountForm.password }
      const created = await request<MailAccount>('/mail/accounts', body)
      await reloadAccounts(created.id); setAccountDialog(null); setNotice(`${created.email} added.`)
      setAccountForm({ email: '', label: '', displayName: '', imapHost: '', imapPort: '993', imapSecure: true, smtpHost: '', smtpPort: '587', smtpSecure: false, username: '', password: '' })
    } catch (caught) { if (caught instanceof ApiError && caught.code === 'MAIL_KEY_MISSING') setError('External mailboxes are unavailable because the server mail key is missing. Ask your administrator to configure it.'); else presentError(caught) } finally { setBusy(false) }
  }
  const updateAccountDetails = async (account: MailAccount, form: HTMLFormElement) => {
    const values = new FormData(form); setBusy(true)
    try { await request(`/mail/accounts/${account.id}`, { label: String(values.get('label') ?? ''), displayName: String(values.get('displayName') ?? '') }, 'PATCH'); await reloadAccounts(); setNotice('Mailbox details saved.') } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }
  const makeDefault = async (account: MailAccount) => { setBusy(true); try { await request(`/mail/accounts/${account.id}`, { isDefault: true }, 'PATCH'); await reloadAccounts(); setNotice(`${account.email} is now your default mailbox.`) } catch (caught) { presentError(caught) } finally { setBusy(false) } }
  const removeAccount = async (account: MailAccount) => {
    if (!window.confirm(`Remove ${account.email}? Existing mail stays for retention, but this address stops receiving new messages.`)) return
    setBusy(true)
    try { await request(`/mail/accounts/${account.id}`, {}, 'DELETE'); await reloadAccounts(); if (account.id === accountId) { const fallback = accounts.find(item => item.id !== account.id && item.is_default) ?? accounts.find(item => item.id !== account.id); if (fallback) setAccountId(fallback.id) }; setNotice(`${account.email} removed.`) } catch (caught) { presentError(caught) } finally { setBusy(false) }
  }

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement).tagName
      if (compose || settingsOpen || foldersOpen || ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || (event.target as HTMLElement).isContentEditable) return
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault(); setFocusIndex(current => Math.max(0, Math.min(envelopes.length - 1, current + (event.key === 'j' ? 1 : -1))))
        window.requestAnimationFrame(() => document.querySelector(`[data-mail-index="${focusIndex + (event.key === 'j' ? 1 : -1)}"]`)?.scrollIntoView({ block: 'nearest' }))
      }
      const target = opened?.envelope ?? envelopes[focusIndex]
      if (event.key === 'e' && target) void bulkFor(target.id, { action: 'move', folderId: folders.find(folder => folder.role === 'archive')?.id ?? '' })
      if (event.key === '#' && target) { event.preventDefault(); void bulkFor(target.id, { action: 'delete' }) }
      if (event.key === 'r' && opened) { event.preventDefault(); reply('reply') }
    }
    const bulkFor = async (id: string, payload: { action: 'move'; folderId: string } | { action: 'delete' }) => { if (payload.action === 'move' && !payload.folderId) return; try { await request('/mail/messages/bulk', accountBody({ ids: [id], ...payload }, accountId)); setOpened(null); await refresh() } catch (caught) { presentError(caught) } }
    window.addEventListener('keydown', handle); return () => window.removeEventListener('keydown', handle)
  }, [compose, settingsOpen, foldersOpen, opened, envelopes, focusIndex, folders, refresh])

  if (disabled) return <section className="mail-disabled"><Mail size={38} /><h1>Mail is ready for setup</h1><p>An administrator can enable your company mailbox in Settings.</p>{data.permissions.includes('settings.write') && <a className="btn primary" href="#/settings">Open settings</a>}</section>

  return <section className={`mail-workspace ${opened || compose ? 'has-open' : ''}`}>
    <header className="mail-topbar">
      <div><span className="mail-kicker">PEPL MAIL</span><h1>{currentFolder?.name || 'Mailbox'}</h1></div>
      <label className="mail-search"><Search size={16} /><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search mail" aria-label="Search mail" /></label>
      <button className="mail-icon-button" onClick={() => setFoldersOpen(true)} aria-label="Manage folders"><Menu size={18} /></button>
      <button className="mail-icon-button" onClick={() => setSettingsOpen(true)} aria-label="Mail settings"><Settings size={18} /></button>
    </header>
    {(notice || error) && <div className={`mail-notice ${error ? 'error' : ''}`} role="status">{error || notice}<button onClick={() => { setNotice(''); setError('') }} aria-label="Dismiss"><X size={14} /></button></div>}
    <div className="mail-layout">
      <aside className="mail-folders">
        <div className="mail-account-switcher"><button aria-expanded={accountMenu} onClick={() => void openAccountMenu()}><span><b>{currentAccount?.label || currentAccount?.display_name || 'Mailbox'}</b><small>{currentAccount?.email || 'Loading…'}</small></span><ChevronDown size={15} /></button>{accountMenu && <div className="mail-account-menu">{accounts.map(account => <button key={account.id} className={account.id === accountId ? 'active' : ''} onClick={() => { setAccountId(account.id); setFromAccountId(account.id); setAccountMenu(false) }}><span><b>{account.label || account.display_name || account.email}</b><small>{account.email}</small></span>{accountUnread[account.id] ? <i>{accountUnread[account.id]}</i> : account.id === accountId ? <Check size={15} /> : null}</button>)}<hr /><button onClick={() => { setAccountDialog('add'); setAccountMenu(false) }}><Plus size={14} />Add mailbox…</button><button onClick={() => { setAccountDialog('manage'); setAccountMenu(false) }}><Settings size={14} />Manage mailboxes…</button></div>}</div>
        <button className="mail-compose-button" onClick={() => resetCompose()}><PenLine size={17} />Compose</button>
        <nav aria-label="Mail folders">{sortedFolders.map(folder => <button key={folder.id} className={folder.id === folderId ? 'active' : ''} onClick={() => { setFolderId(folder.id); setOpened(null); setCompose(false); setSelected([]); void refresh(folder.id) }}>{folder.role === 'trash' ? <Trash2 size={16} /> : folder.role === 'starred' ? <Star size={16} /> : folder.role === 'archive' ? <Archive size={16} /> : <Inbox size={16} />}<span>{folder.name}</span>{folder.unread > 0 && <b>{folder.unread}</b>}{!folder.role && <MoreHorizontal className="folder-more" size={15} onClick={event => { event.stopPropagation(); setEditingFolder(folder); setFolderName(folder.name); setFoldersOpen(true) }} />}</button>)}</nav>
        <button className="mail-add-folder" onClick={() => { setEditingFolder(null); setFolderName(''); setFoldersOpen(true) }}><Plus size={14} />New folder</button>
        <div className="mail-shortcuts"><b>Shortcuts</b><span><kbd>J</kbd><kbd>K</kbd> navigate</span><span><kbd>R</kbd> reply</span><span><kbd>E</kbd> archive</span><span><kbd>#</kbd> delete</span></div>
      </aside>
      <main className="mail-list-panel">
        <div className="mail-list-toolbar">
          <label><input type="checkbox" checked={Boolean(envelopes.length) && selected.length === envelopes.length} onChange={event => setSelected(event.target.checked ? envelopes.map(item => item.id) : [])} /><span className="sr-only">Select all messages</span></label>
          {selected.length ? <><b>{selected.length} selected</b><button title="Mark read" onClick={() => void bulk({ action: 'flag', flag: 'seen' })}><MailOpen size={16} /></button><button title="Mark unread" onClick={() => void bulk({ action: 'flag', flag: 'unseen' })}><Mail size={16} /></button><button title="Flag" onClick={() => void bulk({ action: 'flag', flag: 'flagged' })}><Star size={16} /></button><label className="mail-move-select"><Archive size={16} /><select aria-label="Move selected" defaultValue="" onChange={event => { if (event.target.value) void bulk({ action: 'move', folderId: event.target.value }); event.target.value = '' }}><option value="">Move</option>{folders.filter(item => item.id !== folderId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><button title="Delete" onClick={() => void bulk({ action: 'delete' })}><Trash2 size={16} /></button></> : <><span>{envelopes.length} messages</span><button title="Refresh" onClick={() => void refresh()}><Redo2 size={16} /></button></>}
        </div>
        <div className="mail-list" aria-busy={loading}>{loading ? <div className="mail-list-empty">Loading your mailbox…</div> : envelopes.length === 0 ? <div className="mail-list-empty"><Inbox size={30} /><b>This folder is clear</b><span>New messages will arrive here.</span></div> : envelopes.map((item, index) => <article data-mail-index={index} className={`mail-row ${!item.is_seen ? 'unread' : ''} ${opened?.envelope.id === item.id ? 'active' : ''} ${focusIndex === index ? 'keyboard-focus' : ''}`} key={item.id}>
          <label><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /><span className="sr-only">Select {item.subject || 'message'}</span></label>
          <button className={`mail-star ${item.is_flagged ? 'active' : ''}`} aria-label={item.is_flagged ? 'Unflag message' : 'Flag message'} onClick={() => void request(`/mail/messages/${item.id}/flag`, accountBody({ flag: item.is_flagged ? 'unflagged' : 'flagged' }, accountId)).then(() => refresh()).catch(presentError)}><Star size={15} fill={item.is_flagged ? 'currentColor' : 'none'} /></button>
          <button className="mail-row-open" onClick={() => { setFocusIndex(index); void openMessage(item) }}><span className="mail-row-sender">{item.from_name || item.from_address || (item.is_draft ? 'Draft' : 'Unknown sender')}</span><span className="mail-row-copy"><b>{item.subject || '(No subject)'}</b><small>{item.preview || 'No preview available'}</small></span>{item.has_attachment && <Paperclip size={14} />}<time>{new Date(item.received_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></button>
        </article>)}</div>
      </main>
      <section className="mail-detail">
        <button className="mail-mobile-back" onClick={() => { setOpened(null); setCompose(false) }}><ArrowLeft size={16} />Mailbox</button>
        {compose ? <form className="mail-composer" onSubmit={event => { event.preventDefault(); void send() }}>
          <header><div><span>{draftId ? 'DRAFT' : inReplyTo ? 'REPLY' : 'NEW MESSAGE'}</span><h2>{draftId ? 'Continue your draft' : inReplyTo ? 'Continue the conversation' : 'Write a message'}</h2></div><button type="button" className="mail-icon-button" onClick={() => { void saveDraft(true); setCompose(false) }} aria-label="Close composer"><X size={18} /></button></header>
          <label className="mail-from"><span>From</span><select value={fromAccountId} onChange={event => setFromAccountId(event.target.value)}>{accounts.map(account => <option key={account.id} value={account.id}>{account.label ? `${account.label} — ` : ''}{account.email}</option>)}</select></label>
          <RecipientField label="To" accountId={fromAccountId} value={to} onChange={value => composeChange(setTo, value)} autoFocus />
          <div className="mail-recipient-links"><button type="button" onClick={() => setShowCc(value => !value)}>Cc</button><button type="button" onClick={() => setShowBcc(value => !value)}>Bcc</button></div>
          {showCc && <RecipientField label="Cc" accountId={fromAccountId} value={cc} onChange={value => composeChange(setCc, value)} />}
          {showBcc && <RecipientField label="Bcc" accountId={fromAccountId} value={bcc} onChange={value => composeChange(setBcc, value)} />}
          <label className="mail-subject"><span>Subject</span><input value={subject} onChange={event => composeChange(setSubject, event.target.value)} placeholder="What is this about?" /></label>
          <RichEditor html={bodyHtml} onChange={value => composeChange(setBodyHtml, value)} />
          {attachments.length > 0 && <div className="mail-attachment-strip">{attachments.map(file => <span key={file.documentId}><Paperclip size={13} /><b>{file.fileName}</b><small>{humanSize(file.sizeBytes)}</small><button type="button" aria-label={`Remove ${file.fileName}`} onClick={() => { setAttachments(current => current.filter(item => item.documentId !== file.documentId)); setDirty(true) }}><X size={12} /></button></span>)}</div>}
          <footer><label className="mail-attach-button"><Paperclip size={16} />Attach<input type="file" onChange={event => { void uploadAttachment(event.target.files?.[0]); event.target.value = '' }} /></label><span className="mail-autosave">{dirty ? 'Saving automatically…' : draftId ? 'Draft saved' : ''}</span><button type="button" className="btn secondary" disabled={busy || !dirty} onClick={() => void saveDraft()}>Save draft</button><button className="btn primary" disabled={busy || !to.length}><Send size={16} />{busy ? 'Working…' : 'Send'}</button></footer>
        </form> : opened ? <article className="mail-reader">
          <header><div className="mail-reader-meta"><div className="mail-avatar">{(opened.envelope.from_name || opened.envelope.from_address || '?').slice(0, 1).toUpperCase()}</div><div><h2>{opened.envelope.subject || '(No subject)'}</h2><b>{opened.envelope.from_name || opened.envelope.from_address}</b><button className="mail-addresses" aria-label="Show recipient details">to {opened.envelope.to_addresses.length === 1 && opened.envelope.to_addresses[0] === self ? 'me' : opened.envelope.to_addresses.join(', ')} <ChevronDown size={12} /></button></div></div><div><time>{dateTimeLabel(opened.envelope.received_at)}</time><button className={`mail-star ${opened.envelope.is_flagged ? 'active' : ''}`} aria-label="Toggle flag" onClick={() => void request(`/mail/messages/${opened.envelope.id}/flag`, accountBody({ flag: opened.envelope.is_flagged ? 'unflagged' : 'flagged' }, accountId)).then(() => refresh()).catch(presentError)}><Star size={17} fill={opened.envelope.is_flagged ? 'currentColor' : 'none'} /></button></div></header>
          <div className="mail-reader-body">{opened.body_html ? <iframe title="Message content" sandbox="" srcDoc={opened.body_html} /> : <pre>{opened.body_text || 'This message has no body.'}</pre>}</div>
          {opened.attachments.filter(file => !file.is_inline).length > 0 && <div className="mail-reader-attachments"><b>{opened.attachments.filter(file => !file.is_inline).length} attachments</b>{opened.attachments.filter(file => !file.is_inline).map(file => <button key={file.document_id} onClick={() => void download(file)}><Paperclip size={15} /><span><b>{file.file_name}</b><small>{humanSize(file.size_bytes)}</small></span></button>)}</div>}
          <footer><button className="btn primary" onClick={() => reply('reply')}><Reply size={16} />Reply</button><button className="btn secondary" onClick={() => reply('reply-all')}><ReplyAll size={16} />Reply all</button><button className="btn secondary" onClick={() => reply('forward')}><Forward size={16} />Forward</button></footer>
        </article> : <div className="mail-detail-empty"><span><MailOpen size={32} /></span><h2>Your reading space</h2><p>Select a message to read it here, or compose something new.</p></div>}
      </section>
    </div>
    {settingsOpen && <div className="mail-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setSettingsOpen(false) }}><section ref={settingsRef} className="mail-modal" role="dialog" aria-modal="true" aria-labelledby="mail-settings-title"><header><div><span>PERSONALISE</span><h2 id="mail-settings-title">Mail settings</h2></div><button className="mail-icon-button" onClick={() => setSettingsOpen(false)} aria-label="Close"><X size={17} /></button></header><label>Display name<input value={settingsData.display_name ?? ''} onChange={event => setSettingsData(current => ({ ...current, display_name: event.target.value }))} /></label><label>Reply-to address<input type="email" value={settingsData.reply_to ?? ''} onChange={event => setSettingsData(current => ({ ...current, reply_to: event.target.value }))} /></label><div className="mail-modal-editor"><span>Signature</span><RichEditor compact html={settingsData.signature_html ?? ''} onChange={value => setSettingsData(current => ({ ...current, signature_html: value }))} /></div><footer><button className="btn secondary" onClick={() => setSettingsOpen(false)}>Cancel</button><button className="btn primary" disabled={busy} onClick={() => void saveSettings()}>Save settings</button></footer></section></div>}
    {foldersOpen && <div className="mail-modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setFoldersOpen(false) }}><section ref={foldersRef} className="mail-modal mail-folder-modal" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title"><header><div><span>ORGANISE</span><h2 id="folder-dialog-title">{editingFolder ? 'Rename folder' : 'New folder'}</h2></div><button className="mail-icon-button" onClick={() => setFoldersOpen(false)} aria-label="Close"><X size={17} /></button></header><label>Folder name<input autoFocus value={folderName} maxLength={80} onChange={event => setFolderName(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void saveFolder() }} /></label><footer>{editingFolder && <button className="btn danger" disabled={busy} onClick={() => void deleteFolder(editingFolder)}><Trash2 size={15} />Delete</button>}<span /><button className="btn secondary" onClick={() => setFoldersOpen(false)}>Cancel</button><button className="btn primary" disabled={busy || !folderName.trim()} onClick={() => void saveFolder()}>{editingFolder ? 'Rename' : 'Create folder'}</button></footer></section></div>}
    {accountDialog === 'add' && <div className="mail-modal-backdrop"><section ref={addRef} className="mail-modal mailbox-dialog" role="dialog" aria-modal="true" aria-labelledby="add-mailbox-title"><header><div><span>MORE WAYS TO WORK</span><h2 id="add-mailbox-title">Add mailbox</h2></div><button className="mail-icon-button" onClick={() => setAccountDialog(null)} aria-label="Close"><X size={17} /></button></header><div className="mailbox-tabs"><button className={accountTab === 'company' ? 'active' : ''} onClick={() => setAccountTab('company')}>Company address</button><button className={accountTab === 'external' ? 'active' : ''} onClick={() => setAccountTab('external')}>External account</button></div><div className="mailbox-form"><label>Email address<input type="email" required value={accountForm.email} onChange={event => setAccountForm(value => ({ ...value, email: event.target.value }))} placeholder={accountTab === 'company' ? 'careers@company.com' : 'name@gmail.com'} /></label><div className="field-pair"><label>Label<input value={accountForm.label} onChange={event => setAccountForm(value => ({ ...value, label: event.target.value }))} placeholder="Recruiting" /></label><label>Display name<input value={accountForm.displayName} onChange={event => setAccountForm(value => ({ ...value, displayName: event.target.value }))} placeholder={data.user.full_name} /></label></div>{accountTab === 'external' && <><div className="field-pair"><label>IMAP host<input required value={accountForm.imapHost} onChange={event => setAccountForm(value => ({ ...value, imapHost: event.target.value }))} placeholder="imap.example.com" /></label><label>IMAP port<input type="number" value={accountForm.imapPort} onChange={event => setAccountForm(value => ({ ...value, imapPort: event.target.value }))} /></label></div><label className="checkbox-line"><input type="checkbox" checked={accountForm.imapSecure} onChange={event => setAccountForm(value => ({ ...value, imapSecure: event.target.checked }))} />Use TLS for IMAP</label><div className="field-pair"><label>SMTP host<input required value={accountForm.smtpHost} onChange={event => setAccountForm(value => ({ ...value, smtpHost: event.target.value }))} placeholder="smtp.example.com" /></label><label>SMTP port<input type="number" value={accountForm.smtpPort} onChange={event => setAccountForm(value => ({ ...value, smtpPort: event.target.value }))} /></label></div><label className="checkbox-line"><input type="checkbox" checked={accountForm.smtpSecure} onChange={event => setAccountForm(value => ({ ...value, smtpSecure: event.target.checked }))} />Use implicit TLS for SMTP</label><label>Username<input required value={accountForm.username} onChange={event => setAccountForm(value => ({ ...value, username: event.target.value }))} /></label><label>Password<PasswordInput aria-label="Password" required value={accountForm.password} onChange={event => setAccountForm(value => ({ ...value, password: event.target.value }))} /></label></>}</div><footer><button className="btn secondary" onClick={() => setAccountDialog(null)}>Cancel</button><button className="btn primary" disabled={busy || !accountForm.email || (accountTab === 'external' && (!accountForm.imapHost || !accountForm.smtpHost || !accountForm.username || !accountForm.password))} onClick={() => void addAccount()}>{busy ? 'Connecting…' : accountTab === 'company' ? 'Add company address' : 'Connect account'}</button></footer></section></div>}
    {accountDialog === 'manage' && <div className="mail-modal-backdrop"><section ref={manageRef} className="mail-modal manage-mailboxes" role="dialog" aria-modal="true" aria-labelledby="manage-mailboxes-title"><header><div><span>YOUR ADDRESSES</span><h2 id="manage-mailboxes-title">Manage mailboxes</h2></div><button className="mail-icon-button" onClick={() => setAccountDialog(null)} aria-label="Close"><X size={17} /></button></header><div className="managed-account-list">{accounts.map(account => <form key={account.id} onSubmit={event => { event.preventDefault(); void updateAccountDetails(account, event.currentTarget) }}><div className="managed-account-heading"><span className="mail-avatar">{account.email[0]?.toUpperCase()}</span><div><strong>{account.email}</strong><small>{account.provider} · {account.status}{account.is_default ? ' · default' : ''}</small>{account.last_error && <em>{account.last_error}</em>}</div></div><div className="field-pair"><label>Label<input name="label" defaultValue={account.label ?? ''} /></label><label>Display name<input name="displayName" defaultValue={account.display_name ?? ''} /></label></div><footer><button type="submit" className="btn secondary" disabled={busy}>Save details</button>{!account.is_default && <button type="button" className="btn ghost" disabled={busy} onClick={() => void makeDefault(account)}>Make default</button>}<button type="button" className="btn danger" disabled={busy || accounts.length === 1} title={accounts.length === 1 ? 'You must keep one mailbox' : 'Mail stays, but this address stops receiving'} onClick={() => void removeAccount(account)}>Remove</button></footer></form>)}</div><footer><button className="btn secondary" onClick={() => setAccountDialog('add')}><Plus size={14} />Add mailbox</button><button className="btn primary" onClick={() => setAccountDialog(null)}>Done</button></footer></section></div>}
  </section>
}
