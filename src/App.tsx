import { useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { evaluateSource } from './domain/quality'
import './App.css'
import './Modal.css'

type Status = 'valid' | 'invalid'
type AssetKind = 'skills' | 'agents'
type StudioTab = 'overview' | 'source' | 'files' | 'quality' | 'publish'

type SkillSummary = {
  name: string
  description: string
  path: string
  relativePath: string
  modified: number
  status: Status
  errors: string[]
}

type AgentSummary = SkillSummary & {
  model: string
  tools: string[]
  skills: string[]
}

type Category = {
  name: string
  path: string
  relativePath: string
  children: Category[]
}

type Library = {
  root: string
  categories: Category[]
  skills: SkillSummary[]
  agents: AgentSummary[]
  agentCategories: Category[]
}

type SkillDocument = SkillSummary & {
  content: string
  fingerprint: string
  files: string[]
}

type AgentDocument = AgentSummary & {
  content: string
  fingerprint: string
}

type AssetSummary = SkillSummary | AgentSummary
type AssetDocument = SkillDocument | AgentDocument
type Selection = { kind: AssetKind; document: AssetDocument }
type CreationDialog = 'skill' | 'agent' | 'folder' | null
type Confirmation = {
  title: string
  body: string
  confirmLabel: string
  tone?: 'default' | 'danger'
  action: () => void | Promise<void>
}

const TOOL_OPTIONS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'WebSearch', 'WebFetch']
const SKILL_RECIPES = [
  { id: 'general', title: 'Workflow', detail: 'A repeatable process for a common task.' },
  { id: 'review', title: 'Review', detail: 'Find issues, prioritize them, and recommend fixes.' },
  { id: 'research', title: 'Research', detail: 'Gather evidence and synthesize an answer.' },
  { id: 'planning', title: 'Planner', detail: 'Turn a goal into sequenced, verifiable work.' },
  { id: 'skill-creator', title: 'Skill maker', detail: 'Design and improve reusable AI skills.' },
]
const isTauri = () => '__TAURI_INTERNALS__' in window
const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

function App() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [kind, setKind] = useState<AssetKind>('skills')
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selected, setSelected] = useState<Selection | null>(null)
  const [draft, setDraft] = useState('')
  const [tab, setTab] = useState<StudioTab>('overview')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState(() => isTauri() ? 'Choose a folder to begin.' : 'Run with “npm run tauri dev” to access local folders.')
  const [busy, setBusy] = useState(false)
  const [creationDialog, setCreationDialog] = useState<CreationDialog>(null)
  const [creationName, setCreationName] = useState('')
  const [creationDescription, setCreationDescription] = useState('')
  const [creationTemplate, setCreationTemplate] = useState('general')
  const [skillActivation, setSkillActivation] = useState('')
  const [skillTone, setSkillTone] = useState('clear and practical')
  const [skillOutputFormat, setSkillOutputFormat] = useState('a concise answer with clear next steps')
  const [skillInstructions, setSkillInstructions] = useState('')
  const [agentModel, setAgentModel] = useState('inherit')
  const [agentTools, setAgentTools] = useState<string[]>(['Read', 'Grep', 'Glob'])
  const [agentSkills, setAgentSkills] = useState<string[]>([])
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [libraryPathDialog, setLibraryPathDialog] = useState(false)
  const [libraryPath, setLibraryPath] = useState('')

  const isDirty = Boolean(selected && draft !== selected.document.content)

  const refresh = async (root = library?.root) => {
    if (!root || !isTauri()) return
    setBusy(true)
    try {
      const next = await invoke<Library>('scan_library', { root })
      setLibrary(next)
      localStorage.setItem('libraryRoot', root)
      setNotice(`Indexed ${next.skills.length} skills and ${next.agents.length} agents.`)
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    const root = localStorage.getItem('libraryRoot')
    if (root && isTauri()) queueMicrotask(() => void refresh(root))
  }, [])

  const askConfirmation = (next: Confirmation) => setConfirmation(next)

  const runConfirmation = async () => {
    const next = confirmation
    setConfirmation(null)
    if (next) await next.action()
  }

  const chooseRoot = async () => {
    const perform = () => {
      setLibraryPath(library?.root ?? '')
      setLibraryPathDialog(true)
    }
    if (isDirty) {
      askConfirmation({ title: 'Leave unsaved changes?', body: 'Changing libraries will discard the current editor draft.', confirmLabel: 'Discard and continue', tone: 'danger', action: perform })
    } else await perform()
  }

  const loadLibraryPath = async (event: FormEvent) => {
    event.preventDefault()
    const path = libraryPath.trim()
    if (!path) {
      setNotice('Enter the full path to an existing library folder.')
      return
    }
    setLibraryPathDialog(false)
    setSelected(null)
    setDraft('')
    await refresh(path)
  }

  const loadAsset = async (assetKind: AssetKind, asset: AssetSummary) => {
    try {
      const command = assetKind === 'skills' ? 'read_skill' : 'read_agent'
      const args = assetKind === 'skills'
        ? { root: library!.root, skillPath: asset.path }
        : { root: library!.root, agentPath: asset.path }
      const document = await invoke<AssetDocument>(command, args)
      setSelected({ kind: assetKind, document })
      setDraft(document.content)
      setTab('overview')
      setNotice(`${assetKind === 'skills' ? 'Skill' : 'Agent'} loaded from disk.`)
    } catch (error) {
      setNotice(String(error))
    }
  }

  const requestLoadAsset = (assetKind: AssetKind, asset: AssetSummary) => {
    if (isDirty) {
      askConfirmation({ title: 'Discard editor changes?', body: 'The current source has unsaved changes.', confirmLabel: 'Discard changes', tone: 'danger', action: () => loadAsset(assetKind, asset) })
    } else void loadAsset(assetKind, asset)
  }

  const switchKind = (nextKind: AssetKind) => {
    if (nextKind === kind) return
    const perform = () => {
      setKind(nextKind)
      setSelectedCategory('')
      setSelected(null)
      setDraft('')
      setQuery('')
      setTab('overview')
    }
    if (isDirty) {
      askConfirmation({ title: 'Discard editor changes?', body: 'Switching studios will discard the current source changes.', confirmLabel: 'Switch studio', tone: 'danger', action: perform })
    } else perform()
  }

  const saveAsset = async () => {
    if (!selected || !library) return
    setBusy(true)
    try {
      const isSkill = selected.kind === 'skills'
      const command = isSkill ? 'save_skill' : 'save_agent'
      const args = isSkill
        ? { root: library.root, skillPath: selected.document.path, content: draft, expectedFingerprint: selected.document.fingerprint }
        : { root: library.root, agentPath: selected.document.path, content: draft, expectedFingerprint: selected.document.fingerprint }
      const document = await invoke<AssetDocument>(command, args)
      setSelected({ kind: selected.kind, document })
      setDraft(document.content)
      setNotice(`Saved ${isSkill ? 'SKILL.md' : 'agent source'}.`)
      await refresh()
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }

  const openCreationDialog = (type: Exclude<CreationDialog, null>) => {
    setCreationName('')
    setCreationDescription('')
    setCreationTemplate(type === 'agent' ? 'specialist' : 'general')
    setSkillActivation('')
    setSkillTone('clear and practical')
    setSkillOutputFormat('a concise answer with clear next steps')
    setSkillInstructions('')
    setAgentModel('inherit')
    setAgentTools(['Read', 'Grep', 'Glob'])
    setAgentSkills([])
    setCreationDialog(type)
  }

  const createItem = async (event: FormEvent) => {
    event.preventDefault()
    if (!library || !creationDialog) return
    const name = creationName.trim()
    const description = creationDescription.trim()
    if (!name || (creationDialog !== 'folder' && !description)) return
    setBusy(true)
    try {
      if (creationDialog === 'folder') {
        await invoke(kind === 'skills' ? 'create_category' : 'create_agent_category', { root: library.root, parent: selectedCategory, name })
        setNotice(`Created folder “${name}”.`)
      } else if (creationDialog === 'skill') {
        const skill = await invoke<SkillSummary>('create_skill', {
          root: library.root,
          category: selectedCategory,
          name,
          description,
          template: creationTemplate,
          preferences: {
            activation: skillActivation,
            tone: skillTone,
            outputFormat: skillOutputFormat,
            instructions: skillInstructions,
          },
        })
        setCreationDialog(null)
        await refresh()
        await loadAsset('skills', skill)
        return
      } else {
        const agent = await invoke<AgentSummary>('create_agent', {
          root: library.root,
          category: selectedCategory,
          name,
          description,
          model: agentModel,
          tools: agentTools,
          skills: agentSkills,
          template: creationTemplate,
        })
        setCreationDialog(null)
        await refresh()
        await loadAsset('agents', agent)
        return
      }
      setCreationDialog(null)
      await refresh()
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }

  const seedStarters = async () => {
    if (!library) return
    setBusy(true)
    try {
      const created = await invoke<SkillSummary[]>('seed_starter_skills', { root: library.root })
      await refresh()
      setNotice(created.length ? `Added ${created.length} starter skills.` : 'Starter skills are already present.')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }
  const seedStarterAgents = async () => {
    if (!library) return
    setBusy(true)
    try {
      const created = await invoke<AgentSummary[]>('seed_starter_agents', { root: library.root })
      await refresh()
      setNotice(created.length ? `Added ${created.length} starter agents.` : 'Starter agents are already present.')
    } catch (error) {
      setNotice(String(error))
    } finally {
      setBusy(false)
    }
  }

  const importSkill = async () => {
    if (!library) return
    setNotice('Import is temporarily unavailable while native dialogs are disabled on this Windows setup.')
  }

  const exportZip = async () => {
    if (!selected || selected.kind !== 'skills' || !library) return
    const destination = `${library.root}\\${selected.document.name}.zip`
    try {
      await invoke('export_skill_zip', { root: library.root, skillPath: selected.document.path, destination })
      setNotice('ZIP exported for manual Claude upload.')
    } catch (error) {
      setNotice(String(error))
    }
  }

  const install = async (scope: 'personal' | 'project') => {
    if (!selected || !library) return
    let projectRoot: string | null = null
    if (scope === 'project') {
      setNotice('Project installation is temporarily unavailable while native dialogs are disabled on this Windows setup.')
      return
    }
    const assetLabel = selected.kind === 'skills' ? 'skill' : 'agent'
    askConfirmation({
      title: `Install ${assetLabel} to Claude Code?`,
      body: scope === 'personal'
        ? `This will make “${selected.document.name}” available across local Claude Code projects.`
        : `This will make “${selected.document.name}” available in the selected project.`,
      confirmLabel: 'Install',
      action: async () => {
        setBusy(true)
        try {
          const isSkill = selected.kind === 'skills'
          const command = isSkill ? 'install_skill' : 'install_agent'
          const args = isSkill
            ? { root: library.root, skillPath: selected.document.path, scope, projectRoot }
            : { root: library.root, agentPath: selected.document.path, scope, projectRoot }
          const path = await invoke<string>(command, args)
          setNotice(`Installed locally at ${path}`)
        } catch (error) {
          setNotice(String(error))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  const reveal = async () => {
    if (!library) return
    try {
      await invoke('reveal_in_file_manager', { path: selected?.document.path ?? library.root })
    } catch (error) {
      setNotice(String(error))
    }
  }

  const summaries: AssetSummary[] = useMemo(() => kind === 'skills' ? (library?.skills ?? []) : (library?.agents ?? []), [kind, library])
  const categories = useMemo(() => kind === 'skills' ? (library?.categories ?? []) : (library?.agentCategories ?? []), [kind, library])
  const filtered = useMemo(() => summaries.filter(asset => {
    const categoryMatch = !selectedCategory || asset.relativePath.startsWith(`${selectedCategory}/`)
    const search = query.toLowerCase()
    return categoryMatch && (!search || `${asset.name} ${asset.description}`.toLowerCase().includes(search))
  }), [summaries, query, selectedCategory])

  const quality = useMemo(() => selected
    ? evaluateSource(selected.kind === 'skills' ? 'skill' : 'agent', draft, library?.skills.map(item => item.name) ?? [])
    : null, [selected, draft, library])

  const renderCategories = (items: Category[], depth = 0): React.ReactNode => items.map(category => (
    <div key={category.path}>
      <button className={`tree-item ${selectedCategory === category.relativePath ? 'active' : ''}`} style={{ paddingLeft: 16 + depth * 14 }} onClick={() => setSelectedCategory(category.relativePath)}>
        <span>›</span> {category.name}
      </button>
      {renderCategories(category.children, depth + 1)}
    </div>
  ))

  const agent = selected?.kind === 'agents' ? selected.document as AgentDocument : null
  const skill = selected?.kind === 'skills' ? selected.document as SkillDocument : null

  return (
    <main className="app-shell">
      <header>
        <div className="brand"><span className="mark">AI</span><div><h1>Command Center</h1><p>Capability Studio</p></div></div>
        <nav className="kind-switch" aria-label="Studio type">
          <button className={kind === 'skills' ? 'active' : ''} onClick={() => switchKind('skills')}>Skills <span>{library?.skills.length ?? 0}</span></button>
          <button className={kind === 'agents' ? 'active' : ''} onClick={() => switchKind('agents')}>Agents <span>{library?.agents.length ?? 0}</span></button>
          <button disabled title="Knowledge and RAG support is planned for a future release">Knowledge <small>Soon</small></button>
        </nav>
        <div className="header-actions"><button onClick={chooseRoot}>{library ? 'Change Library' : 'Choose Library'}</button><button onClick={() => refresh()} disabled={!library || busy}>↻ Refresh</button></div>
      </header>

      <section className="toolbar">
        <button className="primary" onClick={() => openCreationDialog(kind === 'skills' ? 'skill' : 'agent')} disabled={!library}>＋ New {kind === 'skills' ? 'Skill' : 'Agent'}</button>
        <button onClick={() => openCreationDialog('folder')} disabled={!library}>New Folder</button>
        {kind === 'skills' && <button onClick={importSkill} disabled={!library}>Import Skill</button>}
        {kind === 'skills' && <button onClick={seedStarters} disabled={!library || busy}>Add Starters</button>}
        {kind === 'agents' && <button onClick={seedStarterAgents} disabled={!library || busy}>Add Starters</button>}
        <button onClick={reveal} disabled={!library}>Reveal in Finder</button>
        <input aria-label={`Search ${kind}`} placeholder={`Search ${kind}…`} value={query} onChange={event => setQuery(event.target.value)} />
      </section>

      <section className="workspace">
        <aside className="folders">
          <div className="pane-title"><span>{kind === 'skills' ? 'Skill folders' : 'Agent folders'}</span></div>
          <button className={`tree-item ${selectedCategory === '' ? 'active' : ''}`} onClick={() => setSelectedCategory('')}><span>⌄</span> All {kind === 'skills' ? 'Skills' : 'Agents'}</button>
          {renderCategories(categories)}
          {kind === 'agents' && categories.length === 0 && library && <p className="sidebar-hint">Agent categories are real folders under <code>agents/</code>.</p>}
          <div className="root-path">{library?.root ?? 'No library selected'}</div>
        </aside>

        <aside className="assets">
          <div className="pane-title"><span>{kind === 'skills' ? 'Skills' : 'Agents'}</span><span>{filtered.length}</span></div>
          {filtered.map((asset, index) => {
            const itemAgent = kind === 'agents' ? asset as AgentSummary : null
            return <button key={asset.path} className={`asset-card ${selected?.document.path === asset.path ? 'selected' : ''}`} style={{ '--item-index': index } as CSSProperties} onClick={() => requestLoadAsset(kind, asset)}>
              <div><strong>{asset.name}</strong><span className={`status ${asset.status}`}>{asset.status}</span></div>
              <p>{asset.description || asset.errors[0]}</p>
              <small>{itemAgent ? `${itemAgent.model || 'inherit'} · ${itemAgent.tools.length} tools` : asset.relativePath}</small>
            </button>
          })}
          {library && filtered.length === 0 && <div className="empty"><strong>No {kind} here yet</strong><p>Create one or change the selected folder.</p></div>}
        </aside>

        <article className="studio">
          {selected ? <>
            <div className="studio-head">
              <div><div className="eyebrow">{selected.kind === 'skills' ? 'Portable skill' : 'Claude Code agent'}</div><h2>{selected.document.name}</h2><p>{selected.document.path}</p></div>
              <div className="head-status"><span className={`status ${selected.document.status}`}>{selected.document.status}</span>{isDirty && <span className="dirty-dot">Unsaved</span>}</div>
            </div>
            <div className="studio-tabs" role="tablist">
              {(['overview', 'source', 'files', 'quality', 'publish'] as StudioTab[]).map(item => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}
            </div>

            {tab === 'overview' && <section className="tab-panel overview-panel">
              <div className="summary-grid">
                <div className="summary-card wide"><span>Description</span><p>{selected.document.description}</p></div>
                <div className="summary-card"><span>Type</span><strong>{selected.kind === 'skills' ? 'Agent Skill' : 'Custom Agent'}</strong></div>
                <div className="summary-card"><span>Status</span><strong>{selected.document.status === 'valid' ? 'Ready' : 'Needs attention'}</strong></div>
                {agent && <><div className="summary-card"><span>Model</span><strong>{agent.model || 'inherit'}</strong></div><div className="summary-card wide"><span>Allowed tools</span><div className="chips">{agent.tools.length ? agent.tools.map(tool => <span key={tool}>{tool}</span>) : <em>All inherited tools</em>}</div></div><div className="summary-card wide"><span>Preloaded skills</span><div className="chips">{agent.skills.length ? agent.skills.map(item => <span key={item}>{item}</span>) : <em>No skills assigned</em>}</div></div></>}
                {skill && <div className="summary-card"><span>Bundled files</span><strong>{skill.files.length}</strong></div>}
              </div>
              {selected.document.errors.length > 0 && <div className="validation"><strong>Validation issues</strong>{selected.document.errors.map(error => <div key={error}>• {error}</div>)}</div>}
              <div className="quality-panel"><div><h3>Readiness: {quality?.state === 'ready' ? 'Ready' : quality?.state === 'blocked' ? 'Blocked' : 'Needs attention'}</h3><p>Deterministic checks only—no content leaves your computer.</p></div><div className="quality-list">{quality?.issues.slice(0, 4).map(issue => <div className={issue.severity === 'error' ? 'error' : 'warn'} key={issue.id}><span>{issue.severity === 'error' ? '×' : '!'}</span><div><strong>{issue.message}</strong><p>{issue.remediation}</p></div></div>)}{quality?.issues.length === 0 && <div className="pass"><span>✓</span><div><strong>No readiness issues found</strong></div></div>}</div><button onClick={() => setTab('quality')}>View all checks</button></div>
              <button onClick={() => setTab('source')}>Edit source</button>
            </section>}

            {tab === 'source' && <section className="tab-panel source-panel">
              <div className="source-toolbar"><div><strong>{selected.kind === 'skills' ? 'SKILL.md' : selected.document.path.split('/').pop()}</strong><span>Canonical filesystem source</span></div><button className="primary" disabled={!isDirty || busy} onClick={saveAsset}>{busy ? 'Saving…' : 'Save changes'}</button></div>
              <textarea aria-label={`${selected.kind} source`} value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} />
              <div className="source-footer"><span>{isDirty ? 'Unsaved changes' : 'Saved on disk'}</span><span>{draft.length.toLocaleString()} characters</span></div>
            </section>}

            {tab === 'files' && <section className="tab-panel files-panel">
              <div className="section-heading"><div><h3>Package files</h3><p>Supporting material remains beside the canonical instructions.</p></div><button onClick={reveal}>Reveal package</button></div>
              {skill ? <div className="file-list">{skill.files.map(file => <div key={file}><span className="file-icon">{file.endsWith('/') ? '▱' : '◇'}</span><code>{file}</code>{file === 'SKILL.md' && <small>Entry point</small>}</div>)}</div> : <div className="agent-file-note"><strong>Single-file agent definition</strong><p>Claude Code agents are portable Markdown files. Future Knowledge sources and resources will attach here without changing the agent’s canonical source.</p><code>{selected.document.path.split('/').pop()}</code></div>}
            </section>}

            {tab === 'quality' && <section className="tab-panel quality-tab">
              <div className="section-heading"><div><h3>{quality?.state === 'ready' ? 'Ready to publish' : quality?.state === 'blocked' ? 'Publishing blocked' : 'Needs attention'}</h3><p>Local static analysis of activation, instructions, constraints, and Claude compatibility.</p></div><span className={`quality-state ${quality?.state}`}>{quality?.state?.replace('-', ' ')}</span></div>
              <div className="issue-list">{quality?.issues.map(issue => <article className={`quality-issue ${issue.severity}`} key={issue.id}><span>{issue.severity}</span><div><h4>{issue.message}</h4><p>{issue.remediation}</p></div></article>)}{quality?.issues.length === 0 && <div className="quality-empty"><strong>All checks passed</strong><p>This source is structured, actionable, and ready for its current target.</p></div>}</div>
              <p className="quality-note">These checks never execute scripts, tools, hooks, or agent instructions.</p>
            </section>}

            {tab === 'publish' && <section className="tab-panel publish-panel">
              <div className="publish-hero"><div className="publish-icon">↗</div><div><h3>Publish to Claude Code</h3><p>{selected.kind === 'skills' ? 'Skills install as reversible links to this canonical library package.' : 'Agents install as verified Markdown copies because Claude does not formally guarantee agent-file symlinks.'}</p></div></div>
              <div className="publish-options"><button onClick={() => install('personal')} disabled={selected.document.status !== 'valid'}><strong>Personal installation</strong><span>Available across local projects</span></button><button onClick={() => install('project')} disabled={selected.document.status !== 'valid'}><strong>Project installation</strong><span>Choose a specific repository</span></button>{selected.kind === 'skills' && <button onClick={exportZip} disabled={selected.document.status !== 'valid'}><strong>Export ZIP</strong><span>For manual Claude account upload</span></button>}</div>
            </section>}
          </> : <div className="welcome"><div className="welcome-icon">{kind === 'skills' ? '⌘' : '◎'}</div><h2>{library ? `Select a${kind === 'agents' ? 'n' : ''} ${kind.slice(0, -1)}` : 'Your capabilities, on your disk'}</h2><p>{library ? `Choose a ${kind.slice(0, -1)} to inspect, improve, and publish it.` : 'Choose a local folder. Command Center keeps portable skills and agents as ordinary files you own.'}</p>{!library ? <button className="primary" onClick={chooseRoot}>Choose Capability Library</button> : <button className="primary" onClick={() => openCreationDialog(kind === 'skills' ? 'skill' : 'agent')}>Create {kind === 'skills' ? 'Skill' : 'Agent'}</button>}</div>}
        </article>
      </section>

      {creationDialog && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCreationDialog(null) }}>
        <form className="modal creation-modal" role="dialog" aria-modal="true" aria-labelledby="creation-title" onSubmit={createItem}>
          <div className="eyebrow">{creationDialog === 'skill' ? 'New portable skill' : creationDialog === 'agent' ? 'New custom agent' : 'New category'}</div>
          <h2 id="creation-title">{creationDialog === 'skill' ? 'Create a skill' : creationDialog === 'agent' ? 'Create an agent' : 'Create a folder'}</h2>
          <p>Location: {creationDialog === 'agent' || (creationDialog === 'folder' && kind === 'agents') ? `agents/${selectedCategory}` : selectedCategory || 'Library root'}</p>
          <label>Name<input autoFocus value={creationName} onChange={event => setCreationName(event.target.value)} placeholder={creationDialog === 'agent' ? 'Code investigator' : creationDialog === 'skill' ? 'Code reviewer' : 'Development'} /></label>
          {creationName && <div className="path-preview">{creationDialog === 'agent' || (creationDialog === 'folder' && kind === 'agents') ? 'agents/' : ''}{selectedCategory ? `${selectedCategory}/` : ''}{slugify(creationName)}{creationDialog === 'agent' ? '.md' : ''}</div>}
          {creationDialog !== 'folder' && <label>Description<textarea value={creationDescription} onChange={event => setCreationDescription(event.target.value)} placeholder="What does it do, and when should Claude use it?" rows={3} /></label>}
          {creationDialog === 'skill' && <>
            <fieldset className="recipe-picker"><legend>Start from a recipe</legend><div className="recipe-grid">{SKILL_RECIPES.map(recipe => <button type="button" key={recipe.id} className={creationTemplate === recipe.id ? 'recipe selected' : 'recipe'} onClick={() => setCreationTemplate(recipe.id)}><strong>{recipe.title}</strong><span>{recipe.detail}</span></button>)}</div></fieldset>
            <label>Use it when <input value={skillActivation} onChange={event => setSkillActivation(event.target.value)} placeholder="for example: a user asks to review a pull request" /></label>
            <div className="form-row"><label>Response style<select value={skillTone} onChange={event => setSkillTone(event.target.value)}><option value="clear and practical">Clear and practical</option><option value="concise and direct">Concise and direct</option><option value="thorough and rigorous">Thorough and rigorous</option><option value="teaching-oriented">Teaching-oriented</option><option value="warm and collaborative">Warm and collaborative</option></select></label><label>Preferred deliverable<select value={skillOutputFormat} onChange={event => setSkillOutputFormat(event.target.value)}><option value="a concise answer with clear next steps">Concise answer + next steps</option><option value="a numbered step-by-step plan">Numbered step-by-step plan</option><option value="a prioritized checklist">Prioritized checklist</option><option value="a short executive brief">Short executive brief</option><option value="findings grouped by priority">Findings grouped by priority</option></select></label></div>
            <label>Personal rules <textarea value={skillInstructions} onChange={event => setSkillInstructions(event.target.value)} placeholder="What should it always do, avoid, or ask before proceeding?" rows={3} /></label>
          </>}
          {creationDialog === 'agent' && <>
            <div className="form-row"><label>Model<select value={agentModel} onChange={event => setAgentModel(event.target.value)}><option value="inherit">Inherit session model</option><option value="sonnet">Sonnet</option><option value="opus">Opus</option><option value="haiku">Haiku</option></select></label><label>Starting role<select value={creationTemplate} onChange={event => setCreationTemplate(event.target.value)}><option value="specialist">Focused specialist</option><option value="reviewer">Reviewer</option><option value="researcher">Researcher</option><option value="planner">Planner</option></select></label></div>
            <fieldset><legend>Allowed tools</legend><div className="option-grid">{TOOL_OPTIONS.map(tool => <label className="check-option" key={tool}><input type="checkbox" checked={agentTools.includes(tool)} onChange={() => setAgentTools(current => current.includes(tool) ? current.filter(item => item !== tool) : [...current, tool])} />{tool}</label>)}</div></fieldset>
            <fieldset><legend>Preload skills</legend>{library?.skills.length ? <div className="skill-options">{library.skills.map(item => <label className="check-option" key={item.path}><input type="checkbox" checked={agentSkills.includes(item.name)} onChange={() => setAgentSkills(current => current.includes(item.name) ? current.filter(name => name !== item.name) : [...current, item.name])} /><span><strong>{item.name}</strong><small>{item.description}</small></span></label>)}</div> : <p className="field-help">Create skills first, then attach them to agents as capabilities.</p>}</fieldset>
          </>}
          {creationDialog !== 'folder' && <p className="field-help">Generates readable, editable Markdown. Nothing is executed and no provider is contacted.</p>}
          <div className="modal-actions"><button type="button" onClick={() => setCreationDialog(null)}>Cancel</button><button className="primary" type="submit" disabled={!creationName.trim() || (creationDialog !== 'folder' && !creationDescription.trim()) || busy}>{busy ? 'Creating…' : `Create ${creationDialog === 'agent' ? 'Agent' : creationDialog === 'skill' ? 'Skill' : 'Folder'}`}</button></div>
        </form>
      </div>}

      {libraryPathDialog && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setLibraryPathDialog(false) }}>
        <form className="modal confirm-modal" role="dialog" aria-modal="true" aria-labelledby="library-path-title" onSubmit={loadLibraryPath}>
          <div className="eyebrow">Local filesystem</div>
          <h2 id="library-path-title">Open a skills library</h2>
          <p>Enter an existing folder path. This folder remains the source of truth for your skills and agents.</p>
          <input autoFocus value={libraryPath} onChange={event => setLibraryPath(event.target.value)} placeholder="F:\\AI Command Center\\My Skills" />
          <div className="modal-actions"><button type="button" onClick={() => setLibraryPathDialog(false)}>Cancel</button><button className="primary" type="submit">Open library</button></div>
        </form>
      </div>}

      {confirmation && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmation(null) }}><section className="modal confirm-modal" role="alertdialog" aria-modal="true"><div className="eyebrow">Confirmation</div><h2>{confirmation.title}</h2><p>{confirmation.body}</p><div className="modal-actions"><button onClick={() => setConfirmation(null)}>Cancel</button><button className={confirmation.tone === 'danger' ? 'danger' : 'primary'} onClick={runConfirmation}>{confirmation.confirmLabel}</button></div></section></div>}

      <footer><span className={busy ? 'pulse' : ''}>{busy ? 'Working…' : notice}</span><span>Local-first · Filesystem source of truth</span></footer>
    </main>
  )
}

export default App
