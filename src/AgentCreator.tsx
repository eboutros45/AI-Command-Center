import { useEffect, useRef, useState, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import type { AgentSummary, Category, SkillSummary } from './App'
import './Modal.css'

const presets = [
  { id: 'specialist', label: 'Specialist', detail: 'Own a focused task and report back with evidence.', description: '' },
  { id: 'reviewer', label: 'Reviewer', detail: 'Check a draft and prioritize the gaps that matter.', description: 'Review drafts against their brief and evidence. Use before sharing work that needs a second opinion.' },
  { id: 'researcher', label: 'Researcher', detail: 'Investigate a question and cite the strongest sources.', description: 'Investigate a question and synthesize evidence. Use when a decision depends on reliable sources.' },
  { id: 'planner', label: 'Planner', detail: 'Break a goal into milestones with acceptance checks.', description: 'Turn a goal into a sequenced plan. Use before work that needs milestones, dependencies, and approval decisions.' },
] as const
const tools = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch']
const steps = ['Role', 'Capabilities', 'Review']
const slugify = (text: string) => text.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
const skillId = (skill: SkillSummary) => skill.path.split(/[\\/]/).filter(Boolean).at(-1) ?? ''

function folders(categories: Category[]): Category[] {
  return categories.flatMap(category => [category, ...folders(category.children)])
}

export default function AgentCreator({ root, initialCategory, categories, skills, onCreated, onClose }: {
  root: string
  initialCategory: string
  categories: Category[]
  skills: SkillSummary[]
  onCreated: (agent: AgentSummary) => void
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const [step, setStep] = useState(0)
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [preset, setPreset] = useState<(typeof presets)[number]>(presets[0])
  const [responsibilities, setResponsibilities] = useState('')
  const [boundaries, setBoundaries] = useState('')
  const [handoff, setHandoff] = useState('')
  const [category, setCategory] = useState(initialCategory)
  const [makeFolder, setMakeFolder] = useState(false)
  const [newFolder, setNewFolder] = useState('')
  const [model, setModel] = useState('inherit')
  const [inheritTools, setInheritTools] = useState(false)
  const [allowedTools, setAllowedTools] = useState(['Read', 'Grep', 'Glob'])
  const [selectedSkills, setSelectedSkills] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [preview, setPreview] = useState<{ relativePath: string; source: string } | null>(null)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => { dialog.current?.showModal() }, [])
  useEffect(() => { heading.current?.focus() }, [step])
  const id = slugify(name)
  const referenceCounts = new Map<string, number>()
  for (const skill of skills) {
    for (const reference of new Set([skillId(skill).toLowerCase(), skill.name.toLowerCase()])) {
      referenceCounts.set(reference, (referenceCounts.get(reference) ?? 0) + 1)
    }
  }
  const visibleSkills = skills.filter(skill =>
    `${skill.name} ${skill.relativePath} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())
  )
  const ready = step === 0
    ? Boolean(id && id.length <= 64 && description.trim())
    : Boolean((!makeFolder || slugify(newFolder)) && (inheritTools || allowedTools.length > 0))
  const draft = {
    name: name.trim(), description: description.trim(), template: preset.id, responsibilities, boundaries, handoff,
    category, newFolder: makeFolder ? newFolder : '', model,
    tools: inheritTools ? [] : allowedTools, skills: selectedSkills,
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || !ready) return
    setError('')
    if (step === 0) {
      setStep(1)
      return
    }
    setPending(true)
    try {
      if (step === 1) {
        setPreview(await invoke('preview_agent', { root, draft }))
        setStep(2)
      } else {
        const agent = await invoke<AgentSummary>('create_agent', { root, draft })
        onCreated(agent)
      }
    } catch (failure) {
      setError(String(failure))
    } finally {
      setPending(false)
    }
  }

  return (
    <dialog ref={dialog} className="modal creation-modal path-dialog agent-creator" aria-labelledby="agent-creator-title" onCancel={event => {
      event.preventDefault()
      if (!pending) onClose()
    }}>
      <form onSubmit={submit}>
        <h2 id="agent-creator-title" tabIndex={-1} ref={heading}>Create an agent</h2>
        <ol className="creator-steps" aria-label="Creation steps">{steps.map((label, index) => (
          <li key={label} aria-current={step === index ? 'step' : undefined}>{label}</li>
        ))}</ol>

        {step === 0 && <>
          <fieldset className="recipe-picker"><legend>Starting role</legend><div className="recipe-grid">
            {presets.map(role => <button type="button" key={role.id} aria-pressed={role.id === preset.id}
              className={role.id === preset.id ? 'recipe selected' : 'recipe'}
              onClick={() => {
                if (!description.trim() || description === preset.description) setDescription(role.description)
                setPreset(role)
              }}>
              <strong>{role.label}</strong><span>{role.detail}</span>
            </button>)}
          </div></fieldset>
          <label>Agent name<input required value={name} maxLength={100} onChange={event => setName(event.target.value)} placeholder="Proposal Reviewer" /></label>
          {id && <div className="path-preview">Claude Code ID: {id}</div>}
          <label>What it does and when to use it<textarea required rows={3} maxLength={400} value={description} onChange={event => setDescription(event.target.value)} /></label>
          <details className="creator-details">
            <summary>Customize role instructions</summary>
            <label>Responsibilities<textarea rows={2} maxLength={1500} value={responsibilities} onChange={event => setResponsibilities(event.target.value)} placeholder="Check pricing, source citations, and missing commitments." /></label>
            <label>Boundaries<textarea rows={2} maxLength={1500} value={boundaries} onChange={event => setBoundaries(event.target.value)} placeholder="Flag missing pricing details for the project owner." /></label>
            <label>Workflow handoff<textarea rows={2} maxLength={1500} value={handoff} onChange={event => setHandoff(event.target.value)} placeholder="Return prioritized findings the drafter can act on." /></label>
          </details>
        </>}

        {step === 1 && <fieldset className="creator-fields" disabled={pending}>
          <div className="form-row">
            <label>Save under<select value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">agents/</option>
              {folders(categories).map(folder => <option key={folder.path} value={folder.relativePath}>agents/{folder.relativePath}/</option>)}
            </select></label>
            <label>Claude Code model<select value={model} onChange={event => setModel(event.target.value)}>
              <option value="inherit">Inherit session model</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option>
            </select></label>
          </div>
          <label className="check-option folder-option"><input type="checkbox" checked={makeFolder} onChange={event => setMakeFolder(event.target.checked)} />Create a folder here</label>
          {makeFolder && <label>New folder name<input value={newFolder} required maxLength={100} onChange={event => setNewFolder(event.target.value)} placeholder="Delivery team" /></label>}
          <label>Tool access<select value={inheritTools ? 'inherit' : 'selected'} onChange={event => setInheritTools(event.target.value === 'inherit')}>
            <option value="selected">Selected tools</option><option value="inherit">Inherit session tools</option>
          </select></label>
          {!inheritTools && <fieldset><legend>Allowed tools</legend>
            <div className="option-grid">{tools.map(tool => <label className="check-option" key={tool}>
              <input type="checkbox" checked={allowedTools.includes(tool)} onChange={() => setAllowedTools(current =>
                current.includes(tool) ? current.filter(item => item !== tool) : [...current, tool]
              )} />{tool}
            </label>)}</div>
            {allowedTools.length === 0 && <p className="field-help">Choose at least one tool, or select Inherit session tools.</p>}
          </fieldset>}
          <fieldset><legend>Preloaded skills · {selectedSkills.length} selected</legend>
            {skills.length === 0 ? <p className="field-help">This library has no skills to attach yet.</p> : <>
              <label className="creator-search">Search skills<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search names, folders, and descriptions" /></label>
              <div className="skill-options">{visibleSkills.map(skill => {
                const reference = skillId(skill)
                const ambiguous = (referenceCounts.get(reference.toLowerCase()) ?? 0) > 1
                const checked = selectedSkills.includes(reference)
                return <label className="check-option" key={skill.path}>
                  <input type="checkbox" checked={checked} disabled={!reference || ambiguous || skill.status !== 'valid' || (!checked && selectedSkills.length >= 16)}
                    onChange={() => setSelectedSkills(current => checked ? current.filter(value => value !== reference) : [...current, reference])} />
                  <span><strong>{skill.name}</strong><small>{skill.relativePath || 'Library root'}{ambiguous ? ' · ambiguous ID' : skill.status !== 'valid' ? ' · needs attention' : ''}</small></span>
                </label>
              })}</div>
              {!visibleSkills.length && <p className="field-help">No skills match this search.</p>}
              {selectedSkills.length > 0 && <p className="field-help">Selected: {selectedSkills.join(', ')}</p>}
            </>}
          </fieldset>
        </fieldset>}

        {step === 2 && preview && <>
          <dl className="creator-summary">
            <div><dt>Save to</dt><dd>{preview.relativePath}</dd></div>
            <div><dt>Role</dt><dd>{preset.label}</dd></div>
            <div><dt>Claude Code model</dt><dd>{model}</dd></div>
            <div><dt>Tools</dt><dd>{inheritTools ? 'Inherit session tools' : allowedTools.join(', ')}</dd></div>
            <div><dt>Preloaded skills</dt><dd>{selectedSkills.length ? selectedSkills.join(', ') : 'None'}</dd></div>
          </dl>
          <details className="creator-details"><summary>Preview Markdown</summary><pre>{preview.source}</pre></details>
        </>}
        {error && <p className="action-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
          {step > 0 && <button type="button" disabled={pending} onClick={() => { setError(''); setStep(step - 1) }}>Back</button>}
          <button className="primary" type="submit" disabled={pending || !ready}>
            {pending ? 'Working…' : step === 0 ? 'Choose capabilities' : step === 1 ? 'Review agent' : 'Create agent'}
          </button>
        </div>
      </form>
    </dialog>
  )
}
