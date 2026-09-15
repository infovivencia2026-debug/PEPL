import { useEffect, useState } from 'react'
import { ArrowDownToLine, AlertTriangle } from 'lucide-react'
import { money } from './api'
import { decodeBase64, domainApi, downloadFile } from './domainApi'
import { Button, Card } from './ui'
import type { Payroll, Workspace } from './types'

type Filing = { fileName: string; contentType: string; rows: number; totalPaise: string; omitted: { employeeNumber: string; name: string; reason: string }[]; contentBase64: string }
const labels = { ecr: 'EPFO ECR', esi: 'ESIC contributions', pt: 'Professional tax working paper', '24q': 'Form 24Q Annexure I' }
export function Filings({ run, data }: { run: Payroll; data: Workspace }) {
  const start = new Date(run.period_start + 'T12:00:00')
  const year = start.getMonth() >= 3 ? start.getFullYear() : start.getFullYear() - 1
  const [fy, setFy] = useState(`${year}-${String(year + 1).slice(-2)}`)
  const [quarter, setQuarter] = useState(`Q${Math.floor(((start.getMonth() + 9) % 12) / 3) + 1}`)
  const [results, setResults] = useState<Partial<Record<keyof typeof labels, Filing>>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let active = true
    setResults({}); setErrors({})
    if (run.status !== 'locked') return
    setLoading(true)
    const keys = Object.keys(labels) as (keyof typeof labels)[]
    void Promise.allSettled(keys.map(key => domainApi<Filing>(key === '24q' ? `/payroll/filings/24q?fy=${encodeURIComponent(fy)}&quarter=${quarter}` : `/payroll/runs/${run.id}/filings/${key}`))).then(values => {
      if (!active) return
      const next: Partial<Record<keyof typeof labels, Filing>> = {}; const failures: Record<string, string> = {}
      values.forEach((value, index) => { if (value.status === 'fulfilled') next[keys[index]] = value.value; else failures[keys[index]] = value.reason instanceof Error ? value.reason.message : 'Unable to prepare filing' })
      setResults(next); setErrors(failures); setLoading(false)
    })
    return () => { active = false }
  }, [run.id, run.status, fy, quarter])
  return <Card title="Statutory filings" subtitle="Review every omitted employee before downloading a return">
    <div className="bank-file-controls"><label>Fiscal year<select value={fy} onChange={event => setFy(event.target.value)}>{[year-2,year-1,year,year+1].map(value=><option key={value}>{value}-{String(value+1).slice(-2)}</option>)}</select></label><label>24Q quarter<select value={quarter} onChange={event => setQuarter(event.target.value)}>{['Q1','Q2','Q3','Q4'].map(value => <option key={value}>{value}</option>)}</select></label></div>
    {run.status !== 'locked' ? <p className="freeze-note">Filings are available only after this run is locked. Its figures can still change.</p> : loading ? <p role="status">Preparing filing reports…</p> : null}
    <div className="filing-grid">{(Object.keys(labels) as (keyof typeof labels)[]).map(key => {
      const filing = results[key]
      return <section key={key} className="filing-report"><h3>{labels[key]}</h3>{errors[key] && <p role="alert" className="form-error">{errors[key]}</p>}{filing && <><p>{filing.rows} rows · {money(filing.totalPaise)}</p>{filing.omitted.length ? <div className="filing-omissions"><h4><AlertTriangle size={15} />{filing.omitted.length} employees omitted</h4><ul>{filing.omitted.map((person, index) => { const employee = data.employees.find(item => item.employee_number === person.employeeNumber); return <li key={`${person.employeeNumber}-${index}`}><strong>{employee ? <a href={`#/people/${employee.id}`}>{person.name}</a> : person.name} · {person.employeeNumber}</strong><span>{person.reason}</span></li> })}</ul></div> : <p className="success-note">No employees omitted.</p>}</>}<Button variant="secondary" disabled={!filing || loading || run.status !== 'locked'} onClick={() => { if (filing) downloadFile(filing.fileName, filing.contentType, decodeBase64(filing.contentBase64)) }}><ArrowDownToLine size={15} />Download {key === 'ecr' ? '.txt' : '.csv'}</Button></section>
    })}</div>
  </Card>
}
