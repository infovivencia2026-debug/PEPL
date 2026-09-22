/** Grounded assistant: ask, rate, and (HR) see what it could not answer. */
import type { Router } from '../router.ts'
import { HttpError, authed, ok, requireBody, asInt } from './deps.ts'
import { today as localToday } from '../../lib/timezone.ts'
import { answer, markHelpful, lastQueryId, gaps, EXAMPLES, INTENT_KEYS } from '../../comms/assistant.ts'

export function register(router: Router): void {
  router.post('/api/v1/assistant/ask', { summary: 'Ask in plain words; answered from YOUR records under YOUR permissions, with the rows it read from. Not a chatbot: a fixed set of intents.', tag: 'assistant', requestExample: { question: 'How many leaves do I have left?' } },
    authed(null, async (ctx) => {
      const b = requireBody<{ question: string }>(ctx.req, ['question'])
      if (typeof b.question !== 'string' || b.question.length > 500) throw new HttpError(422, 'VALIDATION_FAILED', 'question is up to 500 characters')
      const a = await answer(ctx.tx, { question: b.question, auth: ctx.auth, cfg: ctx.config, today: localToday(ctx.config.get<string>('attendance.timezone')) })
      return ok({ ...a, queryId: await lastQueryId(ctx.tx, ctx.auth.userId) })
    }))

  router.post('/api/v1/assistant/feedback', { summary: 'Thumbs up / down on the last answer', tag: 'assistant', requestExample: { queryId: '…', helpful: true } },
    authed(null, async (ctx) => {
      const b = requireBody<{ queryId: string; helpful: boolean }>(ctx.req, ['queryId', 'helpful'])
      await markHelpful(ctx.tx, { id: String(b.queryId), helpful: Boolean(b.helpful) }); return ok({ recorded: true })
    }))

  router.get('/api/v1/assistant/intents', { summary: 'What it can answer, with example questions', tag: 'assistant' },
    authed(null, async () => ok({ intents: INTENT_KEYS, examples: EXAMPLES })))

  router.get('/api/v1/assistant/gaps', { summary: 'HR: questions asked at least twice that matched no intent (?days=30), never attributed to a person', tag: 'assistant', permission: 'settings.write' },
    authed('settings.write', async (ctx) => ok({ gaps: await gaps(ctx.tx, ctx.req.query.get('days') ? asInt(ctx.req.query.get('days'), 'days', { min: 1, max: 365 }) : 30) })))
}
