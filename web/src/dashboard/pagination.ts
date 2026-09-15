/** Pack an ordered, configurable grid without dropping or duplicating widgets. */
export function paginateWidgets(items: { id: string; span: number }[], maxRows: number): { ids: string[]; rows: number }[] {
  const pages: { ids: string[]; rows: number }[] = []
  let page = { ids: [] as string[], rows: 1 }
  let used = 0
  for (const item of items) {
    const span = Math.max(1, Math.min(12, item.span))
    if (used + span > 12) {
      if (page.rows >= Math.max(1, maxRows)) { pages.push(page); page = { ids: [], rows: 1 } }
      else page.rows++
      used = 0
    }
    page.ids.push(item.id)
    used += span
  }
  if (page.ids.length) pages.push(page)
  return pages
}
