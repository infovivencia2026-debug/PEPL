/**
 * Mail.
 *
 * Two files: accounts.ts owns mailboxes and folders, messages.ts owns reading,
 * composing and sending. This file is the entrypoint so callers do not need to
 * know which is which.
 */
export * from './accounts.ts'
export * from './messages.ts'
