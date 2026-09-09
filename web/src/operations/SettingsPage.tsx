import type { Workspace } from '../types'
import type { FormSpec } from '../forms'
import { useState } from 'react'
import {
  ArrowUpRight,
  ChevronRight,
  Settings2,
  ShieldCheck,
  Users,
} from 'lucide-react'
import type { Setting } from '../types'
import { pretty } from '../api'
import {
  Button,
  Card,
  Empty,
  PageHeader,
  SearchBox,
} from '../ui'
type Props = {
  data: Workspace
  open: (s: FormSpec) => void
  act: (path: string, body: unknown, message: string) => Promise<void>
}

export function SettingsPage({ data, open }: Props) {
  const [search, setSearch] = useState(''),
    [category, setCategory] = useState('All settings')
  const settings = data.settings.filter(
    (s) =>
      (category === 'All settings' ||
        s.key.startsWith(category.toLowerCase() + '.')) &&
      `${s.label} ${s.help}`.toLowerCase().includes(search.toLowerCase()),
  )
  function edit(s: Setting) {
    open({
      title: s.label,
      description: s.help,
      path: '/settings',
      fields: [
        {
          name: 'value',
          label: 'Value',
          value: String(s.value),
          type: s.kind === 'int' ? 'number' : 'text',
          options: ['flag', 'bool'].includes(s.kind)
            ? [
                { value: 'true', label: 'Enabled' },
                { value: 'false', label: 'Disabled' },
              ]
            : undefined,
          help:
            s.kind === 'enum'
              ? `Current value: ${s.value}. Enter a supported policy value.`
              : undefined,
        },
        ...(s.affects.includes('payroll')
          ? [
              {
                name: 'effectiveFrom',
                label: 'Effective from',
                type: 'date',
                value: data.today,
                help: 'Must be after any frozen payroll period.',
              },
            ]
          : []),
        { name: 'reason', label: 'Reason for change', type: 'textarea' },
      ],
      transform: (v) => ({
        ...v,
        key: s.key,
        value: ['flag', 'bool'].includes(s.kind)
          ? v.value === 'true'
          : s.kind === 'int'
            ? Number(v.value)
            : v.value,
      }),
    })
  }
  return (
    <>
      <PageHeader
        title="A workspace that works for you"
        description="Company policies, with thoughtful defaults and a clear history."
        eyebrow="Settings"
      />
      <div className="settings-layout">
        <aside className="settings-sidebar">
          <div className="company-tile">
            <span className="icon-box">
              <Users size={23} />
            </span>
            <h3>{data.company}</h3>
            <small>Your company workspace</small>
          </div>
          {['All settings', 'Leave', 'Attendance', 'Payroll', 'Helpdesk'].map(
            (s) => (
              <button
                className={s === category ? 'active' : ''}
                key={s}
                onClick={() => setCategory(s)}
              >
                <Settings2 size={17} />
                {s}
                <ChevronRight size={16} />
              </button>
            ),
          )}
        </aside>
        <Card>
          <SearchBox
            value={search}
            onChange={setSearch}
            placeholder="Find a policy or setting..."
          />
          <div className="settings-list">
            {settings.length ? (
              settings.map((s) => (
                <article key={s.key}>
                  <div>
                    <span className="setting-category">
                      {s.key.split('.')[0]}
                    </span>
                    <h3>{s.label}</h3>
                    <p>{s.help}</p>
                    {s.affects.includes('payroll') && (
                      <small className="policy-note">
                        <ShieldCheck size={13} />
                        Effective-dated · affects payroll
                      </small>
                    )}
                  </div>
                  <div className="setting-control">
                    <span
                      className={
                        typeof s.value === 'boolean'
                          ? `toggle-preview ${s.value ? 'on' : ''}`
                          : 'setting-value'
                      }
                      aria-label={
                        typeof s.value === 'boolean'
                          ? s.value
                            ? 'Enabled'
                            : 'Disabled'
                          : undefined
                      }
                    >
                      {typeof s.value === 'boolean' ? (
                        <i />
                      ) : (
                        pretty(String(s.value))
                      )}
                    </span>
                    <Button variant="ghost" onClick={() => edit(s)}>
                      Edit
                      <ArrowUpRight size={15} />
                    </Button>
                  </div>
                </article>
              ))
            ) : (
              <Empty
                title="No matching settings"
                text="Try another search or category."
              />
            )}
          </div>
        </Card>
      </div>
    </>
  )
}
