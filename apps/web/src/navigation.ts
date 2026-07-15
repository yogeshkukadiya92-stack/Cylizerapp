export const APP_MODULES = [
  'Dashboard',
  'Team',
  'Call logs',
  'Leads',
  'Reports',
  'Recordings',
  'Integrations',
  'Settings',
] as const

export type AppModule = (typeof APP_MODULES)[number]
