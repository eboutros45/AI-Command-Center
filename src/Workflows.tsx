import { useEffect, useState, type FormEvent } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import './Knowledge.css'

type Provider = 'ollama' | 'openai'
type Stage = 'retrieve' | 'draft' | 'review' | 'revise'
type Step = { stage: Stage; status: 'running' | 'complete' | 'failed' | 'skipped'; output: string; error: string | null }
type Excerpt = { path: string; startLine: number; endLine: number; text: string }
type ProposalRun = {
  id: string
  timestamp: number
  provider: Provider
  model: string
  brief: string
  query: string
  drafter: string
  reviewer: string
  sources: { excerpts: Excerpt[]; filesSearched: number; skippedFiles: number; limited: boolean } | null
  steps: Step[]
  proposal: string | null
}
type Asset = { name: string; path: string; relativePath: string; status: string }
type ProposalResult = { run: ProposalRun; saveError: string | null }

const stages: { id: Stage; label: string; detail: string }[] = [
  { id: 'retrieve', label: 'Retrieve sources', detail: 'Find passages that support the brief.' },
  { id: 'draft', label: 'Draft proposal', detail: 'Apply the selected drafting skill.' },
  { id: 'review', label: 'Review draft', detail: 'Ask the review agent to check it against the brief and sources.' },
  { id: 'revise', label: 'Revise if needed', detail: 'Make one revision when the reviewer requests changes.' },
]
const providerNames = { ollama: 'Ollama', openai: 'OpenAI' }

export default function Workflows({ libraryRoot, skills, agents, openLibrary }: {
  libraryRoot?: string
  skills: Asset[]
  agents: Asset[]
  openLibrary: () => void
}) {
  const [folder, setFolder] = useState(() => localStorage.getItem('knowledgeFolder') ?? '')
  const [query, setQuery] = useState('')
  const [brief, setBrief] = useState('')
  const [drafter, setDrafter] = useState('')
  const [reviewer, setReviewer] = useState('')
  const [provider, setProvider] = useState<Provider>('ollama')
  const [models, setModels] = useState(() => ({
    ollama: localStorage.getItem('knowledgeModel') ?? '',
    openai: localStorage.getItem('testOpenAiModel') ?? 'gpt-4.1-mini',
  }))
  const [runs, setRuns] = useState<ProposalRun[]>([])
  const [result, setResult] = useState<ProposalRun | null>(null)
  const [steps, setSteps] = useState<Partial<Record<Stage, Step>>>({})
  const [historyLoading, setHistoryLoading] = useState(Boolean(libraryRoot))
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)

  useEffect(() => {
    if (!libraryRoot) return
    let active = true
    invoke<ProposalRun[]>('list_proposals', { libraryRoot })
      .then(history => { if (active) setRuns(history) })
      .catch(failure => { if (active) setHistoryError(String(failure)) })
      .finally(() => { if (active) setHistoryLoading(false) })
    return () => { active = false }
  }, [libraryRoot])

  const draftingSkills = skills.filter(skill => skill.status === 'valid')
  const reviewAgents = agents.filter(agent => agent.status === 'valid')
  const ready = folder.trim() && query.trim() && brief.trim() && models[provider].trim()
    && draftingSkills.some(skill => skill.path === drafter) && reviewAgents.some(agent => agent.path === reviewer)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!libraryRoot || !ready || historyLoading || pending) return
    setPending(true)
    setSteps({})
    setResult(null)
    setError('')
    const events = new Channel<Step>(step => setSteps(current => ({ ...current, [step.stage]: step })))
    try {
      const { run, saveError } = await invoke<ProposalResult>('run_proposal', {
        events,
        request: {
          libraryRoot, knowledgeFolder: folder.trim().replace(/^"(.+)"$/, '$1'), query: query.trim(),
          brief: brief.trim(), drafterPath: drafter, reviewerPath: reviewer, provider, model: models[provider].trim(),
        },
      })
      setResult(run)
      if (saveError) setError(`The run finished, but its history could not be saved. ${saveError}`)
      else setRuns(history => [run, ...history].slice(0, 30))
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPending(false)
    }
  }

  const visibleSteps = result ? Object.fromEntries(result.steps.map(step => [step.stage, step])) : steps
  const wasRevised = visibleSteps.revise?.status === 'complete'

  return (
    <section className="knowledge-workspace">
      <header className="workspace-head"><strong>Workflows</strong></header>
      <div className="knowledge-content">
        <div className="knowledge-heading">
          <h2>Proposal workflow</h2>
          <p>Give a drafting skill and a review agent the same brief and the same sources.</p>
        </div>
        {!libraryRoot ? <div className="knowledge-card"><button className="primary" onClick={openLibrary}>Choose a library</button></div> : <>
          <form className="knowledge-card" onSubmit={submit}>
            <fieldset className="workflow-inputs" disabled={pending}>
              <label>Proposal brief<textarea required rows={4} maxLength={4000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Who is this for, what do they need, and what should the proposal cover?" /></label>
              <div className="workflow-grid">
                <label>Document folder<input required value={folder} onChange={event => setFolder(event.target.value)} /></label>
                <label>Source search terms<input required maxLength={1000} value={query} onChange={event => setQuery(event.target.value)} placeholder="pricing onboarding scope" /></label>
                <label>Drafting skill<select value={drafter} onChange={event => setDrafter(event.target.value)} required>
                  <option value="">Choose a skill</option>
                  {draftingSkills.map(skill => <option key={skill.path} value={skill.path}>{skill.name} · {skill.relativePath || 'Library root'}</option>)}
                </select></label>
                <label>Review agent<select value={reviewer} onChange={event => setReviewer(event.target.value)} required>
                  <option value="">Choose an agent</option>
                  {reviewAgents.map(agent => <option key={agent.path} value={agent.path}>{agent.name} · {agent.relativePath}</option>)}
                </select></label>
                <label>Provider<select value={provider} onChange={event => setProvider(event.target.value as Provider)}>
                  <option value="ollama">Ollama (local)</option>
                  <option value="openai">OpenAI (hosted)</option>
                </select></label>
                <label>{provider === 'ollama' ? 'Installed Ollama model' : 'OpenAI model ID'}<input required maxLength={150} placeholder={provider === 'ollama' ? 'gemma3:4b' : 'gpt-4.1-mini'} value={models[provider]} onChange={event => setModels({ ...models, [provider]: event.target.value })} /></label>
              </div>
            </fieldset>
            {(!draftingSkills.length || !reviewAgents.length) && <p>Create or import a valid skill and agent to assign both roles.</p>}
            {provider === 'openai' && <p className="provider-notice">This sends the brief, retrieved excerpts, saved role instructions, and intermediate text to OpenAI. The workflow makes up to three model calls. API charges may apply.</p>}
            <button className="primary" disabled={!ready || pending || historyLoading}>{pending ? 'Running workflow…' : provider === 'openai' ? 'Run workflow with OpenAI' : 'Run workflow'}</button>
            {error && <p className="action-error" role="alert">{error}</p>}
          </form>
          <section className="knowledge-card" aria-label="Workflow steps">
            <h3>Steps</h3>
            <ol className="workflow-steps">{stages.map(stage => {
              const step = visibleSteps[stage.id]
              return <li key={stage.id}>
                <div className="workflow-step-head"><strong>{stage.label}</strong>
                  <span className={`workflow-state ${step?.status ?? 'waiting'}`} role="status">{step?.status ?? 'waiting'}</span>
                </div>
                <p>{stage.detail}</p>
                {step?.error && <p className="action-error" role="alert">{step.error}</p>}
                {step?.output && <details open={stage.id === 'retrieve'}><summary>{stage.id === 'retrieve' ? step.output : 'View step output'}</summary>
                  {stage.id === 'retrieve' && result?.sources ? <>
                    <p>Searched {result.sources.filesSearched} files. {result.sources.limited && 'Search reached its scan limit.'}</p>
                    {result.sources.excerpts.map((excerpt, index) => <details key={index}>
                      <summary>[{index + 1}] {excerpt.path} · lines {excerpt.startLine}–{excerpt.endLine}</summary>
                      <pre>{excerpt.text}</pre>
                    </details>)}
                  </> : stage.id !== 'retrieve' && <pre>{step.output}</pre>}
                </details>}
              </li>
            })}</ol>
          </section>
          {result && <section className="knowledge-card knowledge-answer" aria-label="Workflow result">
            <h3>{result.proposal ? 'Proposal draft' : 'Workflow stopped'}</h3>
            <p>{providerNames[result.provider]} · {result.model} · {new Date(result.timestamp).toLocaleString()}</p>
            {result.proposal && <div>{result.proposal}</div>}
            {wasRevised && <p>One revision completed. Check the review findings and any open issues before sharing.</p>}
            {!result.proposal && <p>The steps above show where the run stopped and any output it produced.</p>}
            <details><summary>Brief and source query</summary><pre>{result.brief}{'\n\n'}Search terms: {result.query}</pre></details>
            <details><summary>Drafting skill snapshot</summary><pre>{result.drafter}</pre></details>
            <details><summary>Review agent and skill snapshots</summary><pre>{result.reviewer}</pre></details>
          </section>}
          <section className="knowledge-card" aria-label="Recent workflows">
            <h3>Recent runs</h3>
            {historyLoading && <p role="status">Loading history…</p>}
            {historyError && <p className="action-error" role="alert">Could not load history. {historyError}</p>}
            {!historyLoading && !historyError && runs.length === 0 && <p>Proposal runs will appear here.</p>}
            {runs.length > 0 && <ul className="run-history">{runs.map(run => <li key={run.id}>
              <button type="button" disabled={pending} aria-pressed={result?.id === run.id} onClick={() => { setResult(run); setError('') }}>
                <strong>{run.brief.slice(0, 80)}{run.brief.length > 80 && '…'}</strong>
                <span>{run.proposal ? 'Draft ready' : 'Stopped'} · {new Date(run.timestamp).toLocaleString()}</span>
              </button>
            </li>)}</ul>}
          </section>
        </>}
      </div>
    </section>
  )
}
