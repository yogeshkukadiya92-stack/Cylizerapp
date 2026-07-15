import { CalloraApiClient, defaultDevSession } from '../api/client'
import type { AuthSession } from './types'

export class DevAuthSession implements AuthSession {
  readonly mode = 'dev' as const
  readonly canSignIn = true
  readonly synchronousInitialization = {
    status: 'signed_in' as const,
    user: { subject: 'dev-user', displayName: 'Yogesh' },
  }
  private accessToken: string | null = null

  constructor(private readonly client = new CalloraApiClient()) {}

  async initialize() {
    return this.synchronousInitialization
  }

  async getAccessToken(signal?: AbortSignal): Promise<string | null> {
    if (signal?.aborted) throw new DOMException('The request was cancelled.', 'AbortError')
    if (this.accessToken) return this.accessToken
    const session = await this.client.createDevSession(defaultDevSession, signal)
    this.accessToken = session.accessToken
    return this.accessToken
  }

  async signIn(): Promise<void> {}

  async signOut(): Promise<void> {
    this.accessToken = null
  }

  async clear(): Promise<void> {
    this.accessToken = null
  }
}
