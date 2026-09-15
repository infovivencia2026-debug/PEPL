import { describe, expect, it } from 'vitest'
import { paginateWidgets } from '../web/src/dashboard/pagination.ts'

describe('dashboard viewport pagination', () => {
  it('keeps order and every widget across multiple pages', () => {
    const items = [4, 2, 2, 2, 2, 4, 4, 4, 3, 3, 4, 2, 6, 6].map((span, index) => ({ id: String(index), span }))
    const pages = paginateWidgets(items, 2)
    expect(pages.map(page => page.ids)).toEqual([['0', '1', '2', '3', '4', '5', '6', '7'], ['8', '9', '10', '11', '12', '13']])
    expect(pages.flatMap(page => page.ids)).toEqual(items.map(item => item.id))
  })
  it('respects full-width cards after a resize and phone-sized rows', () => {
    expect(paginateWidgets([{ id: 'hero', span: 12 }, { id: 'a', span: 6 }, { id: 'b', span: 6 }, { id: 'chart', span: 12 }], 1)).toEqual([
      { ids: ['hero'], rows: 1 }, { ids: ['a', 'b'], rows: 1 }, { ids: ['chart'], rows: 1 },
    ])
  })
  it('supports an empty customized dashboard and clamps invalid row counts', () => {
    expect(paginateWidgets([], 2)).toEqual([])
    expect(paginateWidgets([{ id: 'a', span: 12 }, { id: 'b', span: 12 }], 0)).toHaveLength(2)
  })
})
