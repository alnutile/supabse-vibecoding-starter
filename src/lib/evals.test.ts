import { describe, it, expect } from 'vitest'
import { isVersionGreen, scoreChip, questionPublishState } from './evals'

describe('isVersionGreen', () => {
  it('is false without a usable run', () => {
    expect(isVersionGreen(null)).toBe(false)
    expect(isVersionGreen(undefined)).toBe(false)
    expect(isVersionGreen({ total: 0, passed: 0 })).toBe(false)
    expect(isVersionGreen({ total: null, passed: null })).toBe(false)
  })

  it('is green only when every case passed', () => {
    expect(isVersionGreen({ total: 5, passed: 5 })).toBe(true)
    expect(isVersionGreen({ total: 5, passed: 4 })).toBe(false)
  })
})

describe('scoreChip', () => {
  it('shows a green chip when all cases pass, using the stored score for the %', () => {
    // A 50/50 run whose weighted score rounds to 92 shows the stored score.
    expect(scoreChip({ total: 50, passed: 50, score: 92 }, 'live')).toEqual({
      label: '92% · 50/50 ✓',
      tone: 'green',
    })
    expect(scoreChip({ total: 5, passed: 5, score: 100 }, 'live')).toEqual({
      label: '100% · 5/5 ✓',
      tone: 'green',
    })
  })

  it('derives the percentage when score is absent', () => {
    expect(scoreChip({ total: 4, passed: 4 }, 'live')).toEqual({
      label: '100% · 4/4 ✓',
      tone: 'green',
    })
  })

  it('shows a red chip with the failing count', () => {
    expect(scoreChip({ total: 50, passed: 47, score: 94 }, 'live')).toEqual({
      label: '3 failing',
      tone: 'red',
    })
  })

  it('shows amber untested for a draft with no run', () => {
    expect(scoreChip(null, 'draft')).toEqual({ label: '⚠ untested', tone: 'amber' })
    expect(scoreChip({ total: 0, passed: 0 }, 'draft')).toEqual({
      label: '⚠ untested',
      tone: 'amber',
    })
  })

  it('shows a neutral dash for live/archived with no run', () => {
    expect(scoreChip(null, 'live')).toEqual({ label: '—', tone: 'none' })
    expect(scoreChip(undefined, 'archived')).toEqual({ label: '—', tone: 'none' })
  })
})

describe('questionPublishState', () => {
  it('cannot publish a non-draft chip', () => {
    expect(questionPublishState({ status: 'live', hasCase: true, guardCase: false })).toEqual({
      canPublish: false,
      blocked: false,
      reason: 'not-draft',
    })
  })

  it('blocks a draft with no proving case', () => {
    expect(questionPublishState({ status: 'draft', hasCase: false, guardCase: false })).toEqual({
      canPublish: false,
      blocked: true,
      reason: 'no-case',
    })
  })

  it('blocks a draft proven only by a guardrail case', () => {
    expect(questionPublishState({ status: 'draft', hasCase: true, guardCase: true })).toEqual({
      canPublish: false,
      blocked: true,
      reason: 'guardrail',
    })
  })

  it('allows a draft proven by a core case', () => {
    expect(questionPublishState({ status: 'draft', hasCase: true, guardCase: false })).toEqual({
      canPublish: true,
      blocked: false,
      reason: 'ok',
    })
  })
})
