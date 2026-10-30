import { expect, test } from 'claude-code/testing'

import { findTerminal } from './register'

const list = JSON.stringify({ result: { terminals: [{ handle: 'term_a', tabId: 't1', leafId: 'l1' }, { handle: 'term_b', tabId: 't2', leafId: 'l2' }] } })

test('패널 자리로 새 핸들을 찾는다', () => {
  expect(findTerminal(list, 't2:l2')).toBe('term_b')
})

test('자리가 없으면 찾지 못한다', () => {
  expect(findTerminal(list, 't3:l3')).toBe(undefined)
  expect(findTerminal('{"result":null}', 't1:l1')).toBe(undefined)
})

test('다른 세션 줄을 누르면 Orca 터미널로 옮긴다', async ($, on) => {
  const dir = '/h/.claude/session-board'
  const other = { task: '다른 일', doing: null, decisions: [], updatedAt: 1, sessionId: 'b', label: 'b', orca: { terminal: 'term_b', bin: '/o' } }
  const runs: string[][] = []
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? '/h' : null }))
  on('session.id', () => ({ value: 'a' }))
  on('session.cwd', () => ({ value: '/w/a' }))
  on('clock.now', () => ({ value: 2 }))
  on('clock.every', () => ({ value: {} }))
  on('ui.panes', () => ({ value: [] }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('tool.register', () => ({ value: {} }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.exists', () => ({ value: true }))
  on('fs.list', () => ({ value: [{ kind: 'file', name: 'b.json', mtimeMs: 1 }] }))
  on('fs.read', (_, e) => ({ value: e.path === `${dir}/b.json` ? JSON.stringify(other) : '[]' }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    return { value: { exitCode: 0, stdout: '', stderr: '' } }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({
    plugin: 'session-board', component: 'Pane', requestId: 'session-board', surface: 'terminal',
    props: { title: 't', isFocused: false, bodyColumns: 60, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} },
  })
  await ui.press({ key: 'go-task' })
  expect(runs).toEqual([['/o/orca', 'terminal', 'switch', '--terminal', 'term_b', '--json']])
  await ui.unmount()
})
