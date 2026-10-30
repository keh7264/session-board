export type Board = {
  task: string
  doing: string | null
  decisions: string[]
  updatedAt: number
  carriedFrom?: number
}

export type OrcaPlace = { terminal: string; paneKey?: string; bin?: string }

export type Entry = Board & { sessionId: string; label: string; orca?: OrcaPlace }

declare module 'claude-code' {
  interface PluginState {
    'session-board': { board: Board | null; isFolded: boolean; others: Entry[]; isBoardOpen: boolean }
  }
}
