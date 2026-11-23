import { useEffect, useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import './Knowledge.css'

type SkillRun = {
  id: string
  timestamp: number
  skillName: string
  skillPath: string
  fingerprint: string
  skillSource: string
  model: string
  input: string
  output: string
}

type RunResult = { run: SkillRun; saveError: string | null }
type SkillOption = { path: string; name: string; status: string }

export default function RunAndTest({ libraryRoot, initialSkillPath, skills, openLibrary }: {
  libraryRoot?: string
  initialSkillPath: string
  skills: SkillOption[]
  openLibrary: () => void
}) {
  const [skillPath, setSkillPath] = useState(initialSkillPath)
  const [model, setModel] = useState(() => localStorage.getItem('knowledgeModel') ?? '')
  const [input, setInput] = useState('')
  const [runs, setRuns] = useState<SkillRun[]>([])
  const [selected, setSelected] = useState<SkillRun | null>(null)
  const [historyLoading, setHistoryLoading] = useState(Boolean(libraryRoot))
  const [historyError, setHistoryError] = useState('')
  const [runError, setRunError] = useState('')
  const [pending, setPending] = useState(false)
  const validSkills = skills.filter(skill => skill.status === 'valid')
  const selectedSkill = validSkills.find(skill => skill.path === skillPath)

  useEffect(() => {
    if (!libraryRoot) return
    let active = true
    invoke<SkillRun[]>('list_skill_runs', { libraryRoot })
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
    if (!libraryRoot || !selectedSkill || !model.trim() || !input.trim() || pending || historyLoading) return
    setPending(true)
    setRunError('')
    try {
      const { run, saveError } = await invoke<RunResult>('run_skill_test', {
        libraryRoot,
        skillPath: selectedSkill.path,
        model: model.trim(),
        input: input.trim(),
      })
      localStorage.setItem('knowledgeModel', run.model)
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
          <h2>Test a saved skill</h2>
          <p>Run a sample input through Ollama and keep the response, input, and skill source together.</p>
        </div>
        {!libraryRoot ? <div className="knowledge-card"><button className="primary" onClick={openLibrary}>Choose a library</button></div> : <>
          <form className="knowledge-card" onSubmit={runTest}>
            <label>Saved skill
              <select value={selectedSkill?.path ?? ''} onChange={event => setSkillPath(event.target.value)} required disabled={pending || !validSkills.length}>
                <option value="">Choose a skill</option>
                {validSkills.map(skill => <option key={skill.path} value={skill.path}>{skill.name}</option>)}
              </select>
            </label>
            {!validSkills.length && <p>Create or import a valid skill to run a test.</p>}
            <label>Installed Ollama model
              <input value={model} placeholder="gemma3:4b" onChange={event => setModel(event.target.value)} required maxLength={150} disabled={pending} />
            </label>
            <label>Example input
              <textarea value={input} onChange={event => setInput(event.target.value)} rows={4} maxLength={4000} required disabled={pending} />
            </label>
            <p>The model receives the saved <code>SKILL.md</code> and your example as text. Completed runs are saved in the app’s local data folder.</p>
            <button className="primary" disabled={pending || historyLoading || !selectedSkill || !model.trim() || !input.trim()}>{pending ? 'Running…' : 'Run test'}</button>
            {runError && <p className="action-error" role="alert">{runError}</p>}
          </form>
          {selected && <section className="knowledge-card knowledge-answer" aria-label="Run result">
            <h3>Run result</h3>
            <p>{selected.skillName} · {selected.model} · {new Date(selected.timestamp).toLocaleString()}</p>
            <div role="status">{selected.output}</div>
            <details><summary>Example input</summary><pre>{selected.input}</pre></details>
            <details><summary>Saved skill snapshot · {selected.fingerprint.slice(0, 12)}</summary><pre>{selected.skillSource}</pre></details>
          </section>}
          <section className="knowledge-card" aria-label="Recent skill tests">
            <h3>Recent tests</h3>
            {historyLoading && <p role="status">Loading history…</p>}
            {historyError && <p className="action-error" role="alert">Could not load history. {historyError}</p>}
            {!historyLoading && !historyError && runs.length === 0 && <p>Completed tests will appear here.</p>}
            {runs.length > 0 && <ul className="run-history">{runs.map(run => (
              <li key={run.id}>
                <button type="button" aria-pressed={selected?.id === run.id} onClick={() => setSelected(run)}>
                  <strong>{run.skillName}</strong>
                  <span>{run.model} · {new Date(run.timestamp).toLocaleString()}</span>
                </button>
              </li>
            ))}</ul>}
          </section>
        </>}
      </div>
    </section>
  )
}
