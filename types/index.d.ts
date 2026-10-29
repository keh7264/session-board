export type Board = {
  task: string
  doing: string | null
  decisions: string[]
  updatedAt: number
  carriedFrom?: number
}

export type Entry = Board & { sessionId: string; label: string }

declare module 'claude-code' {
  interface PluginState {
    'session-board': { board: Board | null; isFolded: boolean; others: Entry[]; isBoardOpen: boolean }
  }
}
