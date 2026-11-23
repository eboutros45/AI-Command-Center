import { useEffect, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'

export type Activity = {
  id: string
  title: string
  kind: 'agent_test' | 'proposal'
  status: 'running' | 'completed' | 'stopped'
  stage: string
  actor: string | null
  provider: 'ollama' | 'openai' | null
  model: string | null
  startedAt: number
  finishedAt: number | null
}

export type ActivityFeed = { work: Activity[]; loading: boolean; error: string }
type Snapshot = { revision: number; work: Activity[] }
const empty: Snapshot = { revision: -1, work: [] }

export function useAgentActivity(desktop: boolean): ActivityFeed {
  const [snapshot, setSnapshot] = useState<Snapshot>(empty)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!desktop) return
    let disposed = false
    let unlisten: UnlistenFn | undefined
    const accept = (next: Snapshot) => {
      if (!disposed) setSnapshot(current => next.revision >= current.revision ? next : current)
    }
    const connect = async () => {
      try {
        const stop = await listen<Snapshot>('agent-activity', event => accept(event.payload))
        if (disposed) { void stop(); return }
        unlisten = stop
        accept(await invoke<Snapshot>('activity_snapshot'))
      } catch (failure) {
        if (!disposed) setError(String(failure))
      }
    }
    void connect()
    return () => { disposed = true; void unlisten?.() }
  }, [desktop])
  return { work: snapshot.work, loading: desktop && snapshot.revision < 0 && !error, error }
}
