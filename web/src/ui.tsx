import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
} from 'react'
import {
  ArrowUpRight,
  ArrowRight,
  Inbox,
  X,
  Search,
  AlertCircle,
  Lock,
  Eye,
  EyeOff,
} from 'lucide-react'
import { pretty } from './api'
export function Button({
  children,
  className = '',
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
}) {
  return (
    <button {...props} className={`btn ${variant} ${className}`}>
      {children}
    </button>
  )
}
export function Brand() {
  return (
    <a className="brand" href="#/dashboard" aria-label="PEPL dashboard">
      <span className="brand-mark">
        <svg viewBox="0 0 48 48" fill="none" aria-hidden="true"><defs><linearGradient id="pepl-leaf-a" x1="4" y1="4" x2="33" y2="43" gradientUnits="userSpaceOnUse"><stop stopColor="#387a76"/><stop offset="1" stopColor="#154d50"/></linearGradient><linearGradient id="pepl-leaf-b" x1="40" y1="3" x2="18" y2="45" gradientUnits="userSpaceOnUse"><stop stopColor="#8bc7b6"/><stop offset="1" stopColor="#398d79"/></linearGradient></defs><path d="M25 44C7 40 1 24 6 5c17 3 26 19 19 39Z" fill="url(#pepl-leaf-a)"/><path d="M27 44C22 23 30 9 43 5c6 22-1 36-16 39Z" fill="url(#pepl-leaf-b)"/><path d="M26 44C34 33 38 22 41 10M24 41C18 26 13 17 8 9" stroke="#d9eece" strokeOpacity=".6" strokeWidth=".8"/></svg>
      </span>
      <span>
        PEPL HR
        <small>People · Culture · Growth</small>
      </span>
    </a>
  )
}
export function Avatar({
  name,
  size = 'normal',
}: {
  name: string
  size?: 'normal' | 'large' | 'small'
}) {
  const colors = ['mint', 'sand', 'rose', 'sage']
  return (
    <span
      aria-hidden="true"
      className={`avatar ${size} ${colors[name.charCodeAt(0) % 4]}`}
    >
      {name
        .split(' ')
        .filter(Boolean)
        .slice(0, 2)
        .map((n) => n[0])
        .join('')}
    </span>
  )
}
export function Badge({ children }: { children: string }) {
  return (
    <span
      className={`badge ${['pending', 'draft', 'sent_back', 'inputs_frozen', 'on_leave', 'overdue'].includes(children) ? 'amber' : ['absent', 'rejected', 'cancelled', 'critical'].includes(children) ? 'coral' : 'green'}`}
    >
      <span />
      {pretty(children)}
    </span>
  )
}
/**
 * A dashboard tile.
 *
 * When `href` is given the WHOLE tile is the target, not a small "View all"
 * link in the corner: the card already reads as one object, so the entire thing
 * should behave like one. A stretched overlay keeps the anchor a real link —
 * middle-click, copy address and keyboard focus all still work — while inner
 * links and buttons stay clickable because they sit above it.
 */
export function Card({
  title,
  href,
  children,
  className = '',
  subtitle,
}: {
  title?: string
  href?: string
  children: ReactNode
  className?: string
  subtitle?: string
}) {
  return (
    <section className={`card ${href ? 'card-linked' : ''} ${className}`}>
      {title && (
        <header className="card-head">
          <div>
            <h2>
              {href ? (
                <a className="card-target" href={href}>
                  {title}
                </a>
              ) : (
                title
              )}
            </h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
        </header>
      )}
      {children}
    </section>
  )
}
export function PageHeader({
  title,
  description,
  children,
  eyebrow,
}: {
  title: string
  description: string
  children?: ReactNode
  eyebrow?: string
}) {
  return (
    <header className="page-header">
      <div>
        <p className="eyebrow">{eyebrow ?? 'Your people workspace'}</p>
        <h1>{title}</h1>
        <p>{description}</p>
      </div>
      <div className="header-actions">{children}</div>
    </header>
  )
}
export function Stat({
  label,
  value,
  note,
  icon,
  variant = '',
  href,
}: {
  label: string
  value: ReactNode
  note: string
  icon: ReactNode
  variant?: string
  href?: string
}) {
  // The whole tile is the link, so there is no corner arrow: the label carries
  // the anchor and a stretched overlay takes the click. The accessible name is
  // the label itself, which is what a screen reader user needs to hear.
  return (
    <div className={`stat card ${href ? 'card-linked' : ''} ${variant}`}>
      <div className="stat-top">
        <span className="icon-box">{icon}</span>
      </div>
      <p>
        {href ? (
          <a className="card-target" href={href}>
            {label}
          </a>
        ) : (
          label
        )}
      </p>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  )
}
export function Empty({
  title = 'Nothing here yet',
  text = 'New records will appear here.',
  action,
}: {
  title?: string
  text?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Inbox size={23} />
      </span>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  )
}
export function SearchBox({
  value,
  onChange,
  placeholder = 'Search people...',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  return (
    <label className="search-box">
      <Search size={18} />
      <input
        aria-label={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
        >
          <X size={15} />
        </button>
      )}
    </label>
  )
}
export function ErrorBox({
  message,
  requestId,
  code,
}: {
  message: string
  /** Shown so a user can quote it to support; it is the only log correlator. */
  requestId?: string
  /** The API error code, when the caller has it. Some codes are not failures. */
  code?: string
}) {
  // A module the plan never included is not an error, it is a thing to buy, and
  // showing it in a red alert box teaches people the product is broken. The
  // switched-off case is different again: that one the admin can fix themselves.
  if (code === 'PLAN_UPGRADE_REQUIRED') {
    return (
      <div className="upgrade-box" role="status">
        <Lock size={19} aria-hidden="true" />
        <span>
          <strong>Not included in your plan</strong>
          {message}
          <a href="#/company/plan">See what each plan includes</a>
        </span>
      </div>
    )
  }
  if (code === 'MODULE_NOT_AVAILABLE') {
    return (
      <div className="upgrade-box" role="status">
        <Lock size={19} aria-hidden="true" />
        <span>
          <strong>Switched off for this company</strong>
          {message}
          <a href="#/settings">Open settings</a>
        </span>
      </div>
    )
  }
  return (
    <div className="error-box" role="alert">
      <AlertCircle size={19} />
      <span>
        {message}
        {requestId && <small className="error-ref">Reference {requestId}</small>}
      </span>
    </div>
  )
}
export function Skeleton() {
  return (
    <div
      className="skeleton-grid"
      aria-busy="true"
      aria-label="Loading workspace"
    >
      <div className="skeleton hero-skeleton" />
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="skeleton" />
      ))}
    </div>
  )
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDialogElement>(null)
  useEffect(() => {
    const old = document.activeElement as HTMLElement
    ref.current?.showModal()
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previous
      old?.focus()
    }
  }, [])
  return (
    <dialog
      ref={ref}
      className={`modal ${wide ? 'wide' : ''}`}
      onCancel={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose()
      }}
    >
      <header>
        <h2>{title}</h2>
        <Button variant="ghost" aria-label="Close dialog" onClick={onClose}>
          <X size={21} />
        </Button>
      </header>
      {children}
    </dialog>
  )
}
export function Tabs({
  value,
  onChange,
  items,
}: {
  value: string
  onChange: (v: string) => void
  items: string[]
}) {
  return (
    <div className="tabs" aria-label="View options">
      {items.map((item) => (
        <button
          key={item}
          className={value === item ? 'active' : ''}
          aria-pressed={value === item}
          onClick={() => onChange(item)}
        >
          {item}
        </button>
      ))}
    </div>
  )
}
export function Donut({
  segments,
  value,
  label,
}: {
  segments: { label: string; value: number }[]
  value: string | number
  label: string
}) {
  const sum = segments.reduce((n, s) => n + s.value, 0)
  let offset = 0
  return (
    <div className="donut-layout">
      <div className="donut">
        <svg
          viewBox="0 0 160 160"
          role="img"
          aria-label={
            segments.map((s) => `${s.label}: ${s.value}`).join(', ') ||
            'No records'
          }
        >
          <circle
            cx="80"
            cy="80"
            r="64"
            fill="none"
            stroke="var(--surface-muted)"
            strokeWidth="23"
          />
          {segments.map((s, i) => {
            const dash = sum ? (s.value / sum) * 402.124 : 0
            const item = (
              <circle
                key={s.label}
                cx="80"
                cy="80"
                r="64"
                fill="none"
                stroke={`var(--chart-${i % 6})`}
                strokeWidth="23"
                strokeDasharray={`${dash} ${402.124 - dash}`}
                strokeDashoffset={-offset}
                transform="rotate(-90 80 80)"
              />
            )
            offset += dash
            return item
          })}
        </svg>
        <div>
          <strong>{value}</strong>
          <small>{label}</small>
        </div>
      </div>
      <div className="legend">
        {segments.map((s, i) => (
          <div key={s.label}>
            <span
              className="legend-dot"
              style={{ background: `var(--chart-${i % 6})` }}
            />
            <span>{s.label}</span>
            <b>{s.value}</b>
          </div>
        ))}
      </div>
    </div>
  )
}
export function ViewLink({
  href,
  children,
}: {
  href: string
  children: ReactNode
}) {
  return (
    <a className="view-link" href={href}>
      {children}
      <ArrowRight size={17} />
    </a>
  )
}

/**
 * A password field with a show/hide toggle.
 *
 * Every password box in the app goes through this, so the toggle is the same
 * everywhere and cannot be forgotten on the next form. test/password-field.test.ts
 * fails if a bare password-typed input appears anywhere else in web/src.
 *
 * Callers pass `aria-label` with the same words as the visible label. The button
 * sits inside the caller's <label>, and without an explicit name the input would
 * be announced as "Password Show password" -- the button's own name folded into
 * the label's.
 *
 * Hidden by default and again on unmount: a revealed password does not survive
 * navigating away.
 */
export function PasswordInput(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'>) {
  const [shown, setShown] = useState(false)
  return (
    <span className="password-field">
      <input
        {...props}
        type={shown ? 'text' : 'password'}
        // Once it is plain text, the keyboard must not "help": autocorrect and
        // autocapitalise would quietly rewrite what somebody is checking.
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
      />
      <button
        type="button"
        className="password-toggle"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        onClick={() => setShown((value) => !value)}
      >
        {shown ? <EyeOff size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
      </button>
    </span>
  )
}
