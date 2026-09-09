import { Children, isValidElement, useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { DndContext, PointerSensor, KeyboardSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { SortableContext, useSortable, sortableKeyboardCoordinates, rectSortingStrategy, arrayMove } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { GripHorizontal, SlidersHorizontal, RotateCcw, Check, X, ArrowUp, ArrowDown } from 'lucide-react'
import { Button } from './ui'

type WidgetProps = { id: string; title: string; width: number; hero?: boolean; children: ReactNode }
type Layout = { order: string[]; hidden: string[]; widths: Record<string, number> }
const emptyLayout = (): Layout => ({ order: [], hidden: [], widths: {} })
function readLayout(key: string): Layout {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? 'null')
    if (!value || !Array.isArray(value.order) || !Array.isArray(value.hidden)) return emptyLayout()
    return {
      order: [...new Set<string>(value.order.filter((id: unknown) => typeof id === 'string'))],
      hidden: value.hidden.filter((id: unknown) => typeof id === 'string'),
      widths: Object.fromEntries(Object.entries(value.widths ?? {}).filter(([, width]) => [2, 3, 4, 6, 12].includes(width as number)).map(([id, width]) => [id, Number(width)])),
    }
  } catch { return emptyLayout() }
}
export function Widget({ children }: WidgetProps) { return <>{children}</> }

function SortableWidget({ widget, width, editing, resize, move, first, last }: {
  widget: WidgetProps; width: number; editing: boolean; resize: (width: number) => void; move: (direction: number) => void; first: boolean; last: boolean
}) {
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, transform, transition, isDragging } = useSortable({ id: widget.id, disabled: !editing })
  return <section ref={setNodeRef} data-widget-id={widget.id} aria-label={widget.title}
    className={`dashboard-widget ${widget.hero ? 'widget-hero' : ''} ${isDragging ? 'widget-dragging' : ''} ${editing ? 'widget-editing' : ''}`}
    style={{ '--widget-width': width, transform: CSS.Transform.toString(transform), transition } as CSSProperties}>
    {editing && <div className="widget-controls">
      <button ref={setActivatorNodeRef} {...attributes} {...listeners} className="widget-grip" aria-label={`Move ${widget.title}`}><GripHorizontal size={18} /><span>{widget.title}</span></button>
      <div className="widget-tools">
        <button aria-label={`Move ${widget.title} earlier`} disabled={first} onClick={() => move(-1)}><ArrowUp size={14} /></button>
        <button aria-label={`Move ${widget.title} later`} disabled={last} onClick={() => move(1)}><ArrowDown size={14} /></button>
        <select aria-label={`Width of ${widget.title}`} value={width} onChange={event => resize(Number(event.target.value))}>
          {[...new Set([widget.width, 3, 4, 6, 12])].filter(size => size >= widget.width).sort((a, b) => a - b)
            .map(size => <option key={size} value={size}>{size === 12 ? 'Full' : size === 6 ? 'Half' : size <= 3 ? 'Small' : 'Compact'}</option>)}
        </select>
      </div>
    </div>}
    <div className="widget-content" inert={editing}>{widget.children}</div>
  </section>
}

export function WidgetBoard({ children, account }: { children: ReactNode; account: string }) {
  const storageKey = `pepl:dashboard:v1:${account}`
  const widgets = Children.toArray(children).filter((child): child is ReactElement<WidgetProps> => isValidElement<WidgetProps>(child) && child.type === Widget).map(child => child.props)
  const [layout, setLayout] = useState<Layout>(() => readLayout(storageKey))
  const [saved, setSaved] = useState(layout)
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState('')
  // Transient confirmation, not persistent state: left on screen it reads as
  // leaked UI. Announced to assistive tech first, then cleared.
  useEffect(() => {
    if (!message) return
    const timer = setTimeout(() => setMessage(''), 6000)
    return () => clearTimeout(timer)
  }, [message])
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 7 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }))
  const available = new Map(widgets.map(widget => [widget.id, widget]))
  const order = [...layout.order.filter(id => available.has(id)), ...widgets.map(widget => widget.id).filter(id => !layout.order.includes(id))]
  const visible = order.filter(id => !layout.hidden.includes(id))
  const reorder = (from: string, to: string) => {
    if (from === to) return
    setLayout(current => ({ ...current, order: arrayMove(order, order.indexOf(from), order.indexOf(to)) }))
    setMessage(`${available.get(from)?.title} moved.`)
  }
  const onDragEnd = ({ active, over }: DragEndEvent) => { if (over) reorder(String(active.id), String(over.id)) }
  const save = () => {
    try { localStorage.setItem(storageKey, JSON.stringify(layout)); setSaved(layout); setEditing(false); setMessage('Dashboard layout saved in this browser.') }
    catch { setMessage('Browser storage is unavailable. Your layout is kept for this visit.'); setSaved(layout); setEditing(false) }
  }
  return <div className={`widget-workspace ${editing ? 'is-customizing' : ''}`}>
    <div className="dashboard-toolbar">
      <div><span className="status-dot" /><span>{editing ? 'Make this space yours' : 'Your workspace, your way'}</span></div>
      <div className="dashboard-toolbar-actions">
        {editing ? <><Button variant="ghost" onClick={() => { setLayout(emptyLayout()); setMessage('Default layout restored. Save to keep it.') }}><RotateCcw size={14} /> Reset</Button><Button variant="secondary" onClick={() => { setLayout(saved); setEditing(false); setMessage('Changes cancelled.') }}><X size={14} /> Cancel</Button><Button onClick={save}><Check size={14} /> Save layout</Button></> : <Button variant="secondary" onClick={() => { setEditing(true); setMessage('') }}><SlidersHorizontal size={15} /> Customize dashboard</Button>}
      </div>
    </div>
    <p className="widget-feedback" role="status">{message}</p>
    {editing && <div className="widget-library">
      <div><strong>Choose your widgets</strong><p>Drag the handles, or use Space, arrow keys and Space to drop. Escape cancels a drag. Widths adapt on smaller screens.</p></div>
      <div className="widget-choices">{widgets.map(widget => <label key={widget.id}><input type="checkbox" checked={!layout.hidden.includes(widget.id)} onChange={() => setLayout(current => ({ ...current, hidden: current.hidden.includes(widget.id) ? current.hidden.filter(id => id !== widget.id) : [...current.hidden, widget.id] }))} />{widget.title}</label>)}</div>
    </div>}
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={visible} strategy={rectSortingStrategy}>
        <div className="widget-grid">{visible.map((id, index) => {
          const widget = available.get(id)!
          // The width a widget declares is its readable MINIMUM. A hardcoded
          // floor here silently overrode narrower declarations (a 2-span stat
          // became 4), which is why the grid never matched the layout.
          const requested = layout.widths[id] ?? widget.width
          const width = Math.max(widget.width, requested)
          return <SortableWidget key={id} widget={widget} editing={editing} width={width} first={index === 0} last={index === visible.length - 1}
            resize={size => setLayout(current => ({ ...current, widths: { ...current.widths, [id]: size } }))}
            move={direction => { const target = visible[index + direction]; if (target) reorder(id, target) }} />
        })}</div>
      </SortableContext>
    </DndContext>
    {!visible.length && <div className="widget-empty"><h2>A little space to start fresh.</h2><p>Choose widgets in Customize dashboard to bring your overview back.</p></div>}
  </div>
}
