import { describe, expect, it } from 'vitest'
import { quotePosixShell } from './shell-argument-quoting'

// ── quotePosixShell ──────────────────────────────────────────────────────

describe('quotePosixShell', () => {
  it('wraps string in single quotes', () => {
    expect(quotePosixShell('hello')).toBe("'hello'")
  })

  it('escapes embedded single quotes', () => {
    expect(quotePosixShell("it's")).toBe("'it'\\''s'")
  })

  it('handles empty string', () => {
    expect(quotePosixShell('')).toBe("''")
  })

  it('handles special characters', () => {
    expect(quotePosixShell('foo bar; rm -rf /')).toBe("'foo bar; rm -rf /'")
  })
})
