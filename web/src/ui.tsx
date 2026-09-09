import {
  useEffect,
  useRef,
  type ReactNode,
  type ButtonHTMLAttributes,
} from 'react'
import {
  ArrowUpRight,
  ArrowRight,
  Inbox,
  X,
  Search,
  AlertCircle,
  Leaf,
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
        <Leaf size={27} />
      </span>
      <span>
        pepl<span className="brand-dot">.</span>
        <small>People, at the heart.</small>
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
export function Card({
  title,
  link,
  href,
  children,
  className = '',
  subtitle,
}: {
  title?: string
  link?: string
  href?: string
  children: ReactNode
  className?: string
  subtitle?: string
}) {
  return (
    <section className={`card ${className}`}>
      {title && (
        <header className="card-head">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          {href && (
            <a className="text-link" href={href}>
              {link ?? 'View all'}
              <ArrowUpRight size={16} />
            </a>
          )}
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
  return (
    <div className={`stat card ${variant}`}>
      <div className="stat-top">
        <span className="icon-box">{icon}</span>
        {href && (
          <a href={href} className="icon-link" aria-label={`View ${label}`}>
            <ArrowUpRight size={18} />
          </a>
        )}
      </div>
      <p>{label}</p>
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
}: {
  message: string
  /** Shown so a user can quote it to support; it is the only log correlator. */
  requestId?: string
}) {
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
