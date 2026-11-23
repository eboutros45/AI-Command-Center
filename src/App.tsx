import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { evaluateSource } from './domain/quality'
import Knowledge from './Knowledge'
import RunAndTest from './RunAndTest'
import Workflows from './Workflows'
import AgentCreator from './AgentCreator'
import AgentActivity from './AgentActivity'
import { useAgentActivity } from './useAgentActivity'
import './App.css'
import './Modal.css'

type Status = 'valid' | 'invalid'
type AssetKind = 'skills' | 'agents'
type StudioTab = 'overview' | 'source' | 'files' | 'quality' | 'publish'

export type SkillSummary = {
  name: string
  description: string
  path: string
  relativePath: string
  modified: number
  status: Status
  errors: string[]
}

export type AgentSummary = SkillSummary & {
  model: string
  tools: string[]
  skills: string[]
}

export type Category = {
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
type PathAction = {
  title: string
  description: string
  label: string
  submit: string
  initialValue?: string
  run: (path: string) => Promise<void>
}

const SKILL_RECIPES = [
  { id: 'general', title: 'Workflow', detail: 'A repeatable process for a common task.' },
  { id: 'review', title: 'Review', detail: 'Find issues, prioritize them, and recommend fixes.' },
  { id: 'research', title: 'Research', detail: 'Gather evidence and synthesize an answer.' },
  { id: 'planning', title: 'Planner', detail: 'Turn a goal into sequenced, verifiable work.' },
  { id: 'skill-creator', title: 'Skill maker', detail: 'Design and improve reusable AI skills.' },
]
const isTauri = () => '__TAURI_INTERNALS__' in window
const slugify = (value: string) => value.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')

function PathDialog({ action, onClose }: { action: PathAction; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [value, setValue] = useState(action.initialValue ?? '')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    dialog.current?.showModal()
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending || !value.trim()) return
    setPending(true)
    setError('')
    try {
      await action.run(value.trim().replace(/^"(.+)"$/, '$1'))
      onClose()
    } catch (failure) {
      setError(String(failure))
      setPending(false)
    }
  }

  return (
    <dialog ref={dialog} className="modal path-dialog" aria-labelledby="path-action-title" onCancel={event => {
      event.preventDefault()
      if (!pending) onClose()
    }}>
      <form onSubmit={submit}>
        <h2 id="path-action-title">{action.title}</h2>
        <p>{action.description}</p>
        <label>{action.label}<input autoFocus value={value} onChange={event => setValue(event.target.value)} disabled={pending} required /></label>
        {error && <p className="action-error" role="alert">{error}</p>}
        <div className="modal-actions">
          <button type="button" disabled={pending} onClick={onClose}>Cancel</button>
          <button className="primary" type="submit" disabled={pending || !value.trim()}>{pending ? 'Working…' : action.submit}</button>
        </div>
      </form>
    </dialog>
  )
}

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
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)
  const [pathAction, setPathAction] = useState<PathAction | null>(null)
  const [creationError, setCreationError] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const [result, setResult] = useState<{ message: string; path: string } | null>(null)
  const [workspaceView, setWorkspaceView] = useState<'knowledge' | 'run' | 'workflows' | 'activity' | null>(null)
  const [testAsset, setTestAsset] = useState<{ kind: 'skill' | 'agent'; path: string } | null>(null)
  const activity = useAgentActivity(isTauri())
  const activeCount = activity.work.filter(item => item.status === 'running').length

  const isDirty = Boolean(selected && draft !== selected.document.content)

  const scan = async (root: string) => {
      const next = await invoke<Library>('scan_library', { root })
      setLibrary(next)
      localStorage.setItem('libraryRoot', root)
      setNotice(`Indexed ${next.skills.length} skills and ${next.agents.length} agents.`)
  }

  const refresh = async (root = library?.root) => {
    if (!root || !isTauri()) return
    setBusy(true)
    try {
      await scan(root)
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
    const perform = () => setPathAction({
      title: 'Open a local library',
      description: 'Paste the full path of an existing folder for your skills and agents.',
      label: 'Library folder',
      submit: 'Open library',
      initialValue: library?.root,
      run: async path => {
        await scan(path)
        setSelected(null)
        setDraft('')
        setSelectedCategory('')
        setCollapsed(new Set())
        setQuery('')
        setResult(null)
      },
    })
    if (isDirty) {
      askConfirmation({ title: 'Leave unsaved changes?', body: 'Changing libraries will discard the current editor draft.', confirmLabel: 'Discard and continue', tone: 'danger', action: perform })
    } else await perform()
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
    if (type !== 'folder' && isDirty) {
      askConfirmation({ title: 'Discard editor changes?', body: 'Creating a new item will open it in the editor.', confirmLabel: 'Continue', tone: 'danger', action: () => startCreation(type) })
    } else startCreation(type)
  }

  const startCreation = (type: Exclude<CreationDialog, null>) => {
    setCreationError('')
    setCreationName('')
    setCreationDescription('')
    setCreationTemplate('general')
    setSkillActivation('')
    setSkillTone('clear and practical')
    setSkillOutputFormat('a concise answer with clear next steps')
    setSkillInstructions('')
    setCreationDialog(type)
  }

  const createItem = async (event: FormEvent) => {
    event.preventDefault()
    if (!library || !creationDialog || creationDialog === 'agent' || busy) return
    const name = creationName.trim()
    const description = creationDescription.trim()
    if (!name || (creationDialog !== 'folder' && !description)) return
    setBusy(true)
    setCreationError('')
    try {
      if (creationDialog === 'folder') {
        await invoke(kind === 'skills' ? 'create_category' : 'create_agent_category', { root: library.root, parent: selectedCategory, name })
        setSelectedCategory([selectedCategory, slugify(name)].filter(Boolean).join('/'))
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
        setTab('source')
        return
      }
      setCreationDialog(null)
      await refresh()
    } catch (error) {
      setCreationError(String(error))
    } finally {
      setBusy(false)
    }
  }

  const openCreatedAgent = async (agent: AgentSummary) => {
    setCreationDialog(null)
    const parts = agent.relativePath.split('/').slice(0, -1)
    setSelectedCategory(parts.join('/'))
    setCollapsed(previous => {
      const next = new Set(previous)
      parts.forEach((_, index) => next.delete(`agents/${parts.slice(0, index + 1).join('/')}`))
      return next
    })
    setQuery('')
    await refresh()
    await loadAsset('agents', agent)
    setTab('source')
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

  const importSkill = () => {
    if (!library) return
    setPathAction({
      title: 'Import a skill',
      description: `Copy a folder containing SKILL.md into ${selectedCategory || 'the library root'}.`,
      label: 'Source skill folder',
      submit: 'Import skill',
      run: async source => {
        const path = await invoke<string>('import_skill', { root: library.root, category: selectedCategory, source })
        setResult({ message: 'Skill imported', path })
        await refresh()
      },
    })
  }

  const exportZip = () => {
    if (!selected || selected.kind !== 'skills' || !library) return
    setPathAction({
      title: 'Export skill as ZIP',
      description: 'Choose an existing folder for the archive. The ZIP takes its name from the skill folder.',
      label: 'Destination folder',
      submit: 'Export ZIP',
      initialValue: library.root,
      run: async destinationFolder => {
        const path = await invoke<string>('export_skill_zip', { root: library.root, skillPath: selected.document.path, destinationFolder })
        setResult({ message: 'ZIP exported', path })
      },
    })
  }

  const install = (scope: 'personal' | 'project') => {
    if (!selected || !library) return
    const run = async (projectRoot: string | null) => {
      const isSkill = selected.kind === 'skills'
      const command = isSkill ? 'install_skill' : 'install_agent'
      const args = isSkill
        ? { root: library.root, skillPath: selected.document.path, scope, projectRoot }
        : { root: library.root, agentPath: selected.document.path, scope, projectRoot }
      const path = await invoke<string>(command, args)
      setResult({ message: 'Installed for Claude Code', path })
    }
    if (scope === 'project') {
      setPathAction({
        title: 'Install in a project',
        description: `Install “${selected.document.name}” into the project's .claude/${selected.kind} folder.`,
        label: 'Project folder',
        submit: 'Install in project',
        run,
      })
      return
    }
    askConfirmation({
      title: 'Install for all local projects?',
      body: `This will make “${selected.document.name}” available across local Claude Code projects.`,
      confirmLabel: 'Install',
      action: async () => {
        setBusy(true)
        try {
          await run(null)
        } catch (error) {
          setNotice(String(error))
        } finally {
          setBusy(false)
        }
      },
    })
  }

  const reveal = async (path: string) => {
    try {
      await invoke('reveal_in_file_manager', { path })
    } catch (error) {
      setNotice(String(error))
    }
  }

  const summaries: AssetSummary[] = useMemo(() => kind === 'skills' ? (library?.skills ?? []) : (library?.agents ?? []), [kind, library])
  const categories = useMemo(() => kind === 'skills' ? (library?.categories ?? []) : (library?.agentCategories ?? []), [kind, library])
  const filtered = useMemo(() => summaries.filter(asset => {
    const categoryMatch = !selectedCategory || asset.relativePath.startsWith(`${selectedCategory}/`)
    const search = query.trim().toLowerCase()
    return categoryMatch && (!search || `${asset.name} ${asset.description}`.toLowerCase().includes(search))
  }), [summaries, query, selectedCategory])

  const quality = useMemo(() => selected
    ? evaluateSource(selected.kind === 'skills' ? 'skill' : 'agent', draft, library?.skills.map(item => item.name) ?? [])
    : null, [selected, draft, library])

  const renderCategories = (items: Category[]): React.ReactNode => (
    <ul className="folder-branch">
      {items.map(category => {
        const key = `${kind}/${category.relativePath}`
        const active = selectedCategory === category.relativePath
        const expanded = !collapsed.has(key)
        const count = summaries.filter(asset => asset.relativePath.startsWith(`${category.relativePath}/`)).length
        return <li key={key}>
          <div className={`folder-row ${active ? 'current' : ''}`}>
            {category.children.length > 0
              ? <button type="button" className="folder-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${category.name}`} aria-expanded={expanded} onClick={() => setCollapsed(previous => {
                const next = new Set(previous)
                if (next.has(key)) next.delete(key)
                else next.add(key)
                return next
              })}>{expanded ? '⌄' : '›'}</button>
              : <span className="folder-toggle" aria-hidden="true">·</span>}
            <button className="folder-select" aria-current={active ? 'true' : undefined} title={category.relativePath} onClick={() => setSelectedCategory(category.relativePath)}>
              <span className="folder-icon" aria-hidden="true" /><span>{category.name}</span><small>{count}</small>
            </button>
          </div>
          {expanded && category.children.length > 0 && renderCategories(category.children)}
        </li>
      })}
    </ul>
  )

  const agent = selected?.kind === 'agents' ? selected.document as AgentDocument : null
  const skill = selected?.kind === 'skills' ? selected.document as SkillDocument : null

  return (
    <main className="app-shell">
      <aside className="folders">
        <div className="brand"><span className="mark" aria-hidden="true">✳</span><div><h1>Command Center</h1><p>Local workspace</p></div></div>
        <button className="library-switch" onClick={chooseRoot} disabled={busy}>
          <span className="folder-icon" aria-hidden="true" />
          <span><strong>{library ? library.root.split(/[\\/]/).filter(Boolean).at(-1) : 'Choose library'}</strong><small>{library ? 'Change library' : 'Open a folder on this device'}</small></span>
          <b aria-hidden="true">⌄</b>
        </button>
        <nav className="kind-switch" aria-label="Library type">
          <button className={!workspaceView && kind === 'skills' ? 'active' : ''} onClick={() => { setWorkspaceView(null); switchKind('skills') }}>Skills <span>{library?.skills.length ?? 0}</span></button>
          <button className={!workspaceView && kind === 'agents' ? 'active' : ''} onClick={() => { setWorkspaceView(null); switchKind('agents') }}>Agents <span>{library?.agents.length ?? 0}</span></button>
        </nav>
        <button className={`knowledge-nav ${workspaceView === 'knowledge' ? 'current' : ''}`} aria-pressed={workspaceView === 'knowledge'} onClick={() => setWorkspaceView('knowledge')}>Knowledge</button>
        <button className={`knowledge-nav ${workspaceView === 'run' ? 'current' : ''}`} aria-pressed={workspaceView === 'run'} onClick={() => { setTestAsset(null); setWorkspaceView('run') }}>Run &amp; Test</button>
        <button className={`knowledge-nav ${workspaceView === 'workflows' ? 'current' : ''}`} aria-pressed={workspaceView === 'workflows'} onClick={() => setWorkspaceView('workflows')}>Workflows</button>
        <button className={`knowledge-nav activity-nav ${workspaceView === 'activity' ? 'current' : ''}`} aria-pressed={workspaceView === 'activity'} onClick={() => setWorkspaceView('activity')}>
          Agent Activity{activeCount > 0 && <span className="activity-count" aria-label={`${activeCount} active`}>{activeCount}</span>}
        </button>
        <div className="folder-scroll">
          {!workspaceView && <>
          <div className="pane-title"><span>Folders</span><button className="icon-button" aria-label="New folder" title="New folder" onClick={() => openCreationDialog('folder')} disabled={!library || busy}>+</button></div>
          <button className={`all-folders ${!selectedCategory ? 'current' : ''}`} aria-current={!selectedCategory ? 'true' : undefined} onClick={() => setSelectedCategory('')}><span aria-hidden="true">▦</span> All {kind}<small>{summaries.length}</small></button>
          {renderCategories(categories)}
          {library && categories.length === 0 && <p className="sidebar-hint">Use + to add a folder.</p>}
          </>}
        </div>
        {library && <div className="sidebar-bottom"><span title={library.root}>{library.root}</span><button onClick={() => reveal(library.root)}>Open in file manager</button></div>}
      </aside>

      {workspaceView === 'activity' ? <AgentActivity {...activity} openTests={() => { setTestAsset(null); setWorkspaceView('run') }} openWorkflows={() => setWorkspaceView('workflows')} /> : workspaceView === 'workflows' ? <Workflows key={library?.root} libraryRoot={library?.root} skills={library?.skills ?? []} agents={library?.agents ?? []} openLibrary={chooseRoot} /> : workspaceView === 'knowledge' ? <Knowledge libraryRoot={library?.root} skills={library?.skills ?? []} desktop={isTauri()} /> : workspaceView === 'run' ?
        <RunAndTest key={library?.root} libraryRoot={library?.root} skills={library?.skills ?? []} agents={library?.agents ?? []} initialAsset={testAsset} openLibrary={chooseRoot} /> : <section className="workspace">
        <header className="workspace-head">
          <div className="workspace-location"><span>{kind === 'skills' ? 'Skills' : 'Agents'} /</span><strong title={selectedCategory}>{selectedCategory.split('/').at(-1) || 'All folders'}</strong></div>
          {library && <div className="header-actions">
            <button className="icon-button" aria-label="Refresh library" title="Refresh library" disabled={busy} onClick={() => refresh()}>↻</button>
            <button onClick={kind === 'skills' ? seedStarters : seedStarterAgents} disabled={busy}>Add starters</button>
            {kind === 'skills' && <button onClick={importSkill} disabled={busy}>Import skill</button>}
            <button className="primary" onClick={() => openCreationDialog(kind === 'skills' ? 'skill' : 'agent')} disabled={busy}>+ New {kind === 'skills' ? 'skill' : 'agent'}</button>
          </div>}
        </header>
        <aside className="assets">
          <div className="list-header">
            <div><h2>{kind === 'skills' ? 'Skills' : 'Agents'}</h2><span>{filtered.length} {filtered.length === 1 ? 'item' : 'items'}</span></div>
            <input type="search" aria-label={`Search ${kind}`} placeholder={`Search ${kind}…`} value={query} onChange={event => setQuery(event.target.value)} disabled={!library} />
          </div>
          {filtered.map((asset, index) => {
            const itemAgent = kind === 'agents' ? asset as AgentSummary : null
            return <button key={asset.path} className={`asset-card ${selected?.document.path === asset.path ? 'selected' : ''}`} style={{ '--item-index': index } as CSSProperties} onClick={() => requestLoadAsset(kind, asset)}>
              <div><strong>{asset.name}</strong><span className={`status ${asset.status}`}>{asset.status}</span></div>
              <p>{asset.description || asset.errors[0]}</p>
              <small>{itemAgent ? `${itemAgent.model || 'inherit'} · ${itemAgent.tools.length} tools` : asset.relativePath}</small>
            </button>
          })}
          {library && filtered.length === 0 && <div className="empty"><strong>{query.trim() ? 'No matching results' : `No ${kind} here yet`}</strong><p>{query.trim() ? 'Try a different search.' : 'Create an item or choose another folder.'}</p></div>}
        </aside>

        <article className="studio">
          {selected ? <>
            <div className="studio-head">
              <div><div className="eyebrow">{selected.kind === 'skills' ? 'Portable skill' : 'Claude Code agent'}</div><h2>{selected.document.name}</h2><p>{selected.document.path}</p></div>
              <div className="head-status">
                <span className={`status ${selected.document.status}`}>{selected.document.status}</span>
                {isDirty && <span className="dirty-dot">Unsaved</span>}
                {selected.document.status === 'valid' && <button onClick={() => {
                  setTestAsset({ kind: selected.kind === 'skills' ? 'skill' : 'agent', path: selected.document.path })
                  setWorkspaceView('run')
                }}>Test saved {selected.kind === 'skills' ? 'skill' : 'agent'}</button>}
              </div>
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
              <div className="section-heading"><div><h3>Package files</h3><p>Supporting material remains beside the canonical instructions.</p></div><button onClick={() => reveal(selected.document.path)}>Open in file manager</button></div>
              {skill ? <div className="file-list">{skill.files.map(file => <div key={file}><span className="file-icon">{file.endsWith('/') ? '▱' : '◇'}</span><code>{file}</code>{file === 'SKILL.md' && <small>Entry point</small>}</div>)}</div> : <div className="agent-file-note"><strong>Single-file agent definition</strong><p>Claude Code agents are portable Markdown files. Future Knowledge sources and resources will attach here without changing the agent’s canonical source.</p><code>{selected.document.path.split('/').pop()}</code></div>}
            </section>}

            {tab === 'quality' && <section className="tab-panel quality-tab">
              <div className="section-heading"><div><h3>{quality?.state === 'ready' ? 'Ready to publish' : quality?.state === 'blocked' ? 'Publishing blocked' : 'Needs attention'}</h3><p>Local static analysis of activation, instructions, constraints, and Claude compatibility.</p></div><span className={`quality-state ${quality?.state}`}>{quality?.state?.replace('-', ' ')}</span></div>
              <div className="issue-list">{quality?.issues.map(issue => <article className={`quality-issue ${issue.severity}`} key={issue.id}><span>{issue.severity}</span><div><h4>{issue.message}</h4><p>{issue.remediation}</p></div></article>)}{quality?.issues.length === 0 && <div className="quality-empty"><strong>All checks passed</strong><p>This source is structured, actionable, and ready for its current target.</p></div>}</div>
              <p className="quality-note">These checks never execute scripts, tools, hooks, or agent instructions.</p>
            </section>}

            {tab === 'publish' && <section className="tab-panel publish-panel">
              <div className="publish-hero"><div className="publish-icon" aria-hidden="true">↑</div><div><h3>Publish to Claude</h3><p>{selected.kind === 'skills' ? 'Install locally in Claude Code, or export an archive for manual upload. Windows uses a copy if it cannot create a skill link.' : 'Install a Markdown copy of this agent in Claude Code.'}</p></div></div>
              {isDirty && <p className="action-error">Save your source changes before publishing.</p>}
              {selected.document.status !== 'valid' && <p className="action-error">Fix the source validation errors before publishing.</p>}
              <fieldset className="publish-options" disabled={busy || isDirty || selected.document.status !== 'valid'} aria-label="Publish options"><button onClick={() => install('personal')}><strong>Personal installation</strong><span>Available across local projects</span></button><button onClick={() => install('project')}><strong>Project installation</strong><span>Choose a specific repository</span></button>{selected.kind === 'skills' && <button onClick={exportZip}><strong>Export ZIP</strong><span>Save a portable skill archive</span></button>}</fieldset>
            </section>}
          </> : <div className="welcome"><div className="welcome-icon">{kind === 'skills' ? '⌘' : '◎'}</div><h2>{library ? `Select a${kind === 'agents' ? 'n' : ''} ${kind.slice(0, -1)}` : 'Your capabilities, on your disk'}</h2><p>{library ? `Choose a ${kind.slice(0, -1)} to inspect, improve, and publish it.` : 'Choose a local folder. Command Center keeps portable skills and agents as ordinary files you own.'}</p>{!library ? <button className="primary" onClick={chooseRoot}>Choose Capability Library</button> : <button className="primary" onClick={() => openCreationDialog(kind === 'skills' ? 'skill' : 'agent')}>Create {kind === 'skills' ? 'Skill' : 'Agent'}</button>}</div>}
        </article>
      </section>}

      {creationDialog === 'agent' && library && <AgentCreator root={library.root} initialCategory={selectedCategory} categories={library.agentCategories} skills={library.skills} onCreated={openCreatedAgent} onClose={() => setCreationDialog(null)} />}

      {creationDialog && creationDialog !== 'agent' && <div className="modal-backdrop" role="presentation">
        <form className="modal creation-modal" role="dialog" aria-modal="true" aria-labelledby="creation-title" onSubmit={createItem}>
          <div className="eyebrow">{creationDialog === 'skill' ? 'New portable skill' : 'New category'}</div>
          <h2 id="creation-title">{creationDialog === 'skill' ? 'Create a skill' : 'Create a folder'}</h2>
          <p>Location: {creationDialog === 'folder' && kind === 'agents' ? `agents/${selectedCategory}` : selectedCategory || 'Library root'}</p>
          <label>Name<input autoFocus value={creationName} onChange={event => setCreationName(event.target.value)} placeholder={creationDialog === 'skill' ? 'Code reviewer' : 'Development'} /></label>
          {creationName && <div className="path-preview">{creationDialog === 'folder' && kind === 'agents' ? 'agents/' : ''}{selectedCategory ? `${selectedCategory}/` : ''}{slugify(creationName)}</div>}
          {creationDialog !== 'folder' && <label>Description<textarea value={creationDescription} onChange={event => setCreationDescription(event.target.value)} placeholder="What does it do, and when should Claude use it?" rows={3} /></label>}
          {creationDialog === 'skill' && <>
            <fieldset className="recipe-picker"><legend>Start from a recipe</legend><div className="recipe-grid">{SKILL_RECIPES.map(recipe => <button type="button" key={recipe.id} aria-pressed={creationTemplate === recipe.id} className={creationTemplate === recipe.id ? 'recipe selected' : 'recipe'} onClick={() => setCreationTemplate(recipe.id)}><strong>{recipe.title}</strong><span>{recipe.detail}</span></button>)}</div></fieldset>
            <label>Use it when <input value={skillActivation} onChange={event => setSkillActivation(event.target.value)} placeholder="for example: a user asks to review a pull request" /></label>
            <div className="form-row"><label>Response style<select value={skillTone} onChange={event => setSkillTone(event.target.value)}><option value="clear and practical">Clear and practical</option><option value="concise and direct">Concise and direct</option><option value="thorough and rigorous">Thorough and rigorous</option><option value="teaching-oriented">Teaching-oriented</option><option value="warm and collaborative">Warm and collaborative</option></select></label><label>Preferred deliverable<select value={skillOutputFormat} onChange={event => setSkillOutputFormat(event.target.value)}><option value="a concise answer with clear next steps">Concise answer + next steps</option><option value="a numbered step-by-step plan">Numbered step-by-step plan</option><option value="a prioritized checklist">Prioritized checklist</option><option value="a short executive brief">Short executive brief</option><option value="findings grouped by priority">Findings grouped by priority</option></select></label></div>
            <label>Personal rules <textarea value={skillInstructions} onChange={event => setSkillInstructions(event.target.value)} placeholder="What should it always do, avoid, or ask before proceeding?" rows={3} /></label>
          </>}
          {creationDialog !== 'folder' && <p className="field-help">Generates readable, editable Markdown. Nothing is executed and no provider is contacted.</p>}
          {creationError && <p className="action-error" role="alert">{creationError}</p>}
          <div className="modal-actions"><button type="button" disabled={busy} onClick={() => setCreationDialog(null)}>Cancel</button><button className="primary" type="submit" disabled={!creationName.trim() || (creationDialog !== 'folder' && !creationDescription.trim()) || busy}>{busy ? 'Creating…' : `Create ${creationDialog === 'skill' ? 'Skill' : 'Folder'}`}</button></div>
        </form>
      </div>}

      {pathAction && <PathDialog action={pathAction} onClose={() => setPathAction(null)} />}

      {confirmation && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setConfirmation(null) }}><section className="modal confirm-modal" role="alertdialog" aria-modal="true"><div className="eyebrow">Confirmation</div><h2>{confirmation.title}</h2><p>{confirmation.body}</p><div className="modal-actions"><button onClick={() => setConfirmation(null)}>Cancel</button><button className={confirmation.tone === 'danger' ? 'danger' : 'primary'} onClick={runConfirmation}>{confirmation.confirmLabel}</button></div></section></div>}

      {result && <div className="result-toast">
        <div role="status"><strong>{result.message}</strong><span>{result.path}</span></div>
        <button onClick={() => reveal(result.path)}>Show on disk</button>
        <button className="icon-button" aria-label="Dismiss result" onClick={() => setResult(null)}>×</button>
      </div>}
      <footer><span role="status">{busy ? 'Working…' : notice}</span><span>Stored locally</span></footer>
    </main>
  )
}

export default App
