import { BellRing, CalendarClock, CheckCircle2, Clock3, Download, Filter, MoreHorizontal, Plus, Save, ToggleLeft, ToggleRight, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { NotificationEvent, NotificationPreference, ReportExportJob, ReportSchedule, SavedReportView } from '@callora/contracts'
import type { CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import type { AuthorizationFailure } from '../../auth/useAuth'
import { AccessibleDialog } from '../../components/AccessibleDialog'

interface Props { authSession?: AuthSession; client?: CalloraApiClient; onAuthenticationFailure?: (reason: AuthorizationFailure) => void; onNotify: (message: string) => void }

const demoSavedViews: SavedReportView[] = [
  { id: 'view_1', organizationId: 'org_demo', ownerUserId: 'user_demo', name: 'High-value leads', kind: 'lead_performance', filters: { score: '75+', period: 'This month' }, createdAt: '2026-07-14T07:00:00.000Z', updatedAt: '2026-07-14T07:00:00.000Z' },
  { id: 'view_2', organizationId: 'org_demo', ownerUserId: 'user_demo', name: 'Sales team performance', kind: 'employee_performance', filters: { team: 'Sales', period: 'Last 30 days' }, createdAt: '2026-07-13T07:00:00.000Z', updatedAt: '2026-07-13T07:00:00.000Z' },
  { id: 'view_3', organizationId: 'org_demo', ownerUserId: 'user_demo', name: 'Missed calls · this week', kind: 'never_attended', filters: { outcome: 'Missed', period: 'This week' }, createdAt: '2026-07-12T07:00:00.000Z', updatedAt: '2026-07-12T07:00:00.000Z' },
]

const demoSchedules: ReportSchedule[] = [
  { id: 'schedule_1', organizationId: 'org_demo', savedViewId: 'view_2', name: 'Daily lead summary', cadence: 'daily', localTime: '08:00', timeZone: 'Asia/Kolkata', format: 'pdf', recipients: ['manager@callora.test', 'owner@callora.test'], status: 'active', nextRunAt: '2026-07-16T02:30:00.000Z' },
  { id: 'schedule_2', organizationId: 'org_demo', savedViewId: 'view_2', name: 'Weekly sales performance', cadence: 'weekly', weekDay: 1, localTime: '09:00', timeZone: 'Asia/Kolkata', format: 'xlsx', recipients: ['sales@callora.test'], status: 'active', nextRunAt: '2026-07-20T03:30:00.000Z' },
  { id: 'schedule_3', organizationId: 'org_demo', savedViewId: 'view_3', name: 'Missed calls digest', cadence: 'daily', localTime: '10:00', timeZone: 'Asia/Kolkata', format: 'csv', recipients: ['ops@callora.test'], status: 'paused', nextRunAt: '2026-07-16T04:30:00.000Z' },
]

const events: Array<{ key: NotificationEvent; label: string }> = [
  { key: 'missed_call', label: 'Missed calls' }, { key: 'overdue_follow_up', label: 'Overdue follow-ups' },
  { key: 'device_offline', label: 'Device offline' }, { key: 'import_completed', label: 'Import completed' }, { key: 'export_ready', label: 'Export ready' },
]

const initialPreferences: NotificationPreference[] = events.map(({ key }) => ({ event: key, email: key !== 'import_completed', inApp: key !== 'device_offline' }))
const demoJobs: ReportExportJob[] = [{ id: 'job_1', kind: 'lead_performance', format: 'xlsx', status: 'processing', requestedAt: '2026-07-15T09:02:00.000Z' }]

function Toggle({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  const Icon = active ? ToggleRight : ToggleLeft
  return <button aria-label={label} aria-pressed={active} className={`automation-toggle ${active ? 'is-active' : ''}`} onClick={onClick} type="button"><Icon size={28} /></button>
}

export function ReportAutomationPage({ authSession, client, onAuthenticationFailure, onNotify }: Props) {
  const [savedViews, setSavedViews] = useState(demoSavedViews)
  const [schedules, setSchedules] = useState(demoSchedules)
  const [jobs, setJobs] = useState(demoJobs)
  const [preferences, setPreferences] = useState(initialPreferences)
  const [isScheduleOpen, setScheduleOpen] = useState(false)
  const [scheduleDraft, setScheduleDraft] = useState({ name: '', savedViewId: demoSavedViews[0]!.id, cadence: 'daily' as 'daily'|'weekly', weekDay: 1, localTime: '08:00', format: 'csv' as 'csv'|'xlsx'|'pdf', recipients: '' })
  const [isSaving, setSaving] = useState(false)
  const [downloadingJobId, setDownloadingJobId] = useState<string | null>(null)
  const activeCount = useMemo(() => schedules.filter((item) => item.status === 'active').length, [schedules])

  useEffect(() => {
    if (!authSession || !client) return
    const controller = new AbortController()
    void (async () => { try { const token=await authSession.getAccessToken(controller.signal); if(!token)return; const snapshot=await client.getReportAutomation(token,controller.signal); if(controller.signal.aborted)return; if(snapshot.savedViews.length)setSavedViews(snapshot.savedViews); setSchedules(snapshot.schedules); setJobs(snapshot.jobs); if(snapshot.preferences.length)setPreferences(snapshot.preferences) } catch { if(authSession.mode==='oidc') onAuthenticationFailure?.('service_unavailable') } })()
    return () => controller.abort()
  }, [authSession, client, onAuthenticationFailure])

  const token = async () => authSession?.getAccessToken()
  const toggle = async (event: NotificationEvent, channel: 'email' | 'inApp') => {
    const next=preferences.map((item) => item.event === event ? { ...item, [channel]: !item[channel] } : item)
    setPreferences(next)
    try { const accessToken=await token(); if(client&&accessToken) await client.updateNotificationPreferences(next,accessToken); onNotify('Notification preference saved') } catch { setPreferences(preferences); onNotify('Could not save notification preference') }
  }
  const saveView = async () => { try { const accessToken=await token(); if(!client||!accessToken){onNotify('Current report view saved');return} const view=await client.createSavedReportView({name:`Lead performance ${savedViews.length+1}`,kind:'lead_performance',filters:{period:'This month'}},accessToken); setSavedViews((current)=>[view,...current]); setScheduleDraft((current)=>({...current,savedViewId:view.id})); onNotify('Current report view saved') } catch { onNotify('Could not save report view') } }
  const createSchedule = async () => { const recipients=scheduleDraft.recipients.split(',').map((item)=>item.trim()).filter(Boolean); if(!scheduleDraft.name.trim()||recipients.length===0){onNotify('Enter a schedule name and at least one recipient');return} setSaving(true); try { const accessToken=await token(); if(!client||!accessToken){onNotify('Schedule created');setScheduleOpen(false);return} const created=await client.createReportSchedule({...scheduleDraft,name:scheduleDraft.name.trim(),recipients,...(scheduleDraft.cadence==='weekly'?{weekDay:scheduleDraft.weekDay}:{})},accessToken); setSchedules((current)=>[...current,created]); setScheduleOpen(false); onNotify('Report schedule created') } catch { onNotify('Could not create report schedule') } finally { setSaving(false) } }
  const toggleSchedule = async (item: ReportSchedule) => { const status: ReportSchedule['status']=item.status==='active'?'paused':'active'; try { const accessToken=await token(); const updated: ReportSchedule=client&&accessToken?await client.updateReportSchedule(item.id,status,accessToken):{...item,status}; setSchedules((current)=>current.map((schedule)=>schedule.id===item.id?updated:schedule)); onNotify(`Schedule ${status}`) } catch { onNotify('Could not update schedule') } }
  const queueExport = async () => { try { const accessToken=await token(); if(!client||!accessToken){onNotify('Export queued');return} const job=await client.createReportExport({kind:'lead_performance',format:'csv',parameters:{period:'this_month'}},accessToken); setJobs((current)=>[job,...current]); onNotify('Export queued') } catch { onNotify('Could not queue export') } }
  const downloadExport = async (job: ReportExportJob) => { if(!client||!authSession||job.status!=='ready'||downloadingJobId)return; setDownloadingJobId(job.id); try { const accessToken=await authSession.getAccessToken(); if(!accessToken)throw new Error('Authentication required'); const grant=await client.issueReportDownloadToken(job.id,accessToken); const file=await client.downloadReport(job.id,grant.token,accessToken); const href=URL.createObjectURL(file.blob); const anchor=document.createElement('a'); anchor.href=href; anchor.download=file.fileName; anchor.click(); URL.revokeObjectURL(href); onNotify('Report downloaded') } catch { onNotify('Could not download report') } finally { setDownloadingJobId(null) } }
  return <div className="report-automation-page">
    <section aria-label="Report automation metrics" className="automation-metrics">
      <article><CalendarClock/><span>Active schedules<strong>{activeCount}</strong></span></article>
      <article><Clock3/><span>Queued exports<strong>{jobs.length}</strong></span></article>
      <article><Download/><span>Ready downloads<strong>{jobs.filter((job)=>job.status==='ready').length}</strong></span></article>
      <article><BellRing/><span>Alerts enabled<strong>{preferences.filter((item) => item.email || item.inApp).length}</strong></span></article>
    </section>
    <div className="automation-grid">
      <div className="automation-main">
        <section className="automation-panel"><header><div><h2>Scheduled reports</h2><p>Organization-local runs are de-duplicated by reporting period.</p></div><button className="primary-button" onClick={() => setScheduleOpen(true)} type="button"><Plus size={16}/>Create schedule</button></header>
          <div className="automation-table-scroll"><table><thead><tr><th>Report name</th><th>Cadence</th><th>Recipients</th><th>Next run</th><th>Format</th><th>Status</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>{schedules.map((item) => <tr key={item.id}><td><strong>{item.name}</strong></td><td>{item.cadence === 'daily' ? `Daily · ${item.localTime}` : `Weekly · Mon ${item.localTime}`}</td><td>{item.recipients.length} recipient{item.recipients.length === 1 ? '' : 's'}</td><td>{new Intl.DateTimeFormat('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: item.timeZone }).format(new Date(item.nextRunAt))}</td><td className="format-cell">{item.format.toUpperCase()}</td><td><span className={`automation-status automation-status--${item.status}`}>{item.status}</span></td><td><button aria-label={`${item.status === 'active' ? 'Pause' : 'Resume'} ${item.name}`} className="table-icon-button" onClick={() => void toggleSchedule(item)}><MoreHorizontal size={18}/></button></td></tr>)}</tbody></table></div>
        </section>
        <section className="automation-panel"><header><div><h2>Queued exports</h2><p>Large reports run away from transactional requests.</p></div><button className="secondary-button" onClick={() => void queueExport()} type="button"><Download size={16}/>Queue export</button></header>{jobs.length ? jobs.map((job) => <div className="export-job" key={job.id}><span className="export-job__icon"><Download size={18}/></span><div><strong>{job.kind.replaceAll('_',' ')}</strong><small>{new Intl.DateTimeFormat('en-IN',{dateStyle:'medium',timeStyle:'short'}).format(new Date(job.requestedAt))} · {job.format.toUpperCase()}</small></div><div className="export-progress"><i><b style={{ width: job.status === 'ready' ? '100%' : job.status === 'processing' ? '62%' : '10%' }}/></i><span>{job.status}</span></div>{job.status==='ready'?<button className="secondary-button" disabled={downloadingJobId!==null} onClick={()=>void downloadExport(job)} type="button">{downloadingJobId===job.id?'Downloading…':'Download'}</button>:<span className={`automation-status automation-status--${job.status}`}>{job.status}</span>}</div>) : <div className="compact-empty">No exports queued yet.</div>}<footer><CheckCircle2 size={15}/>Ready downloads expire after 48 hours and require an opaque access token.</footer></section>
      </div>
      <aside className="automation-side">
        <section className="automation-panel"><header><div><h2>Saved views</h2><p>Reusable filters for reports and schedules.</p></div></header><div className="saved-view-list">{savedViews.map((view) => <article key={view.id}><Filter size={17}/><span><strong>{view.name}</strong><small>{Object.values(view.filters).flat().join(' · ')}</small></span><button aria-label={`Actions for ${view.name}`} className="table-icon-button"><MoreHorizontal size={17}/></button></article>)}</div><button className="secondary-button automation-wide-button" onClick={() => void saveView()} type="button"><Save size={16}/>Save current view</button></section>
        <section className="automation-panel preference-panel"><header><div><h2>Notification preferences</h2><p>Changes apply before the next queued delivery.</p></div></header><div className="preference-heading"><span>Event</span><span>Email</span><span>In-app</span></div>{preferences.map((item) => <div className="preference-row" key={item.event}><strong>{events.find(({ key }) => key === item.event)?.label}</strong><Toggle active={item.email} label={`${item.event} email`} onClick={() => toggle(item.event, 'email')}/><Toggle active={item.inApp} label={`${item.event} in-app`} onClick={() => toggle(item.event, 'inApp')}/></div>)}</section>
      </aside>
    </div>
    {isScheduleOpen ? <AccessibleDialog className="schedule-dialog" labelledBy="schedule-dialog-title" onClose={() => setScheduleOpen(false)}><form onSubmit={(event) => { event.preventDefault(); void createSchedule() }}><header className="dialog-header"><div><h2 id="schedule-dialog-title">Create report schedule</h2><p>Deliver a saved view on an organization-local cadence.</p></div><button aria-label="Close schedule editor" className="icon-button" onClick={() => setScheduleOpen(false)} type="button"><X size={18}/></button></header><div className="schedule-form"><label>Schedule name<input autoFocus onChange={(event)=>setScheduleDraft((current)=>({...current,name:event.target.value}))} placeholder="Daily manager summary" value={scheduleDraft.name}/></label><label>Saved view<select onChange={(event)=>setScheduleDraft((current)=>({...current,savedViewId:event.target.value}))} value={scheduleDraft.savedViewId}>{savedViews.map((view)=><option key={view.id} value={view.id}>{view.name}</option>)}</select></label><div className="schedule-form-row"><label>Cadence<select onChange={(event)=>setScheduleDraft((current)=>({...current,cadence:event.target.value as 'daily'|'weekly'}))} value={scheduleDraft.cadence}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label><label>Local time<input onChange={(event)=>setScheduleDraft((current)=>({...current,localTime:event.target.value}))} type="time" value={scheduleDraft.localTime}/></label><label>Format<select onChange={(event)=>setScheduleDraft((current)=>({...current,format:event.target.value as 'csv'|'xlsx'|'pdf'}))} value={scheduleDraft.format}><option value="pdf">PDF</option><option value="xlsx">XLSX</option><option value="csv">CSV</option></select></label></div><label>Recipients<input onChange={(event)=>setScheduleDraft((current)=>({...current,recipients:event.target.value}))} placeholder="manager@example.com, owner@example.com" value={scheduleDraft.recipients}/><small>Separate multiple email addresses with commas.</small></label></div><footer className="dialog-actions"><button className="secondary-button" onClick={()=>setScheduleOpen(false)} type="button">Cancel</button><button className="primary-button" disabled={isSaving} type="submit">{isSaving?'Creating…':'Create schedule'}</button></footer></form></AccessibleDialog> : null}
  </div>
}
