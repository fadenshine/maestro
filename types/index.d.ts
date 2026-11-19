export type BandRow = {
  name: string
  state: 'working' | 'waiting' | 'done'
  icon: string
  /** Completed steps in percent; null while the session has no task list. */
  percent: number | null
  /** Skill of the session: `[name]` loaded, `[name?]` assigned but not loaded yet. */
  skill?: string
  /** Shown in full before the text, for example how long a session has been quiet. */
  prefix?: string
  text: string
}

export type BandConflict = {
  file: string
  sessions: string[]
}

export type BandState = {
  /** What Maestro itself is doing right now (current step of its own list), if known. */
  ownStep: string
  rows: BandRow[]
  /** Name of the overall project; missing until the master is named. */
  project?: string
  /** Number of open items from `~/.claude/maestro/open/`. */
  open?: number
  /** 5-hour limit in percent; missing when the query fails. */
  limit?: number
  /** Files changed by more than one unchecked session of this master. */
  conflicts?: BandConflict[]
}

declare module 'claude-code' {
  interface PluginState {
    maestro: { band: BandState | null }
  }
}
