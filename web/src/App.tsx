import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Bell,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Menu,
  Search,
  Settings2,
  Users,
  Wallet,
  X,
  CheckCheck,
  ListTodo,
  Megaphone,
  Activity,
  ArrowUpRight,
  RefreshCw,
} from 'lucide-react'
import {
  api,
  ApiError,
  toErrorView,
  type ErrorView,
  fullName,
  pretty,
  dateLabel,
} from './api'
import type { Workspace } from './types'
import { ActionForm, Login, type FormSpec } from './forms'
import {
  Avatar,
  Brand,
  Button,
  Card,
  Empty,
  ErrorBox,
  Modal,
  SearchBox,
  Skeleton,
} from './ui'
import { Dashboard } from './Dashboard'
import { People, EmployeeProfile } from './People'
import { AttendancePage, ApprovalsPage, LeavePage } from './Workforce'
import {
  ActivityPage,
  AnnouncementsPage,
  ReportsPage,
  SettingsPage,
  TasksPage,
} from './Operations'
import { PayrollPage } from './Payroll'
import { PageTransition } from './PageTransition'
import { NAV, MORE, getRoute } from './app/nav'
import { screenFor } from './app/screen'
export function App() {
  const [data, setData] = useState<Workspace | null>(null),
    [loggedOut, setLoggedOut] = useState(false),
    [error, setError] = useState<ErrorView | null>(null),
    [route, setRoute] = useState(getRoute),
    [loading, setLoading] = useState(true),
    [refreshing, setRefreshing] = useState(false)
  const [form, setForm] = useState<FormSpec | null>(null),
    [toast, setToast] = useState(''),
    [more, setMore] = useState(false),
    [profileMenu, setProfileMenu] = useState(false),
    [mobile, setMobile] = useState(false),
    [searchOpen, setSearchOpen] = useState(false),
    [search, setSearch] = useState(''),
    [notifications, setNotifications] = useState(false),
    [revision, setRevision] = useState(0)
  const request = useRef(0),
    date = useRef(''),
    main = useRef<HTMLElement>(null),
    menus = useRef<HTMLDivElement>(null)
  const load = useCallback(async () => {
    const seq = ++request.current
    setRefreshing(true)
    try {
      const d = await api<Workspace>(
        `/workspace${date.current ? '?date=' + date.current : ''}`,
      )
      if (seq === request.current) {
        setData(d)
        setLoggedOut(false)
        setError(null)
        setRevision((n) => n + 1)
      }
    } catch (e) {
      if (seq === request.current) {
        if (e instanceof ApiError && e.status === 401) {
          setLoggedOut(true)
          setData(null)
        } else setError(toErrorView(e))
      }
    } finally {
      if (seq === request.current) {
        setLoading(false)
        setRefreshing(false)
      }
    }
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => {
    const update = () => {
      setRoute(getRoute())
      if (getRoute().split('/')[0] !== 'attendance' && date.current) {
        date.current = ''
        void load()
      }
      setMore(false)
      setProfileMenu(false)
      setMobile(false)
      setSearchOpen(false)
    }
    window.addEventListener('hashchange', update)
    return () => window.removeEventListener('hashchange', update)
  }, [])
  useLayoutEffect(() => {
    // Focus the new page without letting the browser scroll the main region into view.
    // Run after the route commits, so the previous page's height cannot affect the reset.
    main.current?.focus({ preventScroll: true })
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' })
  }, [route])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setSearchOpen((x) => !x)
      }
      if (e.key === 'Escape') {
        setMore(false)
        setProfileMenu(false)
        setMobile(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])
  useEffect(() => {
    if (!toast) return
    const timeout = setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timeout)
  }, [toast])
  useEffect(() => {
    document.title = `${pretty(route.split('/')[0])} · PEPL`
  }, [route])
  useEffect(() => {
    const dismiss = (e: PointerEvent) => {
      if (menus.current && !menus.current.contains(e.target as Node)) {
        setMore(false)
        setProfileMenu(false)
      }
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [])
  async function act(path: string, body: unknown, message: string) {
    try {
      await api(path, body)
      await load()
      setToast(message)
    } catch (e) {
      setToast((e as Error).message)
    }
  }
  async function onSuccess(message: string) {
    await load()
    setToast(message)
  }
  const allowed = (n: { permission?: string; module?: string }) =>
    !data ||
    ((!n.permission || data.permissions.includes(n.permission)) &&
      (!n.module || data.modules[n.module]))
  const nav = NAV.filter(allowed),
    extras = MORE.filter(allowed).filter(
      (n) => n.id !== 'settings' || data?.user.scope === 'all',
    ),
    all = [...nav, ...extras],
    section = route.split('/')[0]
  const permitted = all.some((n) => n.id === section)
  const props = data ? { data, open: setForm, act } : null
  const page = data && props
    ? screenFor({
        data, props, route, section, permitted, revision, setForm,
        load,
        onDate: (s) => {
          date.current = s
          void load()
        },
      })
    : null
  return (
    <>
      <a
        href="#main-content"
        className="skip-link"
        onClick={(e) => {
          e.preventDefault()
          main.current?.focus()
        }}
      >
        Skip to content
      </a>
      <div className={`app-shell ${loggedOut ? 'signed-out' : ''}`}>
        <header className="topbar" ref={menus}>
          <Brand />
          {data && (
            <>
              <nav
                className={`main-nav ${mobile ? 'mobile-open' : ''}`}
                aria-label="Main navigation"
              >
                {nav.map((n) => (
                  <a
                    key={n.id}
                    href={`#/${n.id}`}
                    className={section === n.id ? 'active' : ''}
                    aria-current={section === n.id ? 'page' : undefined}
                  >
                    <n.icon size={17} />
                    <span>{n.label}</span>
                  </a>
                ))}
                {extras.length > 0 && (
                  <div className="more-wrap">
                    <button
                      className={
                        extras.some((n) => n.id === section) ? 'active' : ''
                      }
                      aria-expanded={more}
                      onClick={() => {
                        setMore(!more)
                        setProfileMenu(false)
                      }}
                    >
                      More
                      <ChevronDown size={14} />
                    </button>
                    {more && (
                      <div className="dropdown more-dropdown">
                        {extras.map((n) => (
                          <a key={n.id} href={`#/${n.id}`}>
                            <n.icon size={17} />
                            {n.label}
                            {n.id === 'approvals' &&
                              data.approvals.length > 0 && (
                                <span className="count">
                                  {data.approvals.length}
                                </span>
                              )}
                          </a>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </nav>
              <div className="topbar-actions">
                <button
                  className="global-search"
                  aria-label="Search workspace"
                  onClick={() => setSearchOpen(true)}
                >
                  <Search size={17} />
                  <span>Find anything</span>
                  <kbd>⌘ K</kbd>
                </button>
                <button
                  className="notification-button"
                  aria-label={`Notifications, ${data.notifications.filter((n) => !n.read_at).length} unread`}
                  onClick={() => setNotifications(true)}
                >
                  <Bell size={20} />
                  {data.notifications.some((n) => !n.read_at) && <i />}
                </button>
                <div className="profile-wrap">
                  <button
                    className="profile-button"
                    aria-label={`Account menu for ${data.user.full_name}`}
                    aria-expanded={profileMenu}
                    onClick={() => {
                      setProfileMenu(!profileMenu)
                      setMore(false)
                    }}
                  >
                    <Avatar name={data.user.full_name} size="small" />
                    <span>
                      <strong>{data.user.full_name}</strong>
                      <small>
                        {pretty(data.user.roles[0] ?? 'Team member')}
                      </small>
                    </span>
                    <ChevronDown size={14} />
                  </button>
                  {profileMenu && (
                    <div className="dropdown profile-dropdown">
                      <div>
                        <strong>{data.company}</strong>
                        <small>{data.user.email}</small>
                      </div>
                      {data.user.employeeId &&
                        data.permissions.includes('employee.read') && (
                          <a href={`#/people/${data.user.employeeId}`}>
                            <Users size={17} />
                            My profile
                          </a>
                        )}
                      <button
                        onClick={async () => {
                          try {
                            await api('/auth/logout', {})
                            setData(null)
                            setLoggedOut(true)
                            setProfileMenu(false)
                            setSearch('')
                          } catch (e) {
                            setToast((e as Error).message)
                          }
                        }}
                      >
                        <LogOut size={17} />
                        Sign out
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className="mobile-toggle"
                  aria-label="Toggle navigation"
                  aria-expanded={mobile}
                  onClick={() => setMobile(!mobile)}
                >
                  {mobile ? <X size={22} /> : <Menu size={22} />}
                </button>
              </div>
            </>
          )}
        </header>
        <main
          id="main-content"
          ref={main}
          tabIndex={-1}
          className={loggedOut ? 'login-main' : 'workspace-main'}
        >
          {loading ? (
            <Skeleton />
          ) : loggedOut ? (
            <Login
              onSuccess={async () => {
                setLoggedOut(false)
                await load()
              }}
            />
          ) : (
            <>
              {error && (
                <div className="page-error">
                  <ErrorBox message={error.message} requestId={error.requestId} />
                  <Button variant="secondary" onClick={() => void load()}>
                    Try again
                  </Button>
                </div>
              )}
              <PageTransition route={route}>{page}</PageTransition>
            </>
          )}
        </main>
        {data && (
          <footer className="workspace-footer">
            <span>Made for people. Built for work.</span>
            <button onClick={() => void load()} disabled={refreshing}>
              <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
              {refreshing ? 'Refreshing…' : 'Refresh workspace'}
            </button>
            <span>
              {data.company} <span className="status-dot" />
            </span>
          </footer>
        )}
      </div>
      {form && (
        <ActionForm
          spec={form}
          onClose={() => setForm(null)}
          onSuccess={onSuccess}
        />
      )}
      {searchOpen && data && (
        <Modal title="Find your way" onClose={() => setSearchOpen(false)}>
          <div className="command-search">
            <SearchBox
              value={search}
              onChange={setSearch}
              placeholder="Search people, pages, or reports..."
            />
            <p className="eyebrow">Pages & actions</p>
            <div className="command-results">
              {all
                .filter((n) =>
                  n.label.toLowerCase().includes(search.toLowerCase()),
                )
                .map((n) => (
                  <a
                    key={n.id}
                    href={`#/${n.id}`}
                    onClick={() => setSearchOpen(false)}
                  >
                    <n.icon size={18} />
                    <span>{n.label}</span>
                    <ArrowUpRight size={16} />
                  </a>
                ))}
            </div>
            {data.permissions.includes('employee.read') && (
              <>
                <p className="eyebrow">People</p>
                <div className="command-results">
                  {data.employees
                    .filter((e) =>
                      `${fullName(e)} ${e.employee_number} ${e.department ?? ''}`
                        .toLowerCase()
                        .includes(search.toLowerCase()),
                    )
                    .slice(0, 8)
                    .map((e) => (
                      <a
                        key={e.id}
                        href={`#/people/${e.id}`}
                        onClick={() => setSearchOpen(false)}
                      >
                        <Avatar name={fullName(e)} size="small" />
                        <span>
                          {fullName(e)}
                          <small>
                            {e.department ?? 'Unassigned'} · {e.employee_number}
                          </small>
                        </span>
                        <ArrowUpRight size={16} />
                      </a>
                    ))}
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
      {notifications && data && (
        <Modal title="Your updates" onClose={() => setNotifications(false)}>
          <div className="notification-list">
            {data.notifications.length ? (
              <>
                <Button
                  variant="ghost"
                  disabled={!data.notifications.some((n) => !n.read_at)}
                  onClick={() =>
                    void act(
                      '/notifications/read',
                      {},
                      'Notifications marked as read.',
                    )
                  }
                >
                  <CheckCheck size={17} />
                  Mark all as read
                </Button>
                {data.notifications.map((n) => (
                  <article key={n.id} className={!n.read_at ? 'unread' : ''}>
                    <span className="icon-box">
                      <Bell size={18} />
                    </span>
                    <div>
                      <h3>{n.title}</h3>
                      <p>{n.body}</p>
                      <small>{dateLabel(n.created_at)}</small>
                    </div>
                  </article>
                ))}
              </>
            ) : (
              <Empty
                title="A quiet moment"
                text="Updates meant for you will appear here."
              />
            )}
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          <span>{toast}</span>
          <button
            aria-label="Dismiss notification"
            onClick={() => setToast('')}
          >
            <X size={17} />
          </button>
        </div>
      )}
    </>
  )
}
