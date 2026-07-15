import { ArrowLeft, Construction } from 'lucide-react'

interface ModulePreviewProps {
  module: string
  onBack: () => void
}

const moduleCopy: Record<string, string> = {
  Team: 'Employee onboarding, device health, access roles and performance targets will live here.',
  'Call logs': 'Searchable incoming, outgoing, missed and rejected call history will live here.',
  Leads: 'Lead assignment, statuses, follow-ups, notes and pipeline reporting will live here.',
  Reports: 'Periodic, employee, client and recovery reports will live here.',
  Recordings: 'Secure recording playback, storage controls and transcripts will live here.',
  Integrations: 'API keys, webhooks, CRM and lead-source connectors will live here.',
  Settings: 'Company, billing, notifications and mobile app policies will live here.',
}

export function ModulePreview({ module, onBack }: ModulePreviewProps) {
  return (
    <section className="module-preview">
      <div className="module-preview__icon"><Construction size={27} /></div>
      <p>Phase 2 module</p>
      <h1>{module}</h1>
      <span>{moduleCopy[module]}</span>
      <button className="secondary-button" onClick={onBack} type="button"><ArrowLeft size={17} /> Return to dashboard</button>
    </section>
  )
}
