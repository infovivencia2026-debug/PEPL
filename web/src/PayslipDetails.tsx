import { useEffect, useState } from 'react'
import { money, pretty } from './api'
import { domainApi } from './domainApi'
import { Modal } from './ui'
type Line={component_code:string;component_type:string;amount_paise:string;calc_note:Record<string,unknown>|null}
export function PayslipDetails({id,onClose}:{id:string;onClose:()=>void}){
  const [lines,setLines]=useState<Line[]>([]);const [error,setError]=useState('');const [loading,setLoading]=useState(true)
  useEffect(()=>{let active=true;void domainApi<{lines:Line[]}>(`/payslips/${id}/lines`).then(result=>{if(active)setLines(result.lines)}).catch(caught=>{if(active)setError(caught.message)}).finally(()=>{if(active)setLoading(false)});return()=>{active=false}},[id])
  return <Modal title="Payslip component breakdown" onClose={onClose}>{loading?<p role="status">Loading payslip…</p>:<dl className="details">{lines.map(line=><div key={line.component_code}><dt>{pretty(line.component_code)}{['ARREARS','ARREARS_RECOVERY'].includes(line.component_code)&&<span className="status-pill status-verified">Arrears</span>}{line.calc_note?.taxExempt===true&&<span className="status-pill status-verified">Tax-free</span>}<small>{pretty(line.component_type)}</small>{line.component_code==='TDS'&&line.calc_note?.declaredDeductions!=null&&<p>After {money(String(line.calc_note.declaredDeductions))} declared deductions</p>}{line.calc_note?.limitations!=null&&<p>{Array.isArray(line.calc_note.limitations)?line.calc_note.limitations.join('; '):String(line.calc_note.limitations)}</p>}</dt><dd>{money(line.amount_paise)}</dd></div>)}</dl>}{error&&<p className="form-error" role="alert">{error}</p>}</Modal>
}
