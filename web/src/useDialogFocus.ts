import { useEffect, useRef } from 'react'

/**
 * Keyboard containment for a hand-rolled dialog.
 *
 * The shared `Modal` in ui.tsx is a native `<dialog>` opened with
 * `showModal()`, so the browser traps focus and restores it for free. Several
 * surfaces do not use it — they render their own `role="dialog"` element
 * because they need a different shape — and those got none of that behaviour:
 * Tab walked straight out of the dialog into the page behind it, Escape did
 * nothing, and on close focus landed back at the top of the document.
 *
 * For someone using a keyboard or a screen reader that is not cosmetic. They
 * are answering a dialog while the reading position is somewhere else
 * entirely, and nothing says the dialog is still open.
 *
 * Usage:
 *
 *   const ref = useDialogFocus<HTMLElement>(open, onClose)
 *   return open ? <section ref={ref} role="dialog" aria-modal="true">…</section> : null
 *
 * Returns a ref to put on the dialog element.
 */
export function useDialogFocus<T extends HTMLElement>(
  open: boolean,
  onClose?: () => void,
): React.RefObject<T | null> {
  const ref = useRef<T>(null)
  // Held in a ref so a changing onClose identity does not re-run the effect
  // and re-steal focus from whatever the person is typing into.
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  useEffect(() => {
    if (!open) return
    const node = ref.current
    if (!node) return

    // Whatever had focus before, so it can be given back. Returning focus to
    // the control that opened the dialog is what lets someone carry on from
    // where they were instead of re-navigating the page.
    const opener = document.activeElement as HTMLElement | null

    const focusable = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )).filter((el) => el.offsetParent !== null || el === document.activeElement)

    // Move into the dialog. The first control, or the dialog itself when it
    // holds nothing focusable, so the reading position is inside either way.
    const first = focusable()[0]
    if (first) first.focus()
    else {
      node.setAttribute('tabindex', '-1')
      node.focus()
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current?.()
        return
      }
      if (event.key !== 'Tab') return
      const items = focusable()
      if (items.length === 0) {
        event.preventDefault()
        return
      }
      const firstItem = items[0]!
      const lastItem = items[items.length - 1]!
      const active = document.activeElement
      // Wrap at both ends. Without this, Tab past the last control lands on
      // the browser chrome and then on the page behind the dialog.
      if (event.shiftKey && (active === firstItem || !node.contains(active))) {
        event.preventDefault()
        lastItem.focus()
      } else if (!event.shiftKey && active === lastItem) {
        event.preventDefault()
        firstItem.focus()
      }
    }

    document.addEventListener('keydown', onKeyDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      // Only if focus is still inside the dialog: if the person has already
      // clicked elsewhere, yanking it back would be its own annoyance.
      if (!node.contains(document.activeElement) && document.activeElement !== document.body) return
      opener?.focus?.()
    }
  }, [open])

  return ref
}
