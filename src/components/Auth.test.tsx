import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Auth } from './Auth'

describe('Auth', () => {
  it('renders the sign-in screen with email + magic-link options', () => {
    render(<Auth />)
    expect(screen.getByPlaceholderText('you@example.com')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Email me a magic link' }),
    ).toBeInTheDocument()
  })
})
