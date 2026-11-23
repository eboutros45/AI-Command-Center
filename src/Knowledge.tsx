import { useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { groqDefaultModel, modelSettings, type CurrentProvider } from './providers'
import './Knowledge.css'

type Excerpt = { path: string; startLine: number; endLine: number; text: string }
type Retrieval = {
  excerpts: Excerpt[]
  filesSearched: number
  skippedFiles: number
  limited: boolean
}

export default function Knowledge({ libraryRoot, skills, desktop }: {
  libraryRoot?: string
  skills: { path: string; name: string; status: string }[]
  desktop: boolean
}) {
  const [folder, setFolder] = useState(() => localStorage.getItem('knowledgeFolder') ?? '')
  const [question, setQuestion] = useState('')
  const [provider, setProvider] = useState<CurrentProvider>('ollama')
  const [models, setModels] = useState(() => ({
    ollama: localStorage.getItem(modelSettings.ollama) ?? '',
    groq: localStorage.getItem(modelSettings.groq) ?? groqDefaultModel,
  }))
  const model = models[provider]
  const [skillPath, setSkillPath] = useState('')
  const [retrieval, setRetrieval] = useState<Retrieval | null>(null)
  const [answer, setAnswer] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'search' | 'answer' | null>(null)

  const resetResults = () => {
    setRetrieval(null)
    setAnswer(null)
    setError('')
  }

  const retrieve = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    resetResults()
    setPending('search')
    try {
      const path = folder.trim().replace(/^"(.+)"$/, '$1')
      const result = await invoke<Retrieval>('search_knowledge', { folder: path, query: question.trim() })
      setRetrieval(result)
      localStorage.setItem('knowledgeFolder', path)
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPending(null)
    }
  }

  const generate = async (event: FormEvent) => {
    event.preventDefault()
    if (!retrieval?.excerpts.length || pending) return
    setPending('answer')
    setAnswer(null)
    setError('')
    try {
      const result = await invoke<string>('answer_from_sources', {
        model: model.trim(),
        provider,
        query: question.trim(),
        excerpts: retrieval.excerpts,
        libraryRoot: libraryRoot ?? null,
        skillPath: skills.some(skill => skill.path === skillPath) ? skillPath : null,
      })
      setAnswer(result)
      localStorage.setItem(modelSettings[provider], model.trim())
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPending(null)
    }
  }

  return (
    <section className="knowledge-workspace">
      <header className="workspace-head"><strong>Knowledge</strong></header>
      <div className="knowledge-content">
        <div className="knowledge-heading">
          <h2>Ask your documents</h2>
          <p>Find relevant passages in a local folder, then generate a cited answer with Ollama or Groq.</p>
        </div>
        <form className="knowledge-card" onSubmit={retrieve}>
          <label>Document folder
            <input value={folder} onChange={event => { setFolder(event.target.value); resetResults() }} required disabled={Boolean(pending)} />
          </label>
          <p className="field-help">Paste the full path. Search includes Markdown and plain-text files in subfolders.</p>
          <label>Question
            <textarea value={question} onChange={event => { setQuestion(event.target.value); resetResults() }} required rows={2} maxLength={1000} disabled={Boolean(pending)} placeholder="What does our refund policy say about subscriptions?" />
          </label>
          <button className="primary" disabled={!desktop || Boolean(pending) || !folder.trim() || !question.trim()}>
            {pending === 'search' ? 'Searching…' : 'Find sources'}
          </button>
          {!desktop && <p className="field-help">Open the desktop app to search local files.</p>}
        </form>
        {retrieval && <div className="knowledge-results">
          <div className="knowledge-card">
            <h3>Sources</h3>
            <p role="status">Searched {retrieval.filesSearched} {retrieval.filesSearched === 1 ? 'file' : 'files'}.
              {retrieval.skippedFiles > 0 && ` Skipped ${retrieval.skippedFiles} unreadable or oversized entries.`}
              {retrieval.limited && ' Search reached its scan limit.'}
            </p>
            {!retrieval.excerpts.length && <p>No excerpts matched. Try a keyword used in your documents.</p>}
            {retrieval.excerpts.map((excerpt, index) => (
              <details key={index} open={index === 0}>
                <summary>[{index + 1}] {excerpt.path} · lines {excerpt.startLine}–{excerpt.endLine}</summary>
                <pre>{excerpt.text}</pre>
              </details>
            ))}
          </div>
          {retrieval.excerpts.length > 0 && <form className="knowledge-card" onSubmit={generate}>
            <h3>Generate an answer</h3>
            <label>Answer provider<select value={provider} disabled={Boolean(pending)} onChange={event => { setProvider(event.target.value as CurrentProvider); setAnswer(null); setError('') }}>
              <option value="ollama">Ollama (local)</option>
              <option value="groq">Groq (hosted)</option>
            </select></label>
            <label>{provider === 'ollama' ? 'Installed Ollama model' : 'Groq model ID'}
              <input value={model} onChange={event => { setModels({ ...models, [provider]: event.target.value }); setAnswer(null) }} placeholder={provider === 'ollama' ? 'gemma3:4b' : groqDefaultModel} required maxLength={150} disabled={Boolean(pending)} />
            </label>
            <label>Skill to test (optional)
              <select value={skills.some(skill => skill.path === skillPath) ? skillPath : ''} onChange={event => { setSkillPath(event.target.value); setAnswer(null) }} disabled={Boolean(pending)}>
                <option value="">No skill</option>
                {skills.filter(skill => skill.status === 'valid').map(skill => <option key={skill.path} value={skill.path}>{skill.name}</option>)}
              </select>
            </label>
            {provider === 'groq'
              ? <p className="provider-notice">Generating with Groq sends your question, the retrieved excerpts, and any selected skill to Groq. Set <code>GROQ_API_KEY</code> before launching the app.</p>
              : <p className="field-help">Keep Ollama running on this computer and use a downloaded model.</p>}
            <button className="primary" disabled={Boolean(pending) || !model.trim()}>
              {pending === 'answer' ? 'Generating…' : provider === 'groq' ? 'Generate with Groq' : 'Generate answer'}
            </button>
          </form>}
        </div>}
        {error && <p className="action-error" role="alert">{error}</p>}
        {answer && <section className="knowledge-card knowledge-answer"><h3>Answer</h3><div>{answer}</div></section>}
      </div>
    </section>
  )
}
