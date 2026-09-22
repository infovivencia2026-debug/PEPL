/**
 * The Indian employer's statutory calendar, as data.
 *
 * Each obligation says when it falls due for a period and which companies it
 * applies to. Dates are the commonly followed due dates; a company can shift
 * one in settings if its state or registration says otherwise. Anything
 * uncertain is marked `check: true` so the UI can say "confirm with your
 * consultant" instead of pretending.
 */
export type Applies = (ctx: { headcount: number; ptState: string | null; organisationType: string | null; pfRegistered: boolean; esiRegistered: boolean }) => boolean

export interface ObligationDef {
  code: string
  title: string
  authority: string
  /** monthly | quarterly | half_yearly | annual */
  cadence: 'monthly' | 'quarterly' | 'half_yearly' | 'annual'
  /** For monthly: day of the following month. For others, see dueFor. */
  dueDay?: number
  help: string
  check?: boolean
  applies: Applies
  /** For non-monthly cadences: the due dates in a fiscal year, as [month, day] (month 1–12). */
  fixed?: Array<[number, number]>
  /** The filing PEPL itself produces, if any. */
  producedBy?: 'ecr' | 'esi' | 'pt' | '24q' | 'form16' | 'muster'
}

const LWF_STATES = new Set(['MH', 'KA', 'TN', 'WB', 'GJ', 'AP', 'TS', 'KL', 'MP', 'DL', 'HR', 'PB', 'CG', 'OR', 'GA'])

export const OBLIGATIONS: readonly ObligationDef[] = [
  { code: 'PF_ECR', title: 'PF contribution & ECR', authority: 'EPFO', cadence: 'monthly', dueDay: 15, producedBy: 'ecr',
    help: 'Deposit employer + employee PF for the month and upload the ECR on the EPFO Unified Portal.', applies: (c) => c.pfRegistered },
  { code: 'ESI', title: 'ESI contribution', authority: 'ESIC', cadence: 'monthly', dueDay: 15, producedBy: 'esi',
    help: 'Deposit ESI contributions for the month on the ESIC portal.', applies: (c) => c.esiRegistered },
  { code: 'TDS_192', title: 'TDS on salaries — deposit', authority: 'Income Tax (TRACES)', cadence: 'monthly', dueDay: 7,
    help: 'Deposit tax deducted from salaries by the 7th of the following month (30 April for March).', applies: () => true },
  { code: 'PT', title: 'Professional tax', authority: 'State commercial taxes', cadence: 'monthly', dueDay: 20, producedBy: 'pt', check: true,
    help: 'Deposit PT deducted from employees. The due date varies by state (many use the 20th or month-end); some states are annual for small employers.', applies: (c) => Boolean(c.ptState) },
  { code: 'TDS_24Q', title: 'Form 24Q — quarterly TDS return', authority: 'Income Tax (TRACES)', cadence: 'quarterly', producedBy: '24q', fixed: [[7, 31], [10, 31], [1, 31], [5, 31]],
    help: 'Quarterly return of tax deducted on salaries: Q1 by 31 Jul, Q2 by 31 Oct, Q3 by 31 Jan, Q4 by 31 May.', applies: () => true },
  { code: 'FORM16', title: 'Form 16 to employees', authority: 'Income Tax', cadence: 'annual', producedBy: 'form16', fixed: [[6, 15]],
    help: 'Issue Form 16 (Part A + B) to every employee for the previous financial year by 15 June.', applies: () => true },
  { code: 'LWF', title: 'Labour Welfare Fund', authority: 'State LWF board', cadence: 'half_yearly', fixed: [[7, 15], [1, 15]], check: true,
    help: 'Half-yearly LWF contribution in states that levy it (Jun and Dec periods). Rates and dates differ by state.', applies: (c) => Boolean(c.ptState && LWF_STATES.has(c.ptState)) },
  { code: 'POSH_ANNUAL', title: 'POSH annual report', authority: 'District Officer (POSH Act s.21)', cadence: 'annual', fixed: [[1, 31]],
    help: 'Internal Committee annual report for the calendar year, filed with the District Officer; required for every workplace with 10 or more employees.', applies: (c) => c.headcount >= 10 },
  { code: 'BONUS', title: 'Statutory bonus payment', authority: 'Payment of Bonus Act', cadence: 'annual', fixed: [[11, 30]],
    help: 'Pay the annual bonus for the previous accounting year within eight months of its close (by 30 November for an April–March year). Applies at 20+ employees.', applies: (c) => c.headcount >= 20 },
  { code: 'FACTORIES_ANNUAL', title: 'Factories Act annual return', authority: 'Chief Inspector of Factories', cadence: 'annual', fixed: [[1, 31]], check: true, producedBy: 'muster',
    help: 'Annual return for the previous calendar year; muster (Form 25) and registers must be kept current.', applies: (c) => c.organisationType === 'manufacturing' },
  { code: 'SE_RENEWAL', title: 'Shops & Establishments — registration / renewal check', authority: 'State labour department', cadence: 'annual', fixed: [[3, 31]], check: true,
    help: 'Confirm the S&E registration is valid and renewed where the state requires it.', applies: (c) => c.organisationType !== 'manufacturing' },
]

const iso = (y: number, m: number, d: number): string => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`

/** Every due date for an obligation between two dates, with the period label it belongs to. */
export function dueDatesBetween(def: ObligationDef, from: string, to: string): Array<{ dueOn: string; period: string }> {
  const out: Array<{ dueOn: string; period: string }> = []
  const y0 = Number(from.slice(0, 4)), y1 = Number(to.slice(0, 4))
  for (let y = y0 - 1; y <= y1 + 1; y++) {
    if (def.cadence === 'monthly') {
      for (let m = 1; m <= 12; m++) {
        // due in the month AFTER the period
        const dm = m === 12 ? 1 : m + 1, dy = m === 12 ? y + 1 : y
        let day = def.dueDay ?? 15
        if (def.code === 'TDS_192' && m === 3) day = 30   // March TDS: 30 April
        const dueOn = iso(dy, dm, Math.min(day, new Date(Date.UTC(dy, dm, 0)).getUTCDate()))
        if (dueOn >= from && dueOn <= to) out.push({ dueOn, period: iso(y, m, 1).slice(0, 7) })
      }
    } else {
      for (const [m, d] of def.fixed ?? []) {
        const dueOn = iso(y, m, d)
        if (dueOn < from || dueOn > to) continue
        const fy = (start: number): string => `FY${String(start % 100).padStart(2, '0')}-${String((start + 1) % 100).padStart(2, '0')}`
        const period = def.cadence === 'quarterly' ? `${m === 7 ? 'Q1' : m === 10 ? 'Q2' : m === 1 ? 'Q3' : 'Q4'} ${fy(m <= 5 ? y - 1 : y)}`
          : def.cadence === 'half_yearly' ? (m === 7 ? `Jan–Jun ${y}` : `Jul–Dec ${y - 1}`)
          : def.code === 'FORM16' || def.code === 'BONUS' ? fy(y - 1) : `${y - 1}`
        out.push({ dueOn, period })
      }
    }
  }
  return out.sort((a, b) => a.dueOn.localeCompare(b.dueOn))
}
