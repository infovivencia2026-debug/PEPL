/** Documents — upload, list, download, delete. */
import type { Router } from '../router.ts'
import {
  HttpError, authed, ok, created, noContent, requireBody, requireModule, asUuid,
  assertScope, emit,
} from './deps.ts'
import {
  deleteDocument, getDocument, listDocuments, putDocument, readDocument,
  MAX_BYTES, type OwnerType,
} from '../../documents/index.ts'

const OWNER_TYPES: readonly OwnerType[] = ['employee', 'ticket', 'conversation', 'tenant']

function ownerType(value: unknown): OwnerType {
  if (typeof value !== 'string' || !OWNER_TYPES.includes(value as OwnerType)) {
    throw new HttpError(422, 'VALIDATION_FAILED',
      `ownerType must be one of: ${OWNER_TYPES.join(', ')}`)
  }
  return value as OwnerType
}

export function register(router: Router): void {
  router.get('/api/v1/documents',
    { summary: 'List documents attached to a record', tag: 'documents',
      permission: 'document.read' },
    authed('document.read', async (ctx) => {
      const type = ctx.req.query.get('ownerType')
      const owner = ctx.req.query.get('ownerId')
      // An employee folder is the employee's record: the same scope rule that
      // governs the profile governs the paperwork stapled to it.
      if (type === 'employee' && owner) assertScope(ctx.auth, owner)
      return ok({
        documents: await listDocuments(ctx.tx, {
          ownerType: type ? ownerType(type) : undefined,
          ownerId: owner ?? undefined,
        }),
      })
    }))

  router.post('/api/v1/documents',
    { summary: 'Upload a document (base64, up to the company file-size limit)', tag: 'documents',
      permission: 'document.write',
      requestExample: {
        ownerType: 'employee', ownerId: '…', fileName: 'offer-letter.pdf',
        contentType: 'application/pdf', contentBase64: 'JVBERi0…', category: 'onboarding',
      } },
    authed('document.write', async (ctx) => {
      requireModule(ctx, 'documents.enabled')
      const b = requireBody<{
        ownerType: string; ownerId?: string; fileName: string
        contentType: string; contentBase64: string
        category?: string; isConfidential?: boolean
      }>(ctx.req, ['ownerType', 'fileName', 'contentType', 'contentBase64'])

      const type = ownerType(b.ownerType)
      const owner = b.ownerId ? asUuid(b.ownerId, 'ownerId') : null
      if (type === 'employee') {
        if (!owner) throw new HttpError(422, 'VALIDATION_FAILED', 'ownerId is required for an employee document')
        assertScope(ctx.auth, owner)
      }
      // A company-wide document (policies, handbooks) is not something a person
      // with self-scope publishes, whatever else document.write lets them upload.
      if (type === 'tenant' && ctx.auth.scope !== 'all') {
        throw new HttpError(403, 'PERMISSION_DENIED', 'only company-wide roles can publish company documents')
      }

      // The company's own limit, never above what the storage layer accepts.
      const limit = Math.min(
        ctx.config.get<number>('documents.max_upload_mb') * 1024 * 1024,
        MAX_BYTES,
      )
      // Reject on the encoded length before allocating: base64 is 4 bytes per 3.
      if (b.contentBase64.length > Math.ceil(limit / 3) * 4 + 16) {
        throw new HttpError(413, 'FILE_TOO_LARGE',
          `this company allows files up to ${Math.round(limit / 1024 / 1024)} MB`,
          { limitBytes: limit })
      }
      const bytes = Buffer.from(b.contentBase64, 'base64')
      if (bytes.length > limit) {
        throw new HttpError(413, 'FILE_TOO_LARGE',
          `this company allows files up to ${Math.round(limit / 1024 / 1024)} MB`,
          { limitBytes: limit })
      }

      const meta = await putDocument(ctx.tx, {
        ownerType: type,
        ownerId: owner,
        fileName: b.fileName,
        contentType: b.contentType,
        bytes,
        category: b.category ?? null,
        isConfidential: b.isConfidential ?? false,
        uploadedByUserId: ctx.session.userId,
      })
      await emit(ctx.tx, {
        action: 'data.document.uploaded', entityType: 'document', entityId: meta.id,
        actorUserId: ctx.session.userId,
        metadata: { fileName: meta.file_name, ownerType: type, ownerId: owner },
      })
      return created(meta)
    }))

  router.get('/api/v1/documents/:id',
    { summary: 'Document metadata', tag: 'documents', permission: 'document.read' },
    authed('document.read', async (ctx) => {
      const meta = await getDocument(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      if (!meta || meta.owner_type === 'mail') throw new HttpError(404, 'NOT_FOUND', 'no such document')
      if (meta.owner_type === 'employee' && meta.owner_id) assertScope(ctx.auth, meta.owner_id)
      return ok(meta)
    }))

  router.get('/api/v1/documents/:id/content',
    { summary: 'Download a document as base64', tag: 'documents', permission: 'document.read' },
    authed('document.read', async (ctx) => {
      const found = await readDocument(ctx.tx, asUuid(ctx.req.params.id, 'id'))
      // Mail attachments are read through the message that carries them, never here.
      if (!found || found.meta.owner_type === 'mail') throw new HttpError(404, 'NOT_FOUND', 'no such document')
      if (found.meta.owner_type === 'employee' && found.meta.owner_id) {
        assertScope(ctx.auth, found.meta.owner_id)
      }
      // Reading a personnel file is itself an event a subject may ask about.
      await emit(ctx.tx, {
        action: 'data.document.downloaded', entityType: 'document', entityId: found.meta.id,
        actorUserId: ctx.session.userId, metadata: { fileName: found.meta.file_name },
      })
      return ok({ ...found.meta, contentBase64: found.bytes.toString('base64') })
    }))

  router.del('/api/v1/documents/:id',
    { summary: 'Delete a document (reason required)', tag: 'documents',
      permission: 'document.write', requestExample: { reason: 'uploaded to the wrong employee' } },
    authed('document.write', async (ctx) => {
      const id = asUuid(ctx.req.params.id, 'id')
      const meta = await getDocument(ctx.tx, id)
      if (!meta || meta.owner_type === 'mail') throw new HttpError(404, 'NOT_FOUND', 'no such document')
      if (meta.owner_type === 'employee' && meta.owner_id) assertScope(ctx.auth, meta.owner_id)
      const b = requireBody<{ reason: string }>(ctx.req, ['reason'])
      await deleteDocument(ctx.tx, id, b.reason)
      await emit(ctx.tx, {
        action: 'data.document.deleted', entityType: 'document', entityId: id,
        actorUserId: ctx.session.userId, reason: b.reason,
        metadata: { fileName: meta.file_name },
      })
      return noContent()
    }))
}
