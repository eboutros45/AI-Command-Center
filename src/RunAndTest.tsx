import { useEffect, useRef, useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './Knowledge.css'

type RunKind = 'skill' | 'agent'
type Provider = 'ollama' | 'openai'
type Rating = '' | 'meets_expectation' | 'needs_work'
type Evaluation = { rating: Exclude<Rating, ''> | null; notes: string }
type TestRun = {
  id: string
  timestamp: number
  kind: RunKind
  provider: Provider
  assetName: string
  assetPath: string
  fingerprint: string
  assetSource: string
  referencedSkills: { name: string; relativePath: string; fingerprint: string; source: string }[]
  model: string
  input: string
  output: string
  evaluation?: Evaluation | null
}

type RunResult = { run: TestRun; saveError: string | null }
type AssetOption = { path: string; name: string; status: string }
const providerNames = { ollama: 'Ollama', openai: 'OpenAI' }
const ratingLabels = { meets_expectation: 'Meets expectation', needs_work: 'Needs work' }

function EvaluationForm({ run, busy, onSave }: { run: TestRun; busy: boolean; onSave: (evaluation: Evaluation) => Promise<boolean> }) {
  const [rating, setRating] = useState<Rating>(run.evaluation?.rating ?? '')
  const [notes, setNotes] = useState(run.evaluation?.notes ?? '')
  const [saved, setSaved] = useState(false)
  const changed = rating !== (run.evaluation?.rating ?? '') || notes.trim() !== (run.evaluation?.notes ?? '')
  return (
    <form className="knowledge-card" aria-label="Evaluate run" onSubmit={async event => {
      event.preventDefault()
      if (busy || !changed) return
      setSaved(await onSave({ rating: rating || null, notes: notes.trim() }))
    }}>
      <h3>Evaluate this run</h3>
      <label>Rating<select value={rating} disabled={busy} onChange={event => { setRating(event.target.value as Rating); setSaved(false) }}>
        <option value="">Unrated</option>
        <option value="meets_expectation">Meets expectation</option>
        <option value="needs_work">Needs work</option>
      </select></label>
      <label>Evaluation notes<textarea value={notes} disabled={busy} maxLength={2000} rows={3} placeholder="What worked? What should improve?" onChange={event => { setNotes(event.target.value); setSaved(false) }} /></label>
      <button disabled={busy || !changed}>Save evaluation</button>
      {saved && <p role="status">Evaluation saved.</p>}
    </form>
  )
}

function RunComparison({ baseline, candidate }: { baseline: TestRun; candidate: TestRun }) {
  const sameInput = baseline.input === candidate.input
  const sameAsset = baseline.kind === candidate.kind && baseline.assetPath === candidate.assetPath
  const sameModel = baseline.provider === candidate.provider && baseline.model === candidate.model
  const referenceVersions = (run: TestRun) => JSON.stringify(run.referencedSkills.map(skill => [skill.relativePath, skill.fingerprint]))
  const sameSource = baseline.fingerprint === candidate.fingerprint && referenceVersions(baseline) === referenceVersions(candidate)
  return (
    <section className="knowledge-card" aria-label="Run comparison">
      <h3>Compare runs</h3>
      <p>{sameInput ? 'Same example' : 'Different examples'} · {sameAsset ? 'Same library item' : 'Different library items'} · {sameModel ? 'Same model' : 'Different models'} · {sameSource ? 'Same saved instructions' : 'Different saved instructions'}</p>
      <div className="run-comparison">
        {([['Baseline', baseline], ['Selected run', candidate]] as const).map(([label, run]) => (
          <article className="run-compare-pane" key={label}>
            <h4>{label}</h4>
            <p>{run.assetName} · {providerNames[run.provider]} · {run.model}</p>
            <p>{run.evaluation?.rating ? ratingLabels[run.evaluation.rating] : 'Unrated'}</p>
            <pre>{run.output}</pre>
            {run.evaluation?.notes && <details open><summary>Evaluation notes</summary><pre>{run.evaluation.notes}</pre></details>}
            <details><summary>Example input</summary><pre>{run.input}</pre></details>
            <details><summary>Saved instructions · {run.fingerprint.slice(0, 12)}</summary>
              <pre>{run.assetSource}</pre>
              {run.referencedSkills.map(skill => <details key={skill.relativePath}>
                <summary>{skill.name} · {skill.fingerprint.slice(0, 12)}</summary><pre>{skill.source}</pre>
              </details>)}
            </details>
          </article>
        ))}
      </div>
    </section>
  )
}

export default function RunAndTest({ libraryRoot, initialAsset, skills, agents, openLibrary }: {
  libraryRoot?: string
  initialAsset: { kind: RunKind; path: string } | null
  skills: AssetOption[]
  agents: AssetOption[]
  openLibrary: () => void
}) {
  const [kind, setKind] = useState<RunKind>(initialAsset?.kind ?? 'skill')
  const [assetPath, setAssetPath] = useState(initialAsset?.path ?? '')
  const [provider, setProvider] = useState<Provider>('ollama')
  const [models, setModels] = useState(() => ({
    ollama: localStorage.getItem('knowledgeModel') ?? '',
    openai: localStorage.getItem('testOpenAiModel') ?? 'gpt-4.1-mini',
  }))
  const [input, setInput] = useState('')
  const inputField = useRef<HTMLTextAreaElement>(null)
  const [runs, setRuns] = useState<TestRun[]>([])
  const [selected, setSelected] = useState<TestRun | null>(null)
  const [historyLoading, setHistoryLoading] = useState(Boolean(libraryRoot))
  const [historyError, setHistoryError] = useState('')
  const [runError, setRunError] = useState('')
  const [pending, setPending] = useState(false)
  const [baseline, setBaseline] = useState<TestRun | null>(null)
  const [baselineLoading, setBaselineLoading] = useState(Boolean(libraryRoot))
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewError, setReviewError] = useState('')
  const validAssets = (kind === 'skill' ? skills : agents).filter(asset => asset.status === 'valid')
  const selectedAsset = validAssets.find(asset => asset.path === assetPath)
  const model = models[provider]

  useEffect(() => {
    if (!libraryRoot) return
    let active = true
    invoke<TestRun[]>('list_runs', { libraryRoot })
      .then(history => {
        if (active) setRuns(history)
      })
      .catch(error => {
        if (active) setHistoryError(String(error))
      })
      .finally(() => {
        if (active) setHistoryLoading(false)
      })
    invoke<TestRun | null>('get_run_baseline', { libraryRoot })
      .then(run => { if (active) setBaseline(run) })
      .catch(error => { if (active) setReviewError(String(error)) })
      .finally(() => { if (active) setBaselineLoading(false) })
    return () => { active = false }
  }, [libraryRoot])

  const runTest = async (event: FormEvent) => {
    event.preventDefault()
    if (!libraryRoot || !selectedAsset || !model.trim() || !input.trim() || pending || historyLoading) return
    setPending(true)
    setRunError('')
    try {
      const { run, saveError } = await invoke<RunResult>('run_test', {
        libraryRoot,
        assetPath: selectedAsset.path,
        kind,
        provider,
        model: model.trim(),
        input: input.trim(),
      })
      localStorage.setItem(provider === 'ollama' ? 'knowledgeModel' : 'testOpenAiModel', run.model)
      setSelected(run)
      if (saveError) {
        setRunError(`Model returned an answer, but the run could not be saved. ${saveError}`)
      } else {
        setRuns(history => [run, ...history].slice(0, 30))
      }
    } catch (error) {
      setRunError(String(error))
    } finally {
      setPending(false)
    }
  }

  const saveEvaluation = async (run: TestRun, evaluation: Evaluation) => {
    if (!libraryRoot || reviewBusy) return false
    setReviewBusy(true)
    setReviewError('')
    try {
      const updated = await invoke<TestRun>('evaluate_run', { libraryRoot, runId: run.id, evaluation })
      setRuns(history => history.map(item => item.id === updated.id ? updated : item))
      setSelected(current => current?.id === updated.id ? updated : current)
      setBaseline(current => current?.id === updated.id ? updated : current)
      return true
    } catch (error) {
      setReviewError(String(error))
      return false
    } finally {
      setReviewBusy(false)
    }
  }

  const changeBaseline = async (runId: string | null) => {
    if (!libraryRoot || baselineLoading || reviewBusy) return
    setReviewBusy(true)
    setReviewError('')
    try {
      setBaseline(await invoke<TestRun | null>('set_run_baseline', { libraryRoot, runId }))
    } catch (error) {
      setReviewError(String(error))
    } finally {
      setReviewBusy(false)
    }
  }

  const reuseInput = (run: TestRun) => {
    setKind(run.kind)
    setAssetPath((run.kind === 'skill' ? skills : agents).some(asset => asset.path === run.assetPath && asset.status === 'valid') ? run.assetPath : '')
    setInput(run.input)
    setRunError('')
    inputField.current?.focus()
  }

  const selectedSaved = selected && (baseline?.id === selected.id || runs.some(run => run.id === selected.id))

  return (
    <section className="knowledge-workspace">
      <header className="workspace-head"><strong>Run &amp; Test</strong></header>
      <div className="knowledge-content">
        <div className="knowledge-heading">
          <h2>Test a skill or agent</h2>
          <p>Run an example through a model and keep its response and saved instructions together.</p>
        </div>
        {!libraryRoot ? <div className="knowledge-card"><button className="primary" onClick={openLibrary}>Choose a library</button></div> : <>
          <form className="knowledge-card" onSubmit={runTest}>
            <label>Test type
              <select value={kind} onChange={event => { setKind(event.target.value as RunKind); setAssetPath(''); setRunError('') }} disabled={pending}>
                <option value="skill">Skill</option>
                <option value="agent">Agent</option>
              </select>
            </label>
            <label>Saved {kind}
              <select value={selectedAsset?.path ?? ''} onChange={event => setAssetPath(event.target.value)} required disabled={pending || !validAssets.length}>
                <option value="">Choose a {kind}</option>
                {validAssets.map(asset => <option key={asset.path} value={asset.path}>{asset.name}</option>)}
              </select>
            </label>
            {!validAssets.length && <p>Create a valid {kind} to run a test.</p>}
            <label>Provider
              <select value={provider} onChange={event => { setProvider(event.target.value as Provider); setRunError('') }} disabled={pending}>
                <option value="ollama">Ollama (local)</option>
                <option value="openai">OpenAI (hosted)</option>
              </select>
            </label>
            <label>{provider === 'ollama' ? 'Installed Ollama model' : 'OpenAI model ID'}
              <input value={model} placeholder={provider === 'ollama' ? 'gemma3:4b' : 'gpt-4.1-mini'} onChange={event => setModels({ ...models, [provider]: event.target.value })} required maxLength={150} disabled={pending} />
            </label>
            <label>Example input
              <textarea ref={inputField} value={input} onChange={event => setInput(event.target.value)} rows={4} maxLength={4000} required disabled={pending} />
            </label>
            <p>{kind === 'agent' ? 'Agent tests include referenced library skills and use the selected model for a text-only preview.' : 'Skill tests use the saved SKILL.md as text instructions.'} Completed runs are saved locally.</p>
            {provider === 'openai' && <p className="provider-notice">Running with OpenAI sends the saved {kind}{kind === 'agent' ? ', its referenced skills,' : ''} and your example to OpenAI. API charges may apply. Set <code>OPENAI_API_KEY</code> before launching the app.</p>}
            <button className="primary" disabled={pending || historyLoading || !selectedAsset || !model.trim() || !input.trim()}>{pending ? 'Running…' : provider === 'openai' ? 'Run with OpenAI' : 'Run test'}</button>
            {runError && <p className="action-error" role="alert">{runError}</p>}
          </form>
          {baseline && <section className="knowledge-card" aria-label="Comparison baseline">
            <h3>Baseline</h3>
            <p>{baseline.assetName} · {providerNames[baseline.provider]} · {baseline.model} · {new Date(baseline.timestamp).toLocaleString()}</p>
            <div className="workflow-actions">
              <button disabled={reviewBusy} onClick={() => setSelected(baseline)}>Open baseline</button>
              <button disabled={pending} onClick={() => reuseInput(baseline)}>Use baseline input</button>
              <button disabled={reviewBusy || baselineLoading} onClick={() => changeBaseline(null)}>Clear baseline</button>
            </div>
          </section>}
          {reviewError && <p className="action-error" role="alert">{reviewError}</p>}
          {selected && <section className="knowledge-card knowledge-answer" aria-label="Run result">
            <h3>Run result</h3>
            <p>{selected.assetName} · {providerNames[selected.provider]} · {selected.model} · {new Date(selected.timestamp).toLocaleString()}</p>
            <div className="workflow-actions">
              <button disabled={pending} onClick={() => reuseInput(selected)}>Use input again</button>
              {selectedSaved && <button disabled={reviewBusy || baselineLoading || selected.id === baseline?.id} onClick={() => changeBaseline(selected.id)}>
                {selected.id === baseline?.id ? 'Current baseline' : 'Set as baseline'}
              </button>}
            </div>
            <div role="status">{selected.output}</div>
            <details><summary>Example input</summary><pre>{selected.input}</pre></details>
            <details><summary>Saved {selected.kind} snapshot · {selected.fingerprint.slice(0, 12)}</summary><pre>{selected.assetSource}</pre></details>
            {selected.referencedSkills.map(skill => <details key={skill.relativePath}>
              <summary>Referenced skill · {skill.name} · {skill.fingerprint.slice(0, 12)}</summary>
              <pre>{skill.source}</pre>
            </details>)}
          </section>}
          {baseline && selected && baseline.id !== selected.id && <RunComparison baseline={baseline} candidate={selected} />}
          {selected && selectedSaved && <EvaluationForm key={selected.id} run={selected} busy={reviewBusy} onSave={evaluation => saveEvaluation(selected, evaluation)} />}
          <section className="knowledge-card" aria-label="Recent tests">
            <h3>Recent tests</h3>
            {historyLoading && <p role="status">Loading history…</p>}
            {historyError && <p className="action-error" role="alert">Could not load history. {historyError}</p>}
            {!historyLoading && !historyError && runs.length === 0 && <p>Completed tests will appear here.</p>}
            {runs.length > 0 && <ul className="run-history">{runs.map(run => (
              <li key={run.id}>
                <button type="button" aria-pressed={selected?.id === run.id} onClick={() => setSelected(run)}>
                  <strong>{run.assetName}</strong>
                  <span>{run.id === baseline?.id ? 'Baseline · ' : ''}{run.evaluation?.rating ? `${ratingLabels[run.evaluation.rating]} · ` : ''}{run.kind} · {providerNames[run.provider]} · {run.model} · {new Date(run.timestamp).toLocaleString()}</span>
                </button>
              </li>
            ))}</ul>}
          </section>
        </>}
      </div>
    </section>
  )
}
