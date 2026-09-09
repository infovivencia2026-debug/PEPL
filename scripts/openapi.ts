/**
 * Generates openapi.json from the live route table.
 *
 * Generated rather than hand-written, so the document cannot drift from what the
 * server actually serves — a stale API doc is worse than none, because someone
 * builds against it.
 */
import { writeFile } from 'node:fs/promises'
import { buildRouter } from '../src/http/app.ts'
import { REGISTRY } from '../src/config-registry/index.ts'
import { PERMISSIONS, ROLE_PERMISSIONS } from '../src/authz/permissions.ts'

const router = buildRouter()
const routes = router.list()

const TAG_DESCRIPTIONS: Record<string, string> = {
  system: 'Liveness and readiness.',
  auth: 'Sessions. Every other endpoint needs the token this returns.',
  config: 'The tenant\'s own control surface. Changes affect this company only.',
  people: 'Employees and their effective-dated history.',
  attendance: 'Capture, derived days and corrections.',
  leave: 'Balances derived from an append-only ledger, requests and approvals.',
  inbox: 'One queue: approvals and tasks across every module.',
  payroll: 'Freeze, calculate, validate, approve, lock, revise.',
  helpdesk: 'Employee tickets with SLA tracking.',
  incentives: 'Variable pay, terminating in payroll.',
  comms: 'Announcements, acknowledgement tracking and notifications.',
  audit: 'The company activity log.',
}

const paramsOf = (path: string): Record<string, unknown>[] =>
  path.split('/').filter((s) => s.startsWith(':')).map((s) => ({
    name: s.slice(1),
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }))

const errorResponse = (description: string) => ({
  description,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/Error' },
    },
  },
})

const paths: Record<string, Record<string, unknown>> = {}

for (const route of routes) {
  const openapiPath = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
  paths[openapiPath] ??= {}

  const operation: Record<string, unknown> = {
    summary: route.meta.summary,
    tags: [route.meta.tag],
    operationId: `${route.method.toLowerCase()}${openapiPath.replace(/[^A-Za-z0-9]/g, '_')}`,
    parameters: paramsOf(route.path),
    security: route.meta.public ? [] : [{ bearerAuth: [] }],
    responses: {
      '200': { description: 'Success' },
      '400': errorResponse('Malformed request'),
      ...(route.meta.public ? {} : {
        '401': errorResponse('Missing or invalid session'),
        '403': errorResponse('Permission denied, or the module is not enabled for this company'),
      }),
      '404': errorResponse('Not found — also returned for a record outside the caller\'s data scope'),
      '409': errorResponse('Conflicts with the current state (a frozen period, a locked run)'),
      '422': errorResponse('Validation failed, or a domain rule refused the request'),
    },
  }

  if (route.meta.permission) {
    operation.description = `Requires the \`${route.meta.permission}\` permission.`
  }

  if (route.meta.requestExample) {
    operation.requestBody = {
      required: true,
      content: {
        'application/json': {
          schema: { type: 'object' },
          example: route.meta.requestExample,
        },
      },
    }
  }

  paths[openapiPath]![route.method.toLowerCase()] = operation
}

const spec = {
  openapi: '3.1.0',
  info: {
    title: 'PEPL API',
    version: '1.0.0',
    description: [
      'Multi-tenant HR and employee-operations API.',
      '',
      '## Conventions',
      '',
      '- **Tenancy is implicit.** The company is resolved from the session token. There is no',
      '  tenant id in any path, header or body, and supplying one would have no effect.',
      '- **404, not 403, for scope.** A record belonging to another employee outside the caller\'s',
      '  data scope returns 404. Confirming that a record exists is itself a disclosure.',
      '- **Stable error codes.** Every error carries `error.code` — switch on that, not on the',
      '  status or the message. `error.requestId` correlates with the server log.',
      '- **Reasons.** Any change that moves money or rewrites history requires a `reason`, and',
      '  the API refuses the request without one.',
      '',
      '## Building a UI against this',
      '',
      'Call `GET /api/v1/me` first. It returns the caller\'s `permissions`, data `scope` and the',
      'set of enabled `modules`. Render navigation from that rather than from the role name —',
      'a tenant can define custom roles, so role names are not a reliable switch.',
      '',
      'A module the tenant has disabled, or has not purchased, returns 403 `MODULE_NOT_AVAILABLE`.',
      'Hide it rather than showing a disabled teaser.',
    ].join('\n'),
  },
  servers: [{ url: 'http://localhost:4010', description: 'Local development' }],
  tags: [...new Set(routes.map((r) => r.meta.tag))].map((name) => ({
    name,
    description: TAG_DESCRIPTIONS[name] ?? '',
  })),
  paths,
  components: {
    securitySchemes: {
      bearerAuth: { type: 'http', scheme: 'bearer', description: 'The token from POST /api/v1/auth/login' },
    },
    schemas: {
      Error: {
        type: 'object',
        required: ['error'],
        properties: {
          error: {
            type: 'object',
            required: ['code', 'message'],
            properties: {
              code: { type: 'string', description: 'Stable machine code. Switch on this.' },
              message: { type: 'string' },
              details: { type: 'object' },
              requestId: { type: 'string' },
            },
          },
        },
        example: {
          error: {
            code: 'CONFIG_EFFECTIVE_DATE_REQUIRED',
            message: '"payroll.lop_basis" affects payroll and must carry an effective date, so a locked run stays reproducible',
            requestId: '…',
          },
        },
      },
    },
  },
  'x-pepl': {
    permissions: PERMISSIONS,
    seededRoles: Object.fromEntries(
      Object.entries(ROLE_PERMISSIONS).map(([name, d]) => [name, { scope: d.scope, permissions: d.permissions }]),
    ),
    configSettings: Object.entries(REGISTRY).map(([key, def]) => ({
      key, label: def.label, help: def.help, type: def.kind,
      default: def.default, risk: def.risk,
      affectsPayroll: def.affects.includes('payroll'),
      scopableBy: def.scopable,
    })),
  },
}

await writeFile('openapi.json', JSON.stringify(spec, null, 2) + '\n')

const byTag = routes.reduce<Record<string, number>>((acc, r) => {
  acc[r.meta.tag] = (acc[r.meta.tag] ?? 0) + 1
  return acc
}, {})

console.log(`openapi.json written: ${routes.length} routes across ${Object.keys(byTag).length} tags`)
for (const [tag, n] of Object.entries(byTag).sort()) console.log(`  ${tag.padEnd(12)} ${n}`)
