import { useEffect, useState, type FormEvent } from 'react'
import { Channel, invoke } from '@tauri-apps/api/core'
import { groqDefaultModel, modelSettings, providerNames, type Provider } from './providers'
import './Knowledge.css'

type Stage = 'retrieve' | 'draft' | 'review' | 'revise'
type ModelTarget = { provider: Provider; model: string }
type Step = { stage: Stage; status: 'running' | 'complete' | 'failed' | 'skipped'; output: string; error: string | null; execution?: ModelTarget }
type Excerpt = { path: string; startLine: number; endLine: number; text: string }
type ProposalRun = {
  id: string
  timestamp: number
  provider: Provider
  model: string
  reviewModel?: ModelTarget | null
  revisionModel?: ModelTarget | null
  brief: string
  query: string
  drafter: string
  reviewer: string
  reviseOnFeedback?: boolean
  retrieveSources?: boolean
  reviewDraft?: boolean
  sources: { excerpts: Excerpt[]; filesSearched: number; skippedFiles: number; limited: boolean } | null
  steps: Step[]
  proposal: string | null
}
type Asset = { name: string; path: string; relativePath: string; status: string }
type ProposalResult = { run: ProposalRun; saveError: string | null }
type Setup = {
  knowledgeFolder: string
  query: string
  drafterPath: string
  reviewerPath: string
  provider: Provider
  model: string
  reviewModel?: ModelTarget | null
  revisionModel?: ModelTarget | null
  reviseOnFeedback: boolean
  retrieveSources: boolean
  reviewDraft: boolean
}
type Recipe = { id: string; name: string; setup: Setup }

const stages: { id: Stage; label: string; detail: string }[] = [
  { id: 'retrieve', label: 'Retrieve sources', detail: 'Find passages that support the brief.' },
  { id: 'draft', label: 'Draft proposal', detail: 'Apply the selected drafting skill.' },
  { id: 'review', label: 'Review draft', detail: 'Ask the review agent to check it against the brief and sources.' },
  { id: 'revise', label: 'Revise if needed', detail: 'Make one revision when the reviewer requests changes.' },
]

function StepModelOverride({ step, value, onChange, defaults }: {
  step: 'Review' | 'Revision'
  value: ModelTarget | null
  onChange: (target: ModelTarget | null) => void
  defaults: Record<Provider, string>
}) {
  return (
    <div className="step-model">
      <label>{step} provider<select value={value?.provider ?? ''} onChange={event => {
        const provider = event.target.value as Provider | ''
        onChange(provider ? { provider, model: defaults[provider] } : null)
      }}>
        <option value="">Use drafting model</option>
        <option value="ollama">Ollama (local)</option>
        <option value="groq">Groq (hosted)</option>
        {value?.provider === 'openai' && <option value="openai">OpenAI (saved recipe)</option>}
      </select></label>
      {value && <label>{step} model<input required maxLength={150} value={value.model} onChange={event => onChange({ ...value, model: event.target.value })} /></label>}
    </div>
  )
}

function WorkflowRoute({ visibleSteps, revise, retrieve, review }: {
  visibleSteps: Partial<Record<Stage, Step>>
  revise: boolean
  retrieve: boolean
  review: boolean
}) {
  const failed = Object.values(visibleSteps).some(step => step?.status === 'failed')
  const verdict = visibleSteps.review?.status === 'complete' ? visibleSteps.review.output.trim().split(/\r?\n/, 1)[0].trim() : null
  const branches = [
    ...(review ? [
      { label: 'Review passes', action: 'Return draft', active: !failed && verdict === 'PASS' },
      { label: 'Review requests changes', action: revise ? 'Revise once, then return draft' : 'Return draft with findings', active: !failed && verdict === 'REVISE' },
    ] : [{ label: 'Draft completes', action: 'Return draft', active: !failed && visibleSteps.draft?.status === 'complete' }]),
    { label: 'A step fails', action: 'Stop and keep step outputs', active: failed },
  ]
  return (
    <section className="knowledge-card" aria-label="Workflow route">
      <h3>Workflow route</h3>
      <div className="workflow-route">
        {stages.slice(0, 3).filter(stage => (stage.id !== 'retrieve' || retrieve) && (stage.id !== 'review' || review)).map((stage, index) => <div key={stage.id}>
          {index > 0 && <span aria-hidden="true">→</span>}
          <a href={`#proposal-step-${stage.id}`} data-status={visibleSteps[stage.id]?.status}>{stage.label}</a>
        </div>)}
      </div>
      <ul className="workflow-branches">{branches.map(branch => <li key={branch.label} className={branch.active ? 'taken' : ''}>
        <strong>{branch.label}</strong><span>{branch.action}</span>
        {branch.active && <small>Route taken</small>}
      </li>)}</ul>
    </section>
  )
}

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
  const [reviewModel, setReviewModel] = useState<ModelTarget | null>(null)
  const [revisionModel, setRevisionModel] = useState<ModelTarget | null>(null)
  const [reviseOnFeedback, setReviseOnFeedback] = useState(true)
  const [retrieveSources, setRetrieveSources] = useState(true)
  const [reviewDraft, setReviewDraft] = useState(true)
  const [models, setModels] = useState(() => ({
    ollama: localStorage.getItem('knowledgeModel') ?? '',
    groq: localStorage.getItem(modelSettings.groq) ?? groqDefaultModel,
    openai: localStorage.getItem('testOpenAiModel') ?? 'gpt-4.1-mini',
  }))
  const [runs, setRuns] = useState<ProposalRun[]>([])
  const [result, setResult] = useState<ProposalRun | null>(null)
  const [steps, setSteps] = useState<Partial<Record<Stage, Step>>>({})
  const [historyLoading, setHistoryLoading] = useState(Boolean(libraryRoot))
  const [historyError, setHistoryError] = useState('')
  const [error, setError] = useState('')
  const [pending, setPending] = useState(false)
  const [recipes, setRecipes] = useState<Recipe[]>([])
  const [recipeId, setRecipeId] = useState('')
  const [recipeName, setRecipeName] = useState('')
  const [recipeLoading, setRecipeLoading] = useState(Boolean(libraryRoot))
  const [recipeSaving, setRecipeSaving] = useState(false)
  const [recipeError, setRecipeError] = useState('')
  const [recipeNotice, setRecipeNotice] = useState('')

  useEffect(() => {
    if (!libraryRoot) return
    let active = true
    invoke<ProposalRun[]>('list_proposals', { libraryRoot })
      .then(history => { if (active) setRuns(history) })
      .catch(failure => { if (active) setHistoryError(String(failure)) })
      .finally(() => { if (active) setHistoryLoading(false) })
    invoke<Recipe[]>('list_proposal_recipes', { libraryRoot })
      .then(saved => { if (active) setRecipes(saved) })
      .catch(failure => { if (active) setRecipeError(String(failure)) })
      .finally(() => { if (active) setRecipeLoading(false) })
    return () => { active = false }
  }, [libraryRoot])

  const draftingSkills = skills.filter(skill => skill.status === 'valid')
  const reviewAgents = agents.filter(agent => agent.status === 'valid')
  const setup: Setup = {
    knowledgeFolder: retrieveSources ? folder.trim().replace(/^"(.+)"$/, '$1') : '',
    query: retrieveSources ? query.trim() : '',
    drafterPath: drafter, reviewerPath: reviewDraft ? reviewer : '', provider, model: models[provider].trim(),
    reviewModel: reviewDraft && reviewModel ? { ...reviewModel, model: reviewModel.model.trim() } : null,
    revisionModel: reviewDraft && reviseOnFeedback && revisionModel ? { ...revisionModel, model: revisionModel.model.trim() } : null,
    retrieveSources, reviewDraft, reviseOnFeedback: reviewDraft && reviseOnFeedback,
  }
  const missingDraft = Boolean(drafter) && !draftingSkills.some(skill => skill.path === drafter)
  const missingReview = reviewDraft && Boolean(reviewer) && !reviewAgents.some(agent => agent.path === reviewer)
  const configured = (!retrieveSources || Boolean(setup.knowledgeFolder && setup.query))
    && Boolean(setup.model && drafter) && (!reviewDraft || Boolean(reviewer)) && !missingDraft && !missingReview
    && (!setup.reviewModel || Boolean(setup.reviewModel.model)) && (!setup.revisionModel || Boolean(setup.revisionModel.model))
  const ready = configured && brief.trim()
  const hosted = (['groq', 'openai'] as const).map(destination => ({
    destination,
    steps: [
      provider === destination ? 'Draft' : '',
      reviewDraft && (setup.reviewModel?.provider ?? provider) === destination ? 'Review' : '',
      setup.reviseOnFeedback && (setup.revisionModel?.provider ?? provider) === destination ? 'Revision (if needed)' : '',
    ].filter(Boolean),
  })).filter(group => group.steps.length > 0)
  const runLabel = hosted.length > 0 ? `Run workflow with ${hosted.map(group => providerNames[group.destination]).join(' and ')}` : 'Run workflow'

  const loadRecipe = (id: string) => {
    const recipe = recipes.find(item => item.id === id)
    setRecipeId(id)
    setRecipeName(recipe?.name ?? '')
    setRecipeError('')
    setRecipeNotice('')
    if (!recipe) return
    setFolder(recipe.setup.knowledgeFolder)
    setQuery(recipe.setup.query)
    setDrafter(recipe.setup.drafterPath)
    setReviewer(recipe.setup.reviewerPath)
    setProvider(recipe.setup.provider)
    setReviewModel(recipe.setup.reviewModel ?? null)
    setRevisionModel(recipe.setup.revisionModel ?? null)
    setModels(previous => ({ ...previous, [recipe.setup.provider]: recipe.setup.model }))
    setReviseOnFeedback(recipe.setup.reviseOnFeedback)
    setRetrieveSources(recipe.setup.retrieveSources ?? true)
    setReviewDraft(recipe.setup.reviewDraft ?? true)
    setResult(null)
    setSteps({})
    setError('')
    setRecipeNotice(`Loaded “${recipe.name}”.`)
  }

  const saveRecipe = async (id: string | null) => {
    if (!libraryRoot || !configured || !recipeName.trim() || pending || recipeSaving || recipeLoading) return
    setRecipeSaving(true)
    setRecipeError('')
    setRecipeNotice('')
    try {
      const recipe = await invoke<Recipe>('save_proposal_recipe', { libraryRoot, recipeId: id, name: recipeName.trim(), setup })
      setRecipes(saved => [recipe, ...saved.filter(item => item.id !== recipe.id)])
      setRecipeId(recipe.id)
      setRecipeName(recipe.name)
      setRecipeNotice(`Saved “${recipe.name}”.`)
    } catch (failure) {
      setRecipeError(String(failure))
    } finally {
      setRecipeSaving(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!libraryRoot || !ready || historyLoading || pending || recipeSaving) return
    setPending(true)
    setSteps({})
    setResult(null)
    setError('')
    const events = new Channel<Step>(step => setSteps(current => ({ ...current, [step.stage]: step })))
    try {
      const { run, saveError } = await invoke<ProposalResult>('run_proposal', {
        events,
        request: {
          libraryRoot, brief: brief.trim(), ...setup,
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
  const revisionEnabled = result ? result.reviseOnFeedback ?? true : reviseOnFeedback
  const routeRetrieve = result ? result.retrieveSources ?? true : retrieveSources
  const routeReview = result ? result.reviewDraft ?? true : reviewDraft
  const planSteps = [
    retrieveSources ? 'Retrieve' : 'Use brief',
    'Draft',
    ...(reviewDraft ? ['Review', ...(reviseOnFeedback ? ['Revise if needed'] : [])] : []),
    'Return draft',
  ]

  return (
    <section className="knowledge-workspace">
      <header className="workspace-head"><strong>Workflows</strong></header>
      <div className="knowledge-content">
        <div className="knowledge-heading">
          <h2>Proposal workflow</h2>
          <p>Choose which steps run, then save the setup as a recipe.</p>
        </div>
        {!libraryRoot ? <div className="knowledge-card"><button className="primary" onClick={openLibrary}>Choose a library</button></div> : <>
          <section className="knowledge-card" aria-label="Workflow recipes">
            <h3>Recipes</h3>
            <div className="workflow-grid">
              <label>Saved recipe<select value={recipeId} disabled={pending || recipeLoading || recipeSaving} onChange={event => loadRecipe(event.target.value)}>
                <option value="">{recipeLoading ? 'Loading recipes…' : 'New recipe'}</option>
                {recipes.map(recipe => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}
              </select></label>
              <label>Recipe name<input maxLength={80} value={recipeName} disabled={pending || recipeSaving} onChange={event => setRecipeName(event.target.value)} placeholder="Client onboarding" /></label>
            </div>
            <p>The recipe saves the roles, source settings, and step models. Enter a fresh brief for each run.</p>
            <div className="workflow-actions">
              {recipeId && <button type="button" disabled={!configured || !recipeName.trim() || pending || recipeSaving || recipeLoading} onClick={() => saveRecipe(recipeId)}>Update recipe</button>}
              <button type="button" disabled={!configured || !recipeName.trim() || pending || recipeSaving || recipeLoading} onClick={() => saveRecipe(null)}>{recipeId ? 'Save as new recipe' : 'Save recipe'}</button>
            </div>
            {recipeNotice && <p role="status">{recipeNotice}</p>}
            {recipeError && <p className="action-error" role="alert">{recipeError}</p>}
          </section>
          <form className="knowledge-card" onSubmit={submit}>
            <fieldset className="workflow-inputs" disabled={pending || recipeSaving}>
              <label>Proposal brief<textarea required rows={4} maxLength={4000} value={brief} onChange={event => setBrief(event.target.value)} placeholder="Who is this for, what do they need, and what should the proposal cover?" /></label>
              <fieldset className="workflow-options">
                <legend>Steps for the next run</legend>
                <label className="workflow-checkbox"><input type="checkbox" checked={retrieveSources} onChange={event => setRetrieveSources(event.target.checked)} /> Retrieve from a document folder</label>
                <label className="workflow-checkbox"><input type="checkbox" checked={reviewDraft} onChange={event => setReviewDraft(event.target.checked)} /> Review the draft with an agent</label>
                {reviewDraft && <label className="workflow-checkbox"><input type="checkbox" checked={reviseOnFeedback} onChange={event => setReviseOnFeedback(event.target.checked)} /> Revise once when the reviewer requests changes</label>}
                <p className="workflow-plan" role="status">{planSteps.join(' → ')}</p>
              </fieldset>
              <div className="workflow-grid">
                {retrieveSources && <>
                  <label>Document folder<input required value={folder} onChange={event => setFolder(event.target.value)} /></label>
                  <label>Source search terms<input required maxLength={1000} value={query} onChange={event => setQuery(event.target.value)} placeholder="pricing onboarding scope" /></label>
                </>}
                <label>Drafting skill<select value={drafter} onChange={event => setDrafter(event.target.value)} required>
                  <option value="">Choose a skill</option>
                  {draftingSkills.map(skill => <option key={skill.path} value={skill.path}>{skill.name} · {skill.relativePath || 'Library root'}</option>)}
                </select></label>
                {reviewDraft && <label>Review agent<select value={reviewer} onChange={event => setReviewer(event.target.value)} required>
                  <option value="">Choose an agent</option>
                  {reviewAgents.map(agent => <option key={agent.path} value={agent.path}>{agent.name} · {agent.relativePath}</option>)}
                </select></label>}
                <label>Draft provider<select value={provider} onChange={event => setProvider(event.target.value as Provider)}>
                  <option value="ollama">Ollama (local)</option>
                  <option value="groq">Groq (hosted)</option>
                  {provider === 'openai' && <option value="openai">OpenAI (saved recipe)</option>}
                </select></label>
                <label>{provider === 'ollama' ? 'Installed Ollama model' : `${providerNames[provider]} model ID`}<input required maxLength={150} placeholder={provider === 'ollama' ? 'gemma3:4b' : provider === 'groq' ? groqDefaultModel : 'gpt-4.1-mini'} value={models[provider]} onChange={event => setModels({ ...models, [provider]: event.target.value })} /></label>
              </div>
              {reviewDraft && <fieldset className="workflow-options">
                <legend>Model overrides</legend>
                <StepModelOverride step="Review" value={reviewModel} onChange={setReviewModel} defaults={models} />
                {reviseOnFeedback && <StepModelOverride step="Revision" value={revisionModel} onChange={setRevisionModel} defaults={models} />}
              </fieldset>}
            </fieldset>
            {!draftingSkills.length && <p>Create or import a valid drafting skill to run a workflow.</p>}
            {reviewDraft && !reviewAgents.length && <p>Create a valid review agent, or turn off review for this run.</p>}
            {(missingDraft || missingReview) && <p className="action-error">A saved role is missing or invalid. Select a replacement before running.</p>}
            {hosted.map(({ destination, steps }) => <p className="provider-notice" key={destination}>
              <strong>{providerNames[destination]} steps</strong> · {steps.join(', ')}. These steps send the brief and their role instructions{retrieveSources ? ', plus retrieved excerpts' : ''}. Hosted review and revision also receive their preceding outputs.
              {destination === 'groq' ? <> Set <code>GROQ_API_KEY</code> before launching the app.</> : ' This recipe uses the saved OpenAI provider. Select Groq to switch it.'}
            </p>)}
            <button className="primary" disabled={!ready || pending || historyLoading || recipeSaving}>{pending ? 'Running workflow…' : runLabel}</button>
            {error && <p className="action-error" role="alert">{error}</p>}
          </form>
          <WorkflowRoute visibleSteps={visibleSteps} revise={revisionEnabled} retrieve={routeRetrieve} review={routeReview} />
          <section className="knowledge-card" aria-label="Workflow steps">
            <h3>Steps</h3>
            <ol className="workflow-steps">{stages.map(stage => {
              const step = visibleSteps[stage.id]
              const executed = step && step.status !== 'skipped' && stage.id !== 'retrieve'
                ? step.execution ?? (result ? { provider: result.provider, model: result.model } : null)
                : null
              return <li key={stage.id} id={`proposal-step-${stage.id}`}>
                <div className="workflow-step-head"><strong>{stage.label}</strong>
                  <span className={`workflow-state ${step?.status ?? 'waiting'}`} role="status">{step?.status ?? 'waiting'}</span>
                </div>
                <p>{stage.id === 'retrieve' && !routeRetrieve ? 'Use the brief as context.'
                  : (stage.id === 'review' || stage.id === 'revise') && !routeReview ? 'Review is off for this route.'
                    : stage.id === 'revise' && !revisionEnabled ? 'Return the original draft and review findings.' : stage.detail}</p>
                {executed && <p className="workflow-model">{providerNames[executed.provider]} · {executed.model}</p>}
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
            <p>Draft model · {providerNames[result.provider]} · {result.model} · {new Date(result.timestamp).toLocaleString()}</p>
            {result.proposal && <div>{result.proposal}</div>}
            {wasRevised && <p>One revision completed. Check the review findings and any open issues before sharing.</p>}
            {!result.proposal && <p>The steps above show where the run stopped and any output it produced.</p>}
            <details><summary>{routeRetrieve ? 'Brief and source query' : 'Brief'}</summary><pre>{result.brief}{routeRetrieve && `\n\nSearch terms: ${result.query}`}</pre></details>
            <details><summary>Drafting skill snapshot</summary><pre>{result.drafter}</pre></details>
            {routeReview && <details><summary>Review agent and skill snapshots</summary><pre>{result.reviewer}</pre></details>}
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
