/**
 * Document categories — a closed vocabulary per owner type.
 *
 * "documents" was one flat list with a free-text label; an HR team cannot find
 * an offer letter in that, and a self-service employee sees their medical note
 * beside the leave policy. Each owner type has its own categories, grouped for
 * the UI, and some are confidential by default: a payslip or a disciplinary
 * letter is never a colleague-browsable file whatever the uploader ticks.
 */
import type { OwnerType } from './index.ts'

export interface Category {
  key: string
  label: string
  /** Section heading in the UI. */
  group: string
  /** Stored confidential whatever the request says. */
  confidential?: boolean
  /** Uploadable by the employee themselves (self scope). Others need HR. */
  selfUpload?: boolean
}

export const CATEGORIES: Record<OwnerType, readonly Category[]> = {
  employee: [
    { key: 'identity', label: 'Identity proof (Aadhaar, PAN, passport)', group: 'Personal', confidential: true, selfUpload: true },
    { key: 'address', label: 'Address proof', group: 'Personal', confidential: true, selfUpload: true },
    { key: 'bank', label: 'Bank proof (cancelled cheque, passbook)', group: 'Personal', confidential: true, selfUpload: true },
    { key: 'photo', label: 'Photograph', group: 'Personal', selfUpload: true },
    { key: 'education', label: 'Education certificates', group: 'Background', selfUpload: true },
    { key: 'experience', label: 'Previous employment (relieving, experience)', group: 'Background', selfUpload: true },
    { key: 'background_check', label: 'Background verification', group: 'Background', confidential: true },
    { key: 'offer_letter', label: 'Offer letter', group: 'Employment', confidential: true },
    { key: 'appointment', label: 'Appointment / confirmation letter', group: 'Employment', confidential: true },
    { key: 'contract', label: 'Contract / agreement (NDA, bond)', group: 'Employment', confidential: true },
    { key: 'promotion', label: 'Promotion / transfer letter', group: 'Employment', confidential: true },
    { key: 'salary_revision', label: 'Salary revision letter', group: 'Employment', confidential: true },
    { key: 'payslip', label: 'Payslip', group: 'Pay & tax', confidential: true },
    { key: 'form16', label: 'Form 16', group: 'Pay & tax', confidential: true },
    { key: 'tax_proof', label: 'Investment / rent proof (80C, HRA…)', group: 'Pay & tax', confidential: true, selfUpload: true },
    { key: 'reimbursement', label: 'Reimbursement bill', group: 'Pay & tax', selfUpload: true },
    { key: 'medical', label: 'Medical certificate', group: 'Leave & wellbeing', confidential: true, selfUpload: true },
    { key: 'insurance', label: 'Insurance / nominee form', group: 'Leave & wellbeing', confidential: true, selfUpload: true },
    { key: 'performance', label: 'Performance review', group: 'Conduct', confidential: true },
    { key: 'disciplinary', label: 'Warning / disciplinary letter', group: 'Conduct', confidential: true },
    { key: 'resignation', label: 'Resignation letter', group: 'Exit', confidential: true, selfUpload: true },
    { key: 'relieving', label: 'Relieving / experience letter', group: 'Exit', confidential: true },
    { key: 'settlement', label: 'Full & final settlement', group: 'Exit', confidential: true },
    { key: 'other', label: 'Other', group: 'Other', selfUpload: true },
  ],
  tenant: [
    { key: 'policy', label: 'Policy (leave, attendance, POSH…)', group: 'Policies' },
    { key: 'handbook', label: 'Employee handbook', group: 'Policies' },
    { key: 'code_of_conduct', label: 'Code of conduct', group: 'Policies' },
    { key: 'template', label: 'Letter / form template', group: 'Templates' },
    { key: 'compliance', label: 'Statutory registration (PF, ESI, PT, GST…)', group: 'Compliance', confidential: true },
    { key: 'filing', label: 'Filed return / challan', group: 'Compliance', confidential: true },
    { key: 'holiday_calendar', label: 'Holiday calendar', group: 'Company' },
    { key: 'org_chart', label: 'Organisation chart', group: 'Company' },
    { key: 'other', label: 'Other', group: 'Other' },
  ],
  ticket: [
    { key: 'attachment', label: 'Attachment', group: 'Attachments' },
  ],
  conversation: [
    { key: 'attachment', label: 'Attachment', group: 'Attachments' },
  ],
  mail: [
    { key: 'attachment', label: 'Attachment', group: 'Attachments' },
    { key: 'inline', label: 'Inline image', group: 'Attachments' },
  ],
}

export class CategoryError extends Error {
  readonly code = 'INVALID_CATEGORY'
  constructor(message: string) { super(message); this.name = 'CategoryError' }
}

/** Resolves a category, or throws naming the valid ones. Absent means 'other' where one exists. */
export function resolveCategory(ownerType: OwnerType, key: string | null | undefined): Category {
  const list = CATEGORIES[ownerType]
  const wanted = (key ?? '').trim().toLowerCase() || (list.some((c) => c.key === 'other') ? 'other' : list[0]!.key)
  const found = list.find((c) => c.key === wanted)
  if (!found) {
    throw new CategoryError(`category for ${ownerType} must be one of: ${list.map((c) => c.key).join(', ')}`)
  }
  return found
}
