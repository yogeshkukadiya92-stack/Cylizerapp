import { CalloraApiClient } from '../api/client'
import type { AuthSession } from './types'
export class BuiltinAuthSession implements AuthSession {
  readonly mode = 'builtin' as const; readonly canSignIn = true; private accessToken: string | null = null
  constructor(private readonly client = new CalloraApiClient({ authMode: 'builtin' })) {}
  async initialize() { return this.accessToken ? { status: 'signed_in' as const, user: { subject: 'builtin-owner', displayName: 'Administrator' } } : { status: 'signed_out' as const, user: null } }
  async getAccessToken() { return this.accessToken }
  async signIn() { const accessKey = window.prompt('Enter the Callora administrator access key'); if (!accessKey) return; const session = await this.client.createBuiltinSession(accessKey); this.accessToken = session.accessToken }
  async signOut() { this.accessToken = null }
  async clear() { this.accessToken = null }
}
