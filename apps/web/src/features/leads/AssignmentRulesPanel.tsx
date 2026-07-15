import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, FormEvent } from 'react'
import type {
  CreateLeadAssignmentRuleInput,
  LeadAssignmentDryRun,
  LeadAssignmentRule,
  LeadAssignmentStrategy,
  LeadSource,
  LeadTemperature,
} from '@callora/contracts'
import { Check, LoaderCircle, Pencil, Play, Plus, RefreshCw, UsersRound } from 'lucide-react'
import type { CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import { newRequestId } from './requestId'
import type { LeadOwnerOption, LeadStatusOption } from './types'

interface AssignmentRulesPanelProps {
  authSession: AuthSession
  canAssign: boolean
  client: CalloraApiClient
  isLive: boolean
  owners: LeadOwnerOption[]
  statuses: LeadStatusOption[]
  onChanged: () => void
  onNotify: (message: string) => void
}

interface RuleDraft {
  name: string
  priority: string
  active: boolean
  strategy: LeadAssignmentStrategy
  employeeIds: string[]
  sources: LeadSource[]
  temperatures: LeadTemperature[]
  statusIds: string[]
}

const EMPTY_DRAFT: RuleDraft = {
  name: '',
  priority: '100',
  active: true,
  strategy: 'fixed_owner',
  employeeIds: [],
  sources: [],
  temperatures: [],
  statusIds: [],
}

const SOURCES: LeadSource[] = ['manual', 'csv_import', 'website', 'facebook', 'instagram', 'google_ads', 'india_mart', 'api', 'integration', 'unknown']
const TEMPERATURES: LeadTemperature[] = ['cold', 'warm', 'hot']

function selectedValues<T extends string>(event: ChangeEvent<HTMLSelectElement>): T[] {
  return [...event.target.selectedOptions].map((option) => option.value as T)
}

function ruleError(error: unknown): string {
  return error instanceof Error ? error.message : 'The assignment request could not be completed.'
}

function toDraft(rule: LeadAssignmentRule): RuleDraft {
  return {
    name: rule.name,
    priority: String(rule.priority),
    active: rule.active,
    strategy: rule.strategy,
    employeeIds: [...rule.employeeIds],
    sources: [...(rule.conditions.sources ?? [])],
    temperatures: [...(rule.conditions.temperatures ?? [])],
    statusIds: [...(rule.conditions.statusIds ?? [])],
  }
}

export function AssignmentRulesPanel({
  authSession,
  canAssign,
  client,
  isLive,
  owners,
  statuses,
  onChanged,
  onNotify,
}: AssignmentRulesPanelProps) {
  const [rules, setRules] = useState<LeadAssignmentRule[]>([])
  const [draft, setDraft] = useState<RuleDraft>(EMPTY_DRAFT)
  const [editingRuleId, setEditingRuleId] = useState<string | null>(null)
  const [dryRun, setDryRun] = useState<LeadAssignmentDryRun | null>(null)
  const [includeExisting, setIncludeExisting] = useState(false)
  const [confirmApply, setConfirmApply] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const applyRequestIdRef = useRef(newRequestId())
  const ownerById = useMemo(() => new Map(owners.map((owner) => [owner.id, owner.name])), [owners])

  const token = useCallback(async (signal?: AbortSignal) => {
    const accessToken = await authSession.getAccessToken(signal)
    if (!accessToken) throw new Error('Sign in again to continue.')
    return accessToken
  }, [authSession])

  const load = useCallback(async (signal?: AbortSignal) => {
    if (!isLive || !canAssign) return
    setLoading(true)
    setError(null)
    try {
      const response = await client.getLeadAssignmentRules(await token(signal), signal)
      setRules([...response.items].sort((left, right) => left.priority - right.priority))
    } catch (loadError) {
      if (!signal?.aborted) setError(ruleError(loadError))
    } finally {
      if (!signal?.aborted) setLoading(false)
    }
  }, [canAssign, client, isLive, token])

  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal)
    return () => controller.abort()
  }, [load])

  const resetDraft = () => {
    setDraft(EMPTY_DRAFT)
    setEditingRuleId(null)
  }

  const saveRule = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const priority = Number(draft.priority)
    if (!draft.name.trim() || !Number.isSafeInteger(priority) || priority < 1 || priority > 10_000 || draft.employeeIds.length === 0) return
    if (draft.strategy === 'fixed_owner' && draft.employeeIds.length !== 1) {
      setError('Fixed owner rules require exactly one owner.')
      return
    }
    const input: CreateLeadAssignmentRuleInput = {
      name: draft.name.trim(),
      priority,
      active: draft.active,
      strategy: draft.strategy,
      employeeIds: draft.employeeIds,
      conditions: {
        ...(draft.sources.length ? { sources: draft.sources } : {}),
        ...(draft.temperatures.length ? { temperatures: draft.temperatures } : {}),
        ...(draft.statusIds.length ? { statusIds: draft.statusIds } : {}),
      },
    }
    setSaving(true)
    setError(null)
    try {
      if (editingRuleId) {
        const existing = rules.find((rule) => rule.id === editingRuleId)
        if (!existing) throw new Error('The selected assignment rule is unavailable.')
        const updated = await client.updateLeadAssignmentRule(existing.id, {
          expectedVersion: existing.version,
          changes: input,
        }, await token())
        setRules((current) => current.map((rule) => rule.id === updated.id ? updated : rule).sort((left, right) => left.priority - right.priority))
        onNotify(`${updated.name} updated`)
      } else {
        const created = await client.createLeadAssignmentRule(input, await token())
        setRules((current) => [...current, created].sort((left, right) => left.priority - right.priority))
        onNotify(`${created.name} created`)
      }
      setDryRun(null)
      resetDraft()
    } catch (saveError) {
      setError(ruleError(saveError))
    } finally {
      setSaving(false)
    }
  }

  const toggleRule = async (rule: LeadAssignmentRule) => {
    setError(null)
    try {
      const updated = await client.updateLeadAssignmentRule(rule.id, {
        expectedVersion: rule.version,
        changes: { active: !rule.active },
      }, await token())
      setRules((current) => current.map((item) => item.id === updated.id ? updated : item))
      setDryRun(null)
      onNotify(`${updated.name} ${updated.active ? 'enabled' : 'disabled'}`)
    } catch (toggleError) {
      setError(ruleError(toggleError))
    }
  }

  const runDryRun = async () => {
    setLoading(true)
    setError(null)
    setConfirmApply(false)
    try {
      setDryRun(await client.dryRunLeadAssignmentRules(await token()))
    } catch (dryRunError) {
      setError(ruleError(dryRunError))
    } finally {
      setLoading(false)
    }
  }

  const apply = async () => {
    if (!includeExisting || !dryRun) return
    setApplying(true)
    setError(null)
    try {
      const result = await client.applyLeadAssignmentRules({
        requestId: applyRequestIdRef.current,
        includeExistingUnassigned: true,
      }, await token())
      onNotify(`${result.appliedLeads} existing leads assigned${result.replayed ? ' · replay confirmed' : ''}`)
      applyRequestIdRef.current = newRequestId()
      setConfirmApply(false)
      setIncludeExisting(false)
      setDryRun(result)
      onChanged()
    } catch (applyError) {
      setError(ruleError(applyError))
    } finally {
      setApplying(false)
    }
  }

  if (!isLive || !canAssign) {
    return <div className="operation-notice" role="status">{!isLive ? 'A live API connection is required to manage assignment rules.' : 'Your role cannot manage assignment rules.'}</div>
  }

  return (
    <div className="assignment-rules-panel">
      {error ? <div className="operation-notice operation-notice--error" role="alert">{error}</div> : null}
      <div className="assignment-rules-layout">
        <section aria-labelledby="assignment-rules-heading" className="assignment-rule-list">
          <div className="operation-section-heading"><div><h3 id="assignment-rules-heading">Assignment rules</h3><p>Rules run in priority order for eligible unassigned leads.</p></div><button aria-label="Refresh assignment rules" className="icon-button" disabled={loading} onClick={() => void load()} type="button"><RefreshCw className={loading ? 'spin' : ''} size={17} /></button></div>
          {rules.map((rule) => (
            <article className={`assignment-rule-row ${rule.active ? '' : 'assignment-rule-row--inactive'}`} key={rule.id}>
              <span className="assignment-rule-priority">{rule.priority}</span>
              <div><strong>{rule.name}</strong><p>{rule.strategy === 'fixed_owner' ? 'Fixed owner' : 'Round robin'} · {rule.employeeIds.map((id) => ownerById.get(id) ?? 'Unknown owner').join(', ')}</p></div>
              <button aria-label={`Edit ${rule.name}`} className="icon-button" onClick={() => { setEditingRuleId(rule.id); setDraft(toDraft(rule)) }} type="button"><Pencil size={16} /></button>
              <label className="rule-switch"><input checked={rule.active} onChange={() => void toggleRule(rule)} type="checkbox" /><span>{rule.active ? 'Active' : 'Disabled'}</span></label>
            </article>
          ))}
          {!loading && rules.length === 0 ? <div className="compact-empty">No assignment rules yet.</div> : null}
        </section>

        <form className="assignment-rule-form" onSubmit={saveRule}>
          <div className="operation-section-heading"><div><h3>{editingRuleId ? 'Edit rule' : 'Create rule'}</h3><p>Leave a condition empty to match any value.</p></div>{editingRuleId ? <button onClick={resetDraft} type="button">Cancel edit</button> : <Plus size={18} />}</div>
          <div className="assignment-form-grid"><label>Name<input maxLength={120} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} required value={draft.name} /></label><label>Priority<input max="10000" min="1" onChange={(event) => setDraft((current) => ({ ...current, priority: event.target.value }))} required type="number" value={draft.priority} /></label></div>
          <label>Strategy<select onChange={(event) => setDraft((current) => ({ ...current, strategy: event.target.value as LeadAssignmentStrategy, employeeIds: event.target.value === 'fixed_owner' ? current.employeeIds.slice(0, 1) : current.employeeIds }))} value={draft.strategy}><option value="fixed_owner">Fixed owner</option><option value="round_robin">Round robin</option></select></label>
          <label>Eligible owners<select aria-describedby="owner-select-hint" multiple onChange={(event) => setDraft((current) => ({ ...current, employeeIds: selectedValues(event) }))} required size={Math.min(4, Math.max(2, owners.length))} value={draft.employeeIds}>{owners.map((owner) => <option key={owner.id} value={owner.id}>{owner.name}</option>)}</select><small id="owner-select-hint">Choose one owner for fixed rules; one or more for round robin.</small></label>
          <div className="assignment-form-grid"><label>Sources<select multiple onChange={(event) => setDraft((current) => ({ ...current, sources: selectedValues<LeadSource>(event) }))} size={4} value={draft.sources}>{SOURCES.map((source) => <option key={source} value={source}>{source.replaceAll('_', ' ')}</option>)}</select></label><label>Temperatures<select multiple onChange={(event) => setDraft((current) => ({ ...current, temperatures: selectedValues<LeadTemperature>(event) }))} size={3} value={draft.temperatures}>{TEMPERATURES.map((temperature) => <option key={temperature}>{temperature}</option>)}</select></label></div>
          <label>Statuses<select multiple onChange={(event) => setDraft((current) => ({ ...current, statusIds: selectedValues(event) }))} size={Math.min(4, Math.max(2, statuses.length))} value={draft.statusIds}>{statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>
          <label className="rule-active-checkbox"><input checked={draft.active} onChange={(event) => setDraft((current) => ({ ...current, active: event.target.checked }))} type="checkbox" />Enable this rule</label>
          <button className="primary-button" disabled={saving} type="submit">{saving ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}{saving ? 'Saving…' : editingRuleId ? 'Save changes' : 'Create rule'}</button>
        </form>
      </div>

      <section aria-labelledby="assignment-dry-run-heading" className="assignment-dry-run">
        <div className="operation-section-heading"><div><h3 id="assignment-dry-run-heading">Dry-run existing unassigned leads</h3><p>Review the impact before any owner changes are made.</p></div><button className="secondary-button" disabled={loading || rules.length === 0} onClick={() => void runDryRun()} type="button"><Play size={16} />Run dry-run</button></div>
        {dryRun ? <div className="assignment-dry-run__result"><div><strong>{dryRun.matchedLeads}</strong><span>Matched</span></div><div><strong>{dryRun.unmatchedLeads}</strong><span>Unmatched</span></div><div className="assignment-distribution"><strong>Owner distribution</strong>{dryRun.distribution.map((item) => <span key={item.employeeId}>{ownerById.get(item.employeeId) ?? 'Unknown owner'} <b>{item.leadCount}</b></span>)}</div></div> : <div className="compact-empty">Run a dry-run to see matched leads and owner distribution.</div>}
        <label className="apply-existing-checkbox"><input checked={includeExisting} onChange={(event) => { setIncludeExisting(event.target.checked); setConfirmApply(false) }} type="checkbox" />Apply active rules to existing unassigned leads</label>
        {confirmApply ? <div className="operation-confirm" role="alert"><span>This will change owners on up to {dryRun?.matchedLeads ?? 0} leads and create audit history.</span><button className="primary-button" disabled={applying} onClick={() => void apply()} type="button">{applying ? 'Applying…' : 'Confirm apply'}</button><button className="secondary-button" onClick={() => setConfirmApply(false)} type="button">Cancel</button></div> : <button className="primary-button" disabled={!includeExisting || !dryRun || dryRun.matchedLeads === 0} onClick={() => setConfirmApply(true)} type="button"><UsersRound size={17} />Apply rules</button>}
      </section>
    </div>
  )
}
