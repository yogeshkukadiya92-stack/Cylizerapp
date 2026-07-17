import { describe, expect, it } from 'vitest'
import { canUseDemoData, isLoopbackHostname } from './runtime'

describe('demo data runtime guard', () => {
  it('allows demo fallback only for a dev session on loopback', () => {
    expect(canUseDemoData('dev', 'localhost')).toBe(true)
    expect(canUseDemoData('dev', '127.0.0.1')).toBe(true)
    expect(canUseDemoData('dev', 'cylizerapp-production.up.railway.app')).toBe(false)
    expect(canUseDemoData('oidc', 'localhost')).toBe(false)
  })

  it('recognizes loopback hosts without treating public hosts as local', () => {
    expect(isLoopbackHostname('[::1]')).toBe(true)
    expect(isLoopbackHostname('127.18.2.3')).toBe(true)
    expect(isLoopbackHostname('callora.example.com')).toBe(false)
  })
})
