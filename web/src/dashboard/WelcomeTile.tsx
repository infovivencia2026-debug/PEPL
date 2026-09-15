import type { ReactElement } from 'react'
import { ArrowRight, Sun } from 'lucide-react'
import { Widget } from '../WidgetBoard'
import { AmbientSculpture } from '../AmbientSculpture'
import { dateLabel } from '../api'
import type { Workspace } from '../types'
import { greetingFor } from './metrics'

/**
 * The greeting tile.
 *
 * The call to action states a fact and links to the work — an aspirational
 * slogan is not a control, and a dashboard is a place people come to do
 * something specific.
 */
export function welcomeTile({
  data,
  can,
}: {
  data: Workspace
  can: (permission: string) => boolean
}): ReactElement {
  const firstName = data.user.full_name.split(' ')[0]
  const pending = data.approvals.length
  const target = can('approval.act') ? '#/approvals' : '#/people'

  return (
    <Widget id="welcome" title="Welcome" width={4} hero>
      <section className="welcome-card">
        <div>
          <span className="welcome-tag">
            <Sun size={16} /> {dateLabel(data.today, { weekday: 'long' })}
          </span>
          <h2>
            {greetingFor()},<br />
            {firstName}
            <span>.</span>
          </h2>
          <p>
            {pending
              ? `${pending} request${pending === 1 ? '' : 's'} waiting for your decision.`
              : 'Nothing is waiting on you right now.'}
          </p>
          <a href={target}>
            {pending ? 'Review requests' : 'View your people'}
            <ArrowRight size={18} />
          </a>
        </div>
        <AmbientSculpture />
      </section>
    </Widget>
  )
}
