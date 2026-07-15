import { useCallback, useEffect, useState } from 'react'
import type { AuthSession, AuthUiState } from './types'

export type AuthorizationFailure = 'unauthenticated' | 'forbidden' | 'service_unavailable'

function readableError(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : 'Authentication could not be completed. Please try again.'
}

export function useAuth(authSession: AuthSession) {
  const [state, setState] = useState<AuthUiState>(() => {
    const synchronous = authSession.synchronousInitialization
    return synchronous?.status === 'signed_in'
      ? { status: 'signed_in', user: synchronous.user, error: null }
      : { status: 'checking', user: null, error: null }
  })

  useEffect(() => {
    if (authSession.synchronousInitialization) return undefined
    let active = true
    const initialize = async () => {
      try {
        const result = await authSession.initialize()
        if (!active) return
        setState(result.status === 'signed_in'
          ? { status: 'signed_in', user: result.user, error: null }
          : { status: 'signed_out', user: null, error: null })
      } catch (error) {
        if (!active) return
        setState({ status: 'error', user: null, error: readableError(error) })
      }
    }
    void initialize()
    return () => {
      active = false
    }
  }, [authSession])

  const signIn = useCallback(async () => {
    setState({ status: 'redirecting', user: null, error: null })
    try {
      const returnUrl = `${window.location.pathname}${window.location.search}${window.location.hash}`
      await authSession.signIn(returnUrl)
    } catch (error) {
      setState({ status: 'error', user: null, error: readableError(error) })
    }
  }, [authSession])

  const signOut = useCallback(async () => {
    setState((current) => current.status === 'signed_in'
      ? { status: 'signing_out', user: current.user, error: null }
      : current)
    try {
      await authSession.signOut()
      setState({ status: 'signed_out', user: null, error: null })
    } catch (error) {
      setState({ status: 'error', user: null, error: readableError(error) })
    }
  }, [authSession])

  const expireSession = useCallback(() => {
    setState({
      status: 'error',
      user: null,
      error: 'Your session expired or is no longer authorized. Start a new sign-in to continue.',
    })
    void authSession.clear().catch(() => undefined)
  }, [authSession])

  const handleAuthorizationFailure = useCallback((reason: AuthorizationFailure) => {
    if (reason === 'forbidden') {
      setState({
        status: 'error',
        user: null,
        error: 'Your account is signed in but does not have permission to access this Callora workspace.',
      })
      return
    }
    if (reason === 'service_unavailable') {
      setState({
        status: 'error',
        user: null,
        error: 'Callora could not load live workspace data. Demo data is disabled in OIDC mode.',
      })
      return
    }
    expireSession()
  }, [expireSession])

  useEffect(() => {
    if (authSession.mode !== 'oidc' || state.status !== 'signed_in' || !state.user.expiresAt) return undefined
    const millisecondsUntilExpiry = (state.user.expiresAt * 1000) - Date.now()
    if (millisecondsUntilExpiry <= 0) {
      expireSession()
      return undefined
    }
    const timeout = window.setTimeout(expireSession, Math.min(millisecondsUntilExpiry, 2_147_000_000))
    return () => window.clearTimeout(timeout)
  }, [authSession.mode, expireSession, state])

  return {
    ...state,
    canSignIn: authSession.canSignIn,
    mode: authSession.mode,
    signIn,
    signOut,
    expireSession,
    handleAuthorizationFailure,
  }
}
