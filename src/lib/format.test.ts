import { describe, it, expect } from 'vitest'
import { formatBytes } from './format'

describe('formatBytes', () => {
  it('handles empty / invalid sizes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(null)).toBe('0 B')
    expect(formatBytes(undefined)).toBe('0 B')
    expect(formatBytes(-5)).toBe('0 B')
  })

  it('formats bytes, KB, MB', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
