/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string
  readonly VITE_AUTH_MODE?: 'dev' | 'oidc'
  readonly VITE_DEV_ORGANIZATION_ID?: 'org_alpha' | 'org_beta'
  readonly VITE_DEV_ROLE?: 'owner' | 'admin' | 'manager' | 'analyst' | 'employee'
  readonly VITE_OIDC_AUTHORITY?: string
  readonly VITE_OIDC_CLIENT_ID?: string
  readonly VITE_OIDC_REDIRECT_URI?: string
  readonly VITE_OIDC_POST_LOGOUT_REDIRECT_URI?: string
  readonly VITE_OIDC_SCOPE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
