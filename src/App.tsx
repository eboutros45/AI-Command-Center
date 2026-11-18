import { useEffect, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { save } from '@tauri-apps/plugin-dialog'
import './App.css'
import './Modal.css'

type Status = 'valid' | 'invalid'
type Skill = { name: string; description: string; path: string; relativePath: string; modified: number; status: Status; errors: string[] }
type Category = { name: string; path: string; relativePath: string; children: Category[] }
type Library = { root: string; categories: Category[]; skills: Skill[] }
type SkillDocument = Skill & { content: string; fingerprint: string; files: string[] }
type CreationDialog = 'skill' | 'folder' | null
const isTauri = () => '__TAURI_INTERNALS__' in window

function App() {
  const [library, setLibrary] = useState<Library | null>(null)
  const [selectedCategory, setSelectedCategory] = useState('')
  const [selected, setSelected] = useState<SkillDocument | null>(null)
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [notice, setNotice] = useState(() => isTauri() ? 'Choose a folder to begin.' : 'Run with “npm run tauri dev” to access local folders.')
  const [busy, setBusy] = useState(false)
  const [creationDialog, setCreationDialog] = useState<CreationDialog>(null)
  const [creationName, setCreationName] = useState('')
  const [creationDescription, setCreationDescription] = useState('')

  const chooseDirectory = async (title: string) => {
    try { return await invoke<string | null>('choose_directory', { title }) }
    catch (error) { setNotice(`Folder picker failed: ${String(error)}`); return null }
  }

  const refresh = async (root = library?.root) => {
    if (!root || !isTauri()) return
    setBusy(true)
    try {
      const next = await invoke<Library>('scan_library', { root })
      setLibrary(next); localStorage.setItem('libraryRoot', root)
      setNotice(`Indexed ${next.skills.length} skill${next.skills.length === 1 ? '' : 's'}.`)
    } catch (error) { setNotice(String(error)) } finally { setBusy(false) }
  }
  useEffect(() => {
    const root = localStorage.getItem('libraryRoot')
    if (root && isTauri()) queueMicrotask(() => void refresh(root))
  }, [])
  const chooseRoot = async () => {
    setNotice('Opening folder picker…')
    const path = await chooseDirectory('Choose Skills Library')
    if (path) await refresh(path); else setNotice('No folder selected.')
  }
  const loadSkill = async (skill: Skill) => {
    if (selected && draft !== selected.content && !confirm('Discard your unsaved changes?')) return
    try { const doc = await invoke<SkillDocument>('read_skill', { root: library!.root, skillPath: skill.path }); setSelected(doc); setDraft(doc.content); setNotice('Skill loaded from disk.') } catch (error) { setNotice(String(error)) }
  }
  const saveSkill = async () => {
    if (!selected || !library) return
    try { const doc = await invoke<SkillDocument>('save_skill', { root: library.root, skillPath: selected.path, content: draft, expectedFingerprint: selected.fingerprint }); setSelected(doc); setDraft(doc.content); setNotice('Saved to SKILL.md.'); await refresh() } catch (error) { setNotice(String(error)) }
  }
  const openCreationDialog = (type: Exclude<CreationDialog, null>) => {
    setCreationName(''); setCreationDescription(''); setCreationDialog(type)
  }
  const createItem = async (event: React.FormEvent) => {
    event.preventDefault(); if (!library || !creationDialog) return
    const name = creationName.trim(); const description = creationDescription.trim(); if (!name || (creationDialog === 'skill' && !description)) return
    setBusy(true)
    try {
      if (creationDialog === 'folder') {
        await invoke('create_category', { root: library.root, parent: selectedCategory, name }); setNotice(`Created folder “${name}”.`)
      } else {
        const skill = await invoke<Skill>('create_skill', { root: library.root, category: selectedCategory, name, description })
        setNotice(`Created skill “${name}”.`); setCreationDialog(null); await refresh(); await loadSkill(skill); return
      }
      setCreationDialog(null); await refresh()
    } catch (error) { setNotice(String(error)) } finally { setBusy(false) }
  }
  const importSkill = async () => {
    if (!library) return; const source = await chooseDirectory('Choose a skill folder'); if (!source) return
    try { await invoke('import_skill', { root: library.root, category: selectedCategory, source }); await refresh() } catch (error) { setNotice(String(error)) }
  }
  const exportZip = async () => {
    if (!selected || !library) return; const destination = await save({ title: 'Export Claude-compatible ZIP', defaultPath: `${selected.name}.zip`, filters: [{ name: 'ZIP archive', extensions: ['zip'] }] }); if (!destination) return
    try { await invoke('export_skill_zip', { root: library.root, skillPath: selected.path, destination }); setNotice('ZIP exported for manual Claude upload.') } catch (error) { setNotice(String(error)) }
  }
  const install = async (scope: 'personal' | 'project') => {
    if (!selected || !library) return; let projectRoot: string | null = null
    if (scope === 'project') { const path = await chooseDirectory('Choose Claude project'); if (!path) return; projectRoot = path }
    if (!confirm(`Install “${selected.name}” to Claude Code (${scope}) using a symlink?`)) return
    try { const path = await invoke<string>('install_skill', { root: library.root, skillPath: selected.path, scope, projectRoot }); setNotice(`Installed locally at ${path}`) } catch (error) { setNotice(String(error)) }
  }
  const reveal = async () => { if (!library) return; try { await invoke('reveal_in_file_manager', { path: selected?.path ?? library.root }) } catch (error) { setNotice(String(error)) } }
  const filtered = useMemo(() => (library?.skills ?? []).filter(skill => { const categoryMatch = !selectedCategory || skill.relativePath.startsWith(`${selectedCategory}/`); const search = query.toLowerCase(); return categoryMatch && (!search || `${skill.name} ${skill.description}`.toLowerCase().includes(search)) }), [library, query, selectedCategory])
  const renderCategories = (items: Category[], depth = 0): React.ReactNode => items.map(category => <div key={category.path}><button className={`tree-item ${selectedCategory === category.relativePath ? 'active' : ''}`} style={{ paddingLeft: 16 + depth * 14 }} onClick={() => setSelectedCategory(category.relativePath)}><span>⌄</span> {category.name}</button>{renderCategories(category.children, depth + 1)}</div>)

  return <main className="app-shell">
    <header><div className="brand"><span className="mark">AI</span><div><h1>Command Center</h1><p>Skills Library</p></div></div><div className="header-actions"><button onClick={chooseRoot}>{library ? 'Change Library' : 'Choose Library'}</button><button onClick={() => refresh()} disabled={!library || busy}>↻ Refresh</button></div></header>
    <section className="toolbar"><button className="primary" onClick={() => openCreationDialog('skill')} disabled={!library}>＋ New Skill</button><button onClick={() => openCreationDialog('folder')} disabled={!library}>New Folder</button><button onClick={importSkill} disabled={!library}>Import Skill</button><button onClick={reveal} disabled={!library}>Reveal in Finder</button><input aria-label="Search skills" placeholder="Search skills…" value={query} onChange={event => setQuery(event.target.value)} /></section>
    <section className="workspace">
      <aside className="folders"><div className="pane-title">Library</div><button className={`tree-item ${selectedCategory === '' ? 'active' : ''}`} onClick={() => setSelectedCategory('')}><span>⌄</span> All Skills</button>{renderCategories(library?.categories ?? [])}<div className="root-path">{library?.root ?? 'No library selected'}</div></aside>
      <aside className="skills"><div className="pane-title"><span>Skills</span><span>{filtered.length}</span></div>{filtered.map((skill, index) => <button key={skill.path} className={`skill-card ${selected?.path === skill.path ? 'selected' : ''}`} style={{ '--deal-index': index } as React.CSSProperties} onClick={() => loadSkill(skill)}><div><strong>{skill.name}</strong><span className={`status ${skill.status}`}>{skill.status}</span></div><p>{skill.description || skill.errors[0]}</p><small>{skill.relativePath}</small></button>)}{library && !filtered.length && <div className="empty">No skills here yet.</div>}</aside>
      <article className="editor">{selected ? <><div className="editor-head"><div><div className="eyebrow">SKILL.md</div><h2>{selected.name}</h2><p>{selected.path}</p></div><span className={`status ${selected.status}`}>{selected.status}</span></div>{selected.errors.length > 0 && <div className="validation"><strong>Validation</strong>{selected.errors.map(error => <div key={error}>• {error}</div>)}</div>}<textarea aria-label="Skill instructions" value={draft} onChange={event => setDraft(event.target.value)} spellCheck={false} /><div className="editor-actions"><span>{draft !== selected.content ? 'Unsaved changes' : `${selected.files.length} bundled file${selected.files.length === 1 ? '' : 's'}`}</span><button className="primary" disabled={draft === selected.content} onClick={saveSkill}>Save</button></div><div className="publish"><h3>Publish for Claude</h3><p>Install a reversible local symlink or export a ZIP for manual account upload.</p><div><button onClick={() => install('personal')} disabled={selected.status !== 'valid'}>Install Personal</button><button onClick={() => install('project')} disabled={selected.status !== 'valid'}>Install to Project…</button><button onClick={exportZip} disabled={selected.status !== 'valid'}>Export ZIP…</button></div></div></> : <div className="welcome"><div className="welcome-icon">⌘</div><h2>{library ? 'Select a skill' : 'Your skills, on your disk'}</h2><p>{library ? 'Choose a skill to inspect and edit its SKILL.md.' : 'Choose a local folder. AI Command Center keeps ordinary, portable skill packages as the source of truth.'}</p>{!library && <button className="primary" onClick={chooseRoot}>Choose Skills Library</button>}</div>}</article>
    </section>
    {creationDialog && <div className="modal-backdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) setCreationDialog(null) }}><form className="modal" onSubmit={createItem}><div className="eyebrow">{creationDialog === 'skill' ? 'New portable skill' : 'New category'}</div><h2>{creationDialog === 'skill' ? 'Create a skill' : 'Create a folder'}</h2><p>Location: {selectedCategory || 'Library root'}</p><label>Name<input autoFocus value={creationName} onChange={event => setCreationName(event.target.value)} placeholder={creationDialog === 'skill' ? 'Code reviewer' : 'Development'} /></label>{creationDialog === 'skill' && <label>Description<textarea value={creationDescription} onChange={event => setCreationDescription(event.target.value)} placeholder="When should Claude use this skill?" rows={4} /></label>}<div className="modal-actions"><button type="button" onClick={() => setCreationDialog(null)}>Cancel</button><button className="primary" type="submit" disabled={!creationName.trim() || (creationDialog === 'skill' && !creationDescription.trim()) || busy}>{busy ? 'Creating…' : 'Create'}</button></div></form></div>}
    <footer><span className={busy ? 'pulse' : ''}>{busy ? 'Working…' : notice}</span><span>Local-first · Filesystem source of truth</span></footer>
  </main>
}
export default App
