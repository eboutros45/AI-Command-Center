import { useEffect, useState } from 'react'
import type { Activity, ActivityFeed } from './useAgentActivity'
import './Knowledge.css'

function duration(start: number, end: number) {
  const seconds = Math.max(0, Math.floor((end - start) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export default function AgentActivity({ work, loading, error }: ActivityFeed) {
  const running = work.filter(item => item.status === 'running')
  const recent = work.filter(item => item.status !== 'running')
  const [now, setNow] = useState(Date.now)
  const hasActive = running.length > 0

  useEffect(() => {
    if (!hasActive) return
    const timer = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [hasActive])

  const renderWork = (items: Activity[]) => <ul className="activity-list">{items.map(item => (
    <li key={item.id}>
      <div className="activity-head">
        <strong>{item.title}</strong>
        <span className={`workflow-state ${item.status === 'completed' ? 'complete' : item.status === 'stopped' ? 'failed' : 'running'}`}>{item.status}</span>
      </div>
      <p className="activity-stage">{item.stage}{item.actor && item.actor !== item.title ? ` · ${item.actor}` : ''}</p>
      <p>{item.kind === 'agent_test' ? 'Agent test' : 'Workflow'}{item.model && ` · ${item.provider === 'openai' ? 'OpenAI' : 'Ollama'} · ${item.model}`} · {duration(item.startedAt, item.finishedAt ?? now)}</p>
    </li>
  ))}</ul>

  return (
    <section className="knowledge-workspace">
      <header className="workspace-head"><strong>Agent Activity</strong></header>
      <div className="knowledge-content">
        <div className="knowledge-heading">
          <h2>Agent Activity</h2>
          <p>Live agent tests and workflow steps from this app session.</p>
        </div>
        {error && <p className="action-error" role="alert">Could not connect to agent activity. {error}</p>}
        <section className="knowledge-card" aria-label="Active work">
          <h3>Active <small className="activity-count">{running.length}</small></h3>
          {loading ? <p role="status">Connecting to activity…</p> : hasActive ? renderWork(running) : <p>No work is running.</p>}
        </section>
        <section className="knowledge-card" aria-label="Recent activity">
          <h3>Recent this session</h3>
          {recent.length ? renderWork(recent) : <p>Finished and stopped runs appear here.</p>}
        </section>
      </div>
    </section>
  )
}
