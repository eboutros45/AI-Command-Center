import { useEffect, useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './Knowledge.css'

type RunKind = 'skill' | 'agent'
type Provider = 'ollama' | 'openai'
type TestRun = {
  id: string
  timestamp: number
  kind: RunKind
  provider: Provider
  assetName: string
  fingerprint: string
  assetSource: string
  referencedSkills: { name: string; relativePath: string; fingerprint: string; source: string }[]
  model: string
  input: string
  output: string
}

type RunResult = { run: TestRun; saveError: string | null }
type AssetOption = { path: string; name: string; status: string }
const providerNames = { ollama: 'Ollama', openai: 'OpenAI' }

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
  const [runs, setRuns] = useState<TestRun[]>([])
  const [selected, setSelected] = useState<TestRun | null>(null)
  const [historyLoading, setHistoryLoading] = useState(Boolean(libraryRoot))
  const [historyError, setHistoryError] = useState('')
  const [runError, setRunError] = useState('')
  const [pending, setPending] = useState(false)
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
              <textarea value={input} onChange={event => setInput(event.target.value)} rows={4} maxLength={4000} required disabled={pending} />
            </label>
            <p>{kind === 'agent' ? 'Agent tests include referenced library skills and use the selected model for a text-only preview.' : 'Skill tests use the saved SKILL.md as text instructions.'} Completed runs are saved locally.</p>
            {provider === 'openai' && <p className="provider-notice">Running with OpenAI sends the saved {kind}{kind === 'agent' ? ', its referenced skills,' : ''} and your example to OpenAI. API charges may apply. Set <code>OPENAI_API_KEY</code> before launching the app.</p>}
            <button className="primary" disabled={pending || historyLoading || !selectedAsset || !model.trim() || !input.trim()}>{pending ? 'Running…' : provider === 'openai' ? 'Run with OpenAI' : 'Run test'}</button>
            {runError && <p className="action-error" role="alert">{runError}</p>}
          </form>
          {selected && <section className="knowledge-card knowledge-answer" aria-label="Run result">
            <h3>Run result</h3>
            <p>{selected.assetName} · {providerNames[selected.provider]} · {selected.model} · {new Date(selected.timestamp).toLocaleString()}</p>
            <div role="status">{selected.output}</div>
            <details><summary>Example input</summary><pre>{selected.input}</pre></details>
            <details><summary>Saved {selected.kind} snapshot · {selected.fingerprint.slice(0, 12)}</summary><pre>{selected.assetSource}</pre></details>
            {selected.referencedSkills.map(skill => <details key={skill.relativePath}>
              <summary>Referenced skill · {skill.name} · {skill.fingerprint.slice(0, 12)}</summary>
              <pre>{skill.source}</pre>
            </details>)}
          </section>}
          <section className="knowledge-card" aria-label="Recent tests">
            <h3>Recent tests</h3>
            {historyLoading && <p role="status">Loading history…</p>}
            {historyError && <p className="action-error" role="alert">Could not load history. {historyError}</p>}
            {!historyLoading && !historyError && runs.length === 0 && <p>Completed tests will appear here.</p>}
            {runs.length > 0 && <ul className="run-history">{runs.map(run => (
              <li key={run.id}>
                <button type="button" aria-pressed={selected?.id === run.id} onClick={() => setSelected(run)}>
                  <strong>{run.assetName}</strong>
                  <span>{run.kind} · {providerNames[run.provider]} · {run.model} · {new Date(run.timestamp).toLocaleString()}</span>
                </button>
              </li>
            ))}</ul>}
          </section>
        </>}
      </div>
    </section>
  )
}
