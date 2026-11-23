import { useEffect, useState } from 'react'
import type { Activity, ActivityFeed, ActivityStage, ActivityStatus } from './useAgentActivity'
import { providerNames } from './providers'
import './Knowledge.css'
import './AgentActivity.css'

const filters = [
  { value: 'all', label: 'All runs' },
  { value: 'agent_test', label: 'Agent tests' },
  { value: 'proposal', label: 'Workflows' },
] as const
const statusLabels = { running: 'Running', completed: 'Completed', stopped: 'Stopped' }
const kindLabels = { agent_test: 'Agent test', proposal: 'Workflow' }

function duration(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function contextLine({ actor, provider, model }: Pick<ActivityStage, 'actor' | 'provider' | 'model'>, omitActor?: string) {
  return [actor === omitActor ? null : actor, model && provider ? providerNames[provider] : null, model].filter(Boolean).join(' · ')
}

function StatusBadge({ status }: { status: ActivityStatus }) {
  return <span className={`activity-status is-${status}`}><i aria-hidden="true" />{statusLabels[status]}</span>
}

function RunCards({ runs, selectedId, onSelect, now }: {
  runs: Activity[]
  selectedId?: string
  onSelect: (id: string) => void
  now: number
}) {
  return (
    <ul className="activity-run-list">
      {runs.map(run => (
        <li key={run.id}>
          <button type="button" className="activity-run-card" aria-pressed={selectedId === run.id} onClick={() => onSelect(run.id)}>
            <span className={`activity-emblem kind-${run.kind}`} aria-hidden="true" />
            <span className="activity-run-copy">
              <strong>{run.title}</strong>
              <span key={run.stage} className="activity-run-stage">
                {run.stage}{run.actor && run.actor !== run.title ? ` · ${run.actor}` : ''}
              </span>
              <small>{contextLine({ ...run, actor: null }) || kindLabels[run.kind]}</small>
            </span>
            <span className="activity-run-meta">
              <StatusBadge status={run.status} />
              <small>{duration(run.startedAt, run.finishedAt ?? now)}</small>
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function RunTimeline({ run, now }: { run: Activity; now: number }) {
  const timeline = run.stages?.length ? run.stages : [{ ...run, label: run.stage }]
  return (
    <section className="activity-inspector" aria-label="Selected run">
      <div className="activity-inspector-heading">
        <div>
          <p>{kindLabels[run.kind]}</p>
          <h3>{run.title}</h3>
        </div>
        <StatusBadge status={run.status} />
      </div>
      <div className="activity-inspector-meta">
        <span>Started <time dateTime={new Date(run.startedAt).toISOString()}>{new Date(run.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time></span>
        <span>{duration(run.startedAt, run.finishedAt ?? now)} elapsed</span>
      </div>
      <h4>Timeline</h4>
      <ol className="activity-timeline">
        {timeline.map((stage, index) => (
          <li key={`${stage.startedAt}-${index}`} className={`is-${stage.status}`} aria-current={stage.status === 'running' ? 'step' : undefined}>
            <div className="activity-timeline-line">
              <strong>{stage.label}</strong>
              <span>{duration(stage.startedAt, stage.finishedAt ?? now)}</span>
            </div>
            {contextLine(stage) && <p>{contextLine(stage)}</p>}
          </li>
        ))}
      </ol>
      {run.status !== 'running' && <p className={`activity-outcome is-${run.status}`}>{run.stage}</p>}
    </section>
  )
}

export default function AgentActivity({ work, loading, error, openTests, openWorkflows }: ActivityFeed & {
  openTests: () => void
  openWorkflows: () => void
}) {
  const [filter, setFilter] = useState<(typeof filters)[number]['value']>('all')
  const [selectedId, setSelectedId] = useState<string>()
  const [now, setNow] = useState(Date.now)
  const activeCount = work.filter(item => item.status === 'running').length
  const completedCount = work.filter(item => item.status === 'completed').length
  const visible = filter === 'all' ? work : work.filter(item => item.kind === filter)
  const running = visible.filter(item => item.status === 'running')
  const recent = visible.filter(item => item.status !== 'running')
  const selected = visible.find(item => item.id === selectedId) ?? running[0] ?? recent[0]
  const hasActive = activeCount > 0

  useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActive])

  return (
    <section className="knowledge-workspace activity-workspace">
      <header className="workspace-head"><strong>Agent Activity</strong><span className="activity-session"><i aria-hidden="true" />{loading ? 'Connecting' : error ? 'Disconnected' : 'Current session'}</span></header>
      <div className="knowledge-content">
        <div className="activity-dashboard">
          <section className="activity-overview" aria-label="Session overview">
            <div>
              <h2>Agent Activity</h2>
              <p>Follow agent tests and workflows as they run.</p>
            </div>
            <dl>
              <div className={hasActive ? 'has-active' : ''}><dt>Running</dt><dd>{activeCount}</dd></div>
              <div><dt>Completed</dt><dd>{completedCount}</dd></div>
              <div><dt>Stopped</dt><dd>{work.length - activeCount - completedCount}</dd></div>
            </dl>
          </section>
          {error && <p className="action-error" role="alert">Could not connect to agent activity. {error}</p>}
          <div className="activity-filters" role="group" aria-label="Filter activity">
            {filters.map(item => <button type="button" key={item.value} aria-pressed={filter === item.value} onClick={() => setFilter(item.value)}>{item.label}</button>)}
          </div>
          <div className="activity-board">
            <div className="activity-lanes">
              <section className="activity-lane" aria-label="Active work">
                <h3>Running now <span>{running.length}</span></h3>
                {running.length > 0 ? <RunCards runs={running} selectedId={selected?.id} onSelect={setSelectedId} now={now} />
                  : <p className="activity-empty" role="status">{loading ? 'Connecting to activity…' : 'No matching runs in progress.'}</p>}
              </section>
              <section className="activity-lane" aria-label="Recent activity">
                <h3>Recent this session <span>{recent.length}</span></h3>
                {recent.length > 0 ? <RunCards runs={recent} selectedId={selected?.id} onSelect={setSelectedId} now={now} />
                  : <p className="activity-empty">Finished and stopped runs appear here.</p>}
              </section>
            </div>
            {selected ? <RunTimeline key={selected.id} run={selected} now={now} /> : <section className="activity-inspector activity-empty-inspector" aria-label="Run timeline">
              <span className="activity-emblem kind-proposal" aria-hidden="true" />
              <h3>{work.length ? 'No matching runs' : 'Ready for a run'}</h3>
              <p>{work.length ? 'Choose another filter to inspect a run.' : 'Start an agent test or workflow to see its steps here.'}</p>
              {work.length === 0 && <div className="workflow-actions">
                <button type="button" onClick={openTests}>Run &amp; Test</button>
                <button type="button" onClick={openWorkflows}>Workflows</button>
              </div>}
            </section>}
          </div>
        </div>
      </div>
    </section>
  )
}
