import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, DragEvent } from 'react'
import type { LeadImportJob, LeadImportPreview, LeadImportPreviewRow } from '@callora/contracts'
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Eye,
  FileText,
  LoaderCircle,
  RefreshCw,
  UploadCloud,
  X,
} from 'lucide-react'
import type { CalloraApiClient } from '../../api/client'
import type { AuthSession } from '../../auth/types'
import { parseLeadCsvFile, type LeadCsvParseResult } from './csv'
import { newRequestId } from './requestId'
import type { LeadOwnerOption } from './types'

interface LeadImportPanelProps {
  authSession: AuthSession
  canManage: boolean
  client: CalloraApiClient
  isLive: boolean
  owners: LeadOwnerOption[]
  onChanged: () => void
  onNotify: (message: string) => void
}

function importError(error: unknown): string {
  return error instanceof Error ? error.message : 'The import request could not be completed.'
}

function decisionLabel(decision: LeadImportPreviewRow['decision']): string {
  if (decision === 'invalid') return 'Error'
  return decision[0].toUpperCase() + decision.slice(1)
}

function leadName(row: LeadImportPreviewRow): string {
  return row.input.companyName?.trim() || [row.input.firstName, row.input.lastName].filter(Boolean).join(' ') || 'Unnamed lead'
}

function jobProgress(job: LeadImportJob): number {
  if (job.totalRows <= 0) return 0
  return Math.min(100, Math.round((job.processedRows / job.totalRows) * 100))
}

function formatJobDate(value: string): string {
  try {
    return new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return value
  }
}

export function LeadImportPanel({
  authSession,
  canManage,
  client,
  isLive,
  owners,
  onChanged,
  onNotify,
}: LeadImportPanelProps) {
  const [file, setFile] = useState<File | null>(null)
  const [parsed, setParsed] = useState<LeadCsvParseResult | null>(null)
  const [preview, setPreview] = useState<LeadImportPreview | null>(null)
  const [jobs, setJobs] = useState<LeadImportJob[]>([])
  const [selectedRow, setSelectedRow] = useState<number | null>(null)
  const [isParsing, setParsing] = useState(false)
  const [isPreviewing, setPreviewing] = useState(false)
  const [isCommitting, setCommitting] = useState(false)
  const [historyLoading, setHistoryLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const previewRequestIdRef = useRef(newRequestId())
  const commitIdsRef = useRef(new Map<string, string>())

  const ownerById = useMemo(() => new Map(owners.map((owner) => [owner.id, owner.name])), [owners])
  const activeRow = preview?.rows.find((row) => row.rowNumber === selectedRow)
    ?? preview?.rows.find((row) => row.issues.length > 0)
    ?? preview?.rows[0]

  const token = useCallback(async (signal?: AbortSignal) => {
    const accessToken = await authSession.getAccessToken(signal)
    if (!accessToken) throw new Error('Sign in again to continue.')
    return accessToken
  }, [authSession])

  const loadHistory = useCallback(async (signal?: AbortSignal) => {
    if (!isLive || !canManage) return
    setHistoryLoading(true)
    try {
      const response = await client.getLeadImportJobs(await token(signal), signal)
      setJobs(response.items)
    } catch (loadError) {
      if (!signal?.aborted) setError(importError(loadError))
    } finally {
      if (!signal?.aborted) setHistoryLoading(false)
    }
  }, [canManage, client, isLive, token])

  useEffect(() => {
    const controller = new AbortController()
    void loadHistory(controller.signal)
    return () => controller.abort()
  }, [loadHistory])

  useEffect(() => {
    if (preview?.job.status !== 'processing') return undefined
    const controller = new AbortController()
    const timeout = window.setTimeout(async () => {
      try {
        const next = await client.getLeadImport(preview.job.id, await token(controller.signal), controller.signal)
        setPreview(next)
        setJobs((current) => [next.job, ...current.filter((job) => job.id !== next.job.id)])
        if (next.job.status === 'completed') {
          onChanged()
          onNotify(`${next.job.importedRows} leads imported`)
        }
      } catch (pollError) {
        if (!controller.signal.aborted) setError(importError(pollError))
      }
    }, 900)
    return () => {
      controller.abort()
      window.clearTimeout(timeout)
    }
  }, [client, onChanged, onNotify, preview, token])

  const selectFile = async (nextFile: File) => {
    setFile(nextFile)
    setPreview(null)
    setSelectedRow(null)
    setError(null)
    setParsing(true)
    previewRequestIdRef.current = newRequestId()
    try {
      setParsed(await parseLeadCsvFile(nextFile))
    } catch (parseError) {
      setParsed({ headers: [], rows: [], issues: [{ message: importError(parseError) }] })
    } finally {
      setParsing(false)
    }
  }

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0]
    if (nextFile) void selectFile(nextFile)
    event.target.value = ''
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    const nextFile = event.dataTransfer.files[0]
    if (nextFile) void selectFile(nextFile)
  }

  const runPreview = async () => {
    if (!file || !parsed || parsed.rows.length === 0 || parsed.issues.length > 0 || !isLive) return
    setPreviewing(true)
    setError(null)
    try {
      const result = await client.previewLeadImport({
        requestId: previewRequestIdRef.current,
        fileName: file.name,
        rows: parsed.rows.map((row) => row.input),
      }, await token())
      setPreview(result)
      setSelectedRow(result.rows.find((row) => row.issues.length > 0)?.rowNumber ?? result.rows[0]?.rowNumber ?? null)
      setJobs((current) => [result.job, ...current.filter((job) => job.id !== result.job.id)])
    } catch (previewError) {
      setError(importError(previewError))
    } finally {
      setPreviewing(false)
    }
  }

  const commit = async (job: LeadImportJob) => {
    setCommitting(true)
    setError(null)
    try {
      let requestId = commitIdsRef.current.get(job.id)
      if (!requestId) {
        requestId = newRequestId()
        commitIdsRef.current.set(job.id, requestId)
      }
      const result = await client.commitLeadImport(job.id, { requestId }, await token())
      if (result.job.status === 'interrupted' || result.job.status === 'failed') {
        // A resume is a new bounded processing attempt. Keep the key stable only
        // while retrying this exact request; rotate it after a terminal receipt.
        commitIdsRef.current.delete(job.id)
      }
      const nextPreview = preview?.job.id === job.id ? { ...preview, job: result.job } : await client.getLeadImport(job.id, await token())
      setPreview(nextPreview)
      setJobs((current) => [result.job, ...current.filter((item) => item.id !== result.job.id)])
      if (result.job.status === 'completed') {
        onChanged()
        onNotify(`${result.job.importedRows} leads imported${result.replayed ? ' · replay confirmed' : ''}`)
      } else if (result.job.status === 'interrupted') {
        onNotify('Import paused safely · use Resume to continue')
      }
    } catch (commitError) {
      setError(importError(commitError))
    } finally {
      setCommitting(false)
    }
  }

  const viewJob = async (jobId: string) => {
    setError(null)
    try {
      const result = await client.getLeadImport(jobId, await token())
      setPreview(result)
      setFile(null)
      setParsed(null)
      setSelectedRow(result.rows.find((row) => row.issues.length > 0)?.rowNumber ?? result.rows[0]?.rowNumber ?? null)
    } catch (viewError) {
      setError(importError(viewError))
    }
  }

  const downloadErrors = async (job: LeadImportJob) => {
    try {
      const result = await client.downloadLeadImportErrors(job.id, await token())
      const href = URL.createObjectURL(result.blob)
      const anchor = document.createElement('a')
      anchor.href = href
      anchor.download = result.fileName
      anchor.click()
      URL.revokeObjectURL(href)
    } catch (downloadError) {
      setError(importError(downloadError))
    }
  }

  const resetFile = () => {
    setFile(null)
    setParsed(null)
    setPreview(null)
    setSelectedRow(null)
    setError(null)
    previewRequestIdRef.current = newRequestId()
  }

  const previewBlocked = !file || !parsed || parsed.rows.length === 0 || parsed.issues.length > 0 || !isLive || !canManage
  const activeJob = preview?.job

  return (
    <div className="lead-import-panel">
      {!isLive ? (
        <div className="operation-notice operation-notice--warning" role="status">
          Live API connection is required to preview and import customer data. CSV content remains only in this tab.
        </div>
      ) : null}
      {!canManage ? <div className="operation-notice" role="status">Your role cannot import leads.</div> : null}
      {error ? <div className="operation-notice operation-notice--error" role="alert">{error}</div> : null}

      <section aria-label="Choose and preview CSV" className="lead-import-upload">
        <label className="lead-import-drop" onDragOver={(event) => event.preventDefault()} onDrop={onDrop}>
          <UploadCloud aria-hidden="true" size={25} />
          <span><strong>Drag &amp; drop a CSV file</strong><small>or click to browse · max 1,000 rows / 2 MB</small></span>
          <input accept=".csv,text/csv" className="sr-only" disabled={!canManage || isParsing} onChange={onFileChange} type="file" />
        </label>
        <div className="lead-import-file" aria-live="polite">
          {file ? <><FileText size={19} /><span><strong>{file.name}</strong><small>{parsed?.rows.length ?? 0} rows</small></span><button aria-label="Remove selected CSV" className="icon-button" onClick={resetFile} type="button"><X size={18} /></button></> : <span>No CSV selected</span>}
        </div>
        <button className="secondary-button" disabled={previewBlocked || isPreviewing} onClick={() => void runPreview()} type="button">
          {isPreviewing || isParsing ? <LoaderCircle className="spin" size={17} /> : <Eye size={17} />}
          {isParsing ? 'Parsing…' : isPreviewing ? 'Previewing…' : 'Preview import'}
        </button>
        <button className="primary-button" disabled={!activeJob || activeJob.validRows === 0 || isCommitting || activeJob.status === 'completed' || activeJob.status === 'processing'} onClick={() => activeJob && void commit(activeJob)} type="button">
          {isCommitting || activeJob?.status === 'processing' ? <LoaderCircle className="spin" size={17} /> : <UploadCloud size={17} />}
          {activeJob?.status === 'interrupted' ? 'Resume' : 'Import valid rows'}
        </button>
      </section>

      {parsed?.issues.length ? (
        <div className="csv-structural-errors" role="alert">
          <strong>Fix the CSV structure before previewing</strong>
          <ul>{parsed.issues.map((issue, index) => <li key={`${issue.rowNumber ?? 0}-${index}`}>{issue.rowNumber ? `Row ${issue.rowNumber}: ` : ''}{issue.message}</li>)}</ul>
        </div>
      ) : null}

      {activeJob ? (
        <>
          <section aria-label="Import decision summary" className="lead-import-summary">
            <div className="import-summary--valid"><CheckCircle2 size={22} /><span><strong>{activeJob.validRows}</strong><small>Valid rows</small></span></div>
            <div className="import-summary--duplicate"><AlertCircle size={22} /><span><strong>{activeJob.duplicateRows}</strong><small>Duplicates</small></span></div>
            <div className="import-summary--error"><X size={22} /><span><strong>{activeJob.errorRows}</strong><small>Errors</small></span></div>
            <p>Only valid rows will be imported. Review issues before continuing.</p>
          </section>

          <section className="lead-import-preview" aria-label="Import preview">
            <div className="lead-import-preview__table">
              <table>
                <caption className="sr-only">CSV import row decisions</caption>
                <thead><tr><th>Row</th><th>Lead</th><th>Phone</th><th>Owner</th><th>Decision</th></tr></thead>
                <tbody>{preview?.rows.slice(0, 100).map((row) => (
                  <tr className={row.rowNumber === activeRow?.rowNumber ? 'import-row--selected' : ''} key={row.rowNumber}>
                    <td><button aria-label={`Inspect row ${row.rowNumber}`} onClick={() => setSelectedRow(row.rowNumber)} type="button">{row.rowNumber}</button></td>
                    <td>{leadName(row)}</td>
                    <td>{row.input.phoneNumber || 'Missing'}</td>
                    <td>{row.proposedAssignedEmployeeId ? ownerById.get(row.proposedAssignedEmployeeId) ?? 'Assigned by rule' : '—'}</td>
                    <td><span className={`import-decision import-decision--${row.decision}`}>{decisionLabel(row.decision)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <aside aria-label="Selected row details" className="lead-import-row-detail">
              <div className="lead-import-row-detail__heading">
                <strong>{activeRow ? `Details for row ${activeRow.rowNumber}` : 'Row details'}</strong>
                {activeJob.errorDownloadAvailable ? <button className="secondary-button" onClick={() => void downloadErrors(activeJob)} type="button"><Download size={15} />Download error CSV</button> : null}
              </div>
              {activeRow ? (
                <>
                  <span className={`import-decision import-decision--${activeRow.decision}`}>{decisionLabel(activeRow.decision)}</span>
                  {activeRow.issues.length ? <ul>{activeRow.issues.map((issue, index) => <li key={`${issue.field}-${index}`}><strong>{issue.field}</strong>{issue.message}</li>)}</ul> : <p>This row is ready to import.</p>}
                  <dl><div><dt>Lead</dt><dd>{leadName(activeRow)}</dd></div><div><dt>Phone</dt><dd>{activeRow.input.phoneNumber || 'Missing'}</dd></div><div><dt>Email</dt><dd>{activeRow.input.email || '—'}</dd></div></dl>
                </>
              ) : <p>Select a preview row to inspect its decision.</p>}
            </aside>
          </section>
        </>
      ) : null}

      <section className="recent-imports" aria-labelledby="recent-imports-heading">
        <div className="operation-section-heading"><h3 id="recent-imports-heading">Recent imports</h3><button aria-label="Refresh recent imports" className="icon-button" disabled={historyLoading} onClick={() => void loadHistory()} type="button"><RefreshCw className={historyLoading ? 'spin' : ''} size={17} /></button></div>
        <div className="recent-imports__scroll">
          <table>
            <thead><tr><th>File name</th><th>Status</th><th>Progress</th><th>Created on</th><th>Valid</th><th>Duplicate</th><th>Errors</th><th>Action</th></tr></thead>
            <tbody>{jobs.map((job) => <tr key={job.id}>
              <td data-label="File name">{job.fileName}</td><td data-label="Status"><span className={`import-job-status import-job-status--${job.status}`}>{job.status.replace('_', ' ')}</span></td>
              <td data-label="Progress"><progress max="100" value={jobProgress(job)} /> <small>{jobProgress(job)}%</small></td><td data-label="Created on">{formatJobDate(job.createdAt)}</td>
              <td data-label="Valid">{job.validRows}</td><td data-label="Duplicate">{job.duplicateRows}</td><td data-label="Errors">{job.errorRows}</td>
              <td data-label="Action">{job.status === 'interrupted' ? <button disabled={isCommitting} onClick={() => void commit(job)} type="button">Resume</button> : <button onClick={() => void viewJob(job.id)} type="button">View</button>}</td>
            </tr>)}</tbody>
          </table>
          {!historyLoading && jobs.length === 0 ? <div className="compact-empty" role="status">No import jobs yet.</div> : null}
        </div>
      </section>
    </div>
  )
}
