/**
 * Who may see, list, upload to and delete a document.
 *
 * A document is exactly as private as the thing it is attached to. The routes used to apply a
 * scope check only to EMPLOYEE-owned documents, and only when the caller also named the owner;
 * `document.read` and `document.write` are held by every employee (so they can keep their own
 * paperwork), which made every ticket attachment, every direct-message file and every
 * confidential company document readable by anyone, and every tenant, ticket and conversation
 * document deletable by anyone. `is_confidential` was stored and never consulted.
 *
 *   employee       the employee's scope over that person (assertScope)
 *   tenant         everyone reads; a confidential one is for company-wide roles only
 *   ticket         the person who raised it, or an agent (ticket.assign) -- and the ticket must be
 *                  VISIBLE to the caller, so a grievance's attachments are as hidden as the grievance
 *   conversation   its participants, and nobody else: not even a company-wide administrator,
 *                  because a direct message is not the company's to read
 *
 * "You may not see it" is answered 404, never 403: saying a private file exists is a disclosure.
 * Deleting is narrower than reading: the person who uploaded a file may retract it; beyond that
 * it takes company-wide scope (or, for a ticket, being an agent) -- an employee cannot destroy an
 * HR letter about themselves or a company policy.
 */
import type { PoolClient } from 'pg'
import { AuthzError, assertScope, can, type AuthzContext } from '../authz/permissions.ts'
import type { DocumentMeta, OwnerType } from './index.ts'

type Subject = Pick<DocumentMeta, 'owner_type' | 'owner_id' | 'is_confidential' | 'uploaded_by_user_id'>

const notFound = (): AuthzError => new AuthzError('NOT_FOUND', 'no such document', 404)

/** The caller may see the record a document is attached to. Throws a 404 when they may not. */
export async function assertOwnerVisible(
  tx: PoolClient, auth: AuthzContext, owner: { type: OwnerType; id: string | null },
): Promise<void> {
  switch (owner.type) {
    case 'employee':
      if (owner.id) assertScope(auth, owner.id)
      return
    case 'tenant':
      return
    case 'ticket': {
      if (!owner.id) throw notFound()
      // The tickets policy hides a confidential ticket from everyone but its raiser and the named
      // committee, so a row that is not returned here is one the caller may not see.
      const { rows } = await tx.query<{ raised_by_user_id: string }>(
        `SELECT raised_by_user_id FROM tickets WHERE id = $1`, [owner.id])
      const ticket = rows[0]
      if (!ticket) throw notFound()
      if (ticket.raised_by_user_id !== auth.userId && !can(auth, 'ticket.assign')) throw notFound()
      return
    }
    case 'conversation': {
      if (!owner.id) throw notFound()
      const { rowCount } = await tx.query(
        `SELECT 1 FROM conversation_participants WHERE conversation_id = $1 AND user_id = $2 AND left_at IS NULL`,
        [owner.id, auth.userId])
      if (!rowCount) throw notFound()
      return
    }
    default:
      // Mail attachments are read through the message that carries them, never here.
      throw notFound()
  }
}

/** Confidentiality is judged the same way for a listing as for a single read. */
function confidentialityAllows(auth: AuthzContext, doc: Subject): boolean {
  if (!doc.is_confidential) return true
  // Only personnel and company files carry the flag in a way that matters: a ticket or a
  // conversation is already limited to its own people.
  if (doc.owner_type !== 'employee' && doc.owner_type !== 'tenant') return true
  if (auth.scope === 'all') return true
  // The subject of a personnel document may read it; a manager may not.
  return doc.owner_type === 'employee' && !!auth.employeeId && doc.owner_id === auth.employeeId
}

export async function assertCanRead(tx: PoolClient, auth: AuthzContext, doc: Subject): Promise<void> {
  await assertOwnerVisible(tx, auth, { type: doc.owner_type, id: doc.owner_id })
  if (!confidentialityAllows(auth, doc)) throw notFound()
}

export async function assertCanDelete(tx: PoolClient, auth: AuthzContext, doc: Subject): Promise<void> {
  await assertCanRead(tx, auth, doc)
  if (doc.uploaded_by_user_id && doc.uploaded_by_user_id === auth.userId) return
  const mayRemoveOthers =
    doc.owner_type === 'ticket' ? can(auth, 'ticket.assign')
      : doc.owner_type === 'conversation' ? false
        : auth.scope === 'all'
  if (!mayRemoveOthers) {
    throw new AuthzError('PERMISSION_DENIED', 'only the person who uploaded this document, or a company-wide role, can delete it', 403)
  }
}

/** A listing: drop what the caller may not see. The owner itself was checked once, up front. */
export function readable<T extends Subject>(auth: AuthzContext, docs: readonly T[]): T[] {
  return docs.filter((d) => confidentialityAllows(auth, d))
}
