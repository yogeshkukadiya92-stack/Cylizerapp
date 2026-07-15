import { AlertTriangle, LoaderCircle, LogIn, Phone, ShieldCheck } from 'lucide-react'
import type { AuthUiState } from '../auth/types'

interface AuthGateProps {
  canSignIn: boolean
  error: string | null
  onSignIn: () => void
  status: AuthUiState['status']
}

export function AuthGate({ canSignIn, error, onSignIn, status }: AuthGateProps) {
  const isBusy = status === 'checking' || status === 'redirecting' || status === 'signing_out'
  const isError = status === 'error'
  return (
    <main className="auth-screen">
      <section aria-labelledby="auth-title" className="auth-card">
        <div className="auth-brand"><span><Phone size={23} /></span>Callora</div>
        <div className={`auth-card__icon ${isError ? 'auth-card__icon--error' : ''}`}>
          {isBusy
            ? <LoaderCircle className="auth-spinner" size={26} />
            : isError
              ? <AlertTriangle size={25} />
              : <ShieldCheck size={25} />}
        </div>
        <p className="auth-card__eyebrow">Secure workspace</p>
        <h1 id="auth-title">
          {status === 'checking'
            ? 'Checking your session'
            : status === 'redirecting'
              ? 'Redirecting to sign in'
              : status === 'signing_out'
                ? 'Signing you out'
                : isError
                  ? 'Authentication unavailable'
                  : 'Sign in to Callora'}
        </h1>
        <p className="auth-card__copy">
          {isError
            ? error
            : isBusy
              ? 'This should only take a moment.'
              : 'Use your organization identity to open the team calling dashboard.'}
        </p>
        {!isBusy && canSignIn ? (
          <button className="primary-button auth-card__button" onClick={onSignIn} type="button">
            <LogIn size={18} />{isError ? 'Start a new sign-in' : 'Sign in'}
          </button>
        ) : null}
        {isError && !canSignIn ? (
          <p className="auth-card__hint">Ask an administrator to correct the OIDC environment configuration.</p>
        ) : null}
      </section>
    </main>
  )
}
