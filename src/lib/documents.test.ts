import { describe, it, expect } from 'vitest'
import { splitPinned } from './documents'

describe('splitPinned', () => {
  it('separates pinned from unpinned, preserving relative order', () => {
    const docs = [
      { id: 'a', pinned: false },
      { id: 'b', pinned: true },
      { id: 'c', pinned: false },
      { id: 'd', pinned: true },
    ]
    expect(splitPinned(docs)).toEqual({
      pinned: [{ id: 'b', pinned: true }, { id: 'd', pinned: true }],
      rest: [{ id: 'a', pinned: false }, { id: 'c', pinned: false }],
    })
  })

  it('handles no pinned docs', () => {
    const docs = [{ id: 'a', pinned: false }]
    expect(splitPinned(docs)).toEqual({ pinned: [], rest: docs })
  })

  it('handles an empty list', () => {
    expect(splitPinned([])).toEqual({ pinned: [], rest: [] })
  })
})
