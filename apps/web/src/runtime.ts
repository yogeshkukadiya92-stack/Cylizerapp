import type { AuthMode } from './auth/types'

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '')
  return normalized === 'localhost'
    || normalized === '::1'
    || normalized === '0.0.0.0'
    || normalized.startsWith('127.')
}

export function canUseDemoData(authMode: AuthMode, hostname = globalThis.location?.hostname ?? ''): boolean {
  return authMode === 'dev' && isLoopbackHostname(hostname)
}
