/**
 * Mail.
 *
 * Two files: accounts.ts owns mailboxes and folders, messages.ts owns reading,
 * composing and sending. This file is the entrypoint so callers do not need to
 * know which is which.
 */
export * from './accounts.ts'
export * from './messages.ts'
export * from './outbox.ts'
export * from './smtp.ts'
export * from './mime.ts'
export * from './imap.ts'
export * from './sync.ts'
export * from './parse.ts'
export * from './sanitize.ts'
export * from './attachments.ts'
export * from './mailbox.ts'
