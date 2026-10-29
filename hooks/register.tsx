import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Board, Entry } from '../types'

const board = atom({ plugin: 'session-board', key: 'board' } as const, null)
const isFolded = atom({ plugin: 'session-board', key: 'isFolded' } as const, false)
const others = atom({ plugin: 'session-board', key: 'others' } as const, [])
const isBoardOpen = atom({ plugin: 'session-board', key: 'isBoardOpen' } as const, false)

const TOOL = 'mcp__session-board__set_board'
const PANE = 'session-board'
const PINK = '#FF8FC7'
const SKY = '#6EC6FF'
const INK = '#1F1F2E'
const SKY_SOFT = '#D8F0FF'
const SKY_DEEP = '#1E78B4'
const STALE_MS = 24 * 60 * 60 * 1000

const GUIDE = [
  '# 세션 띠 (session-board)',
  `사용자 입력창 위에 "지금 하는 일"과 "사용자가 정할 것"을 보여 주는 띠가 있다 (다른 세션의 대시보드 /board 에도 모인다). ${TOOL} 로 갱신한다.`,
  '- 새 일을 시작할 때, 하는 단계가 크게 바뀔 때, 사용자에게 고를 것을 묻거나 사용자가 답해서 정할 것이 바뀔 때 부른다. 같은 내용이면 다시 부르지 않는다.',
  '- task: 이 세션의 큰 일 한 줄. doing: 지금 하는 단계 한 줄(없으면 빈 문자열). decisions: 사용자가 아직 답하지 않은 결정 전체 목록 (짧은 질문 한 줄씩. 사용자가 정했거나, 일이 바뀌어 더는 필요 없어진 것은 빼고 보낸다).',
  '- 띠 갱신은 사용자에게 따로 알리지 않는다. 글은 사용자의 말(한국어)로 짧게.',
].join('\n')

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

async function dir($: EngineInterface) {
  return `${(await $.env.get('HOME')) ?? ''}/.claude/session-board`
}

async function label($: EngineInterface) {
  const cwd = await $.session.cwd()
  return cwd.split('/').filter(Boolean).pop() ?? cwd
}

async function publish($: EngineInterface, b: Board) {
  const sessionId = await $.session.id()
  const entry: Entry = { ...b, sessionId, label: await label($) }
  await $.fs.write(`${await dir($)}/${sessionId}.json`, JSON.stringify(entry))
}

async function readDismissed($: EngineInterface, sessionId: string): Promise<string[]> {
  try {
    const path = `${await dir($)}/${sessionId}.dismissed.json`
    return (await $.fs.exists(path)) ? (JSON.parse(await $.fs.read(path)) as string[]) : []
  } catch {
    return []
  }
}

async function dismiss($: EngineInterface, sessionId: string, text: string) {
  const root = await dir($)
  const list = await readDismissed($, sessionId)
  if (!list.includes(text)) await $.fs.write(`${root}/${sessionId}.dismissed.json`, JSON.stringify([...list, text].slice(-200)))
  if (sessionId === (await $.session.id())) return applyDismissed($)
  const path = `${root}/${sessionId}.json`
  try {
    const x = JSON.parse(await $.fs.read(path)) as Entry
    await $.fs.write(path, JSON.stringify({ ...x, decisions: x.decisions.filter(d => d !== text) }))
  } catch {}
  await loadOthers($)
}

async function applyDismissed($: EngineInterface) {
  const b = await read($, board)
  if (!b) return
  const gone = await readDismissed($, await $.session.id())
  const kept = b.decisions.filter(d => !gone.includes(d))
  if (kept.length === b.decisions.length) return
  const next = { ...b, decisions: kept }
  await update($, board, () => next)
  try {
    await publish($, next)
  } catch {}
}

async function loadOthers($: EngineInterface) {
  const root = await dir($)
  if (!(await $.fs.exists(root))) return
  const me = await $.session.id()
  const now = await $.clock.now()
  const found: Entry[] = []
  for (const f of await $.fs.list(root)) {
    if (f.kind !== 'file' || !f.name.endsWith('.json') || f.name.endsWith('.dismissed.json') || f.name === `${me}.json`) continue
    if (now - f.mtimeMs > STALE_MS) continue
    try {
      const x = JSON.parse(await $.fs.read(`${root}/${f.name}`)) as Entry & { ended?: boolean }
      if (!x.ended) found.push(x)
    } catch {}
  }
  found.sort((a, b) => b.decisions.length - a.decisions.length || b.updatedAt - a.updatedAt)
  await update($, others, prev => (same(prev, found) ? prev : found))
}

async function syncBoardOpen($: EngineInterface) {
  const open = (await $.ui.panes()).some(p => p.id === PANE)
  await update($, isBoardOpen, prev => (prev === open ? prev : open))
  return open
}

async function openBoard($: EngineInterface) {
  await loadOthers($)
  await $.ui.open({ id: PANE, title: '세션 대시보드' })
  await update($, isBoardOpen, () => true)
}

async function toggleBoard($: EngineInterface) {
  if (await syncBoardOpen($)) {
    await $.ui.close({ id: PANE })
    return update($, isBoardOpen, () => false)
  }
  await openBoard($)
}

function ago(now: number, at: number) {
  const m = Math.floor((now - at) / 60_000)
  if (m < 1) return '방금'
  if (m < 60) return `${m}분 전`
  return `${Math.floor(m / 60)}시간 전`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.tool.register({
      name: 'set_board',
      description:
        '입력창 위 띠에 이 세션의 지금 하는 일과 사용자가 정할 것 목록을 적는다. 매번 전체를 보낸다 (decisions 는 남은 것 전부).',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: '이 세션의 큰 일 한 줄' },
          doing: { type: 'string', description: '지금 하는 단계 한 줄, 없으면 빈 문자열' },
          decisions: { type: 'array', items: { type: 'string' }, description: '사용자가 아직 정하지 않은 것, 한 줄씩' },
        },
        required: ['task', 'decisions'],
      },
      isDeferred: false,
    })
    await $.command.register({ name: 'board', description: '모든 세션의 하는 일과 정할 것을 옆 창에 띄운다' })
    if (e.isInteractive) {
      await loadOthers($)
      $.clock.every(15_000, () => void loadOthers($).then(() => applyDismissed($)))
      $.clock.every(2_000, () => void syncBoardOpen($))
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    try {
      const path = `${await dir($)}/${await $.session.id()}.json`
      if (await $.fs.exists(path)) await $.fs.write(path, JSON.stringify({ ...(await read($, board)), decisions: [], ended: true }))
    } catch {}
    return next(e)
  })

  on('ui.open', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await update($, isBoardOpen, () => true)
    return r
  })

  on('ui.close', async ($, e, next) => {
    const r = await next(e)
    if (e.id === PANE) await update($, isBoardOpen, () => false)
    return r
  })

  on('command.run', { command: 'board' }, async $ => {
    await openBoard($)
    return {}
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    const input = e as unknown as { task?: unknown; doing?: unknown; decisions?: unknown }
    const gone = await readDismissed($, await $.session.id())
    const asked = Array.isArray(input.decisions) ? input.decisions.map(d => String(d).trim()).filter(Boolean) : []
    const next: Board = {
      task: String(input.task ?? '').trim(),
      doing: typeof input.doing === 'string' && input.doing.trim() ? input.doing.trim() : null,
      decisions: asked.filter(d => !gone.includes(d)),
      updatedAt: await $.clock.now(),
    }
    await update($, board, () => next)
    try {
      await publish($, next)
    } catch {}
    const dropped = asked.filter(d => gone.includes(d))
    return {
      result: dropped.length
        ? `띠를 갱신했다. 사용자가 띠에서 뺀 항목이라 넣지 않았다 (다시 보내지 말 것): ${dropped.join(' / ')}`
        : '띠를 갱신했다.',
    }
  })

  on('prompt.compose', async ($, e, next) => {
    const out = await next(e)
    if (!e.tools.includes(TOOL)) return out
    return { sections: [...out.sections, { id: 'session-board:guide', text: GUIDE, scope: 'session' as const }] }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const me = await $.session.id()
    const mine = await read($, board)
    const rest = await read($, others)
    const now = await $.clock.now()
    const entries: (Entry & { isMine: boolean })[] = [
      ...(mine ? [{ ...mine, sessionId: me, label: await label($), isMine: true }] : []),
      ...rest.map(r => ({ ...r, isMine: false })),
    ]
    const withDecisions = entries.filter(x => x.decisions.length > 0)
    const total = withDecisions.reduce((n, x) => n + x.decisions.length, 0)

    return (
      <Box flexDirection="column">
        <Box key="now-head" columnGap={1} marginBottom={1}>
          <Text backgroundColor={PINK} color={INK} bold>{' Now '}</Text>
          <Text dimColor>{`세션 ${entries.length}`}</Text>
        </Box>
        {entries.length === 0 ? <Box key="now-empty" paddingLeft={1}><Text dimColor>아직 적힌 세션이 없다.</Text></Box> : null}
        {entries.map(x => (
          <Box
            key={`now-${x.sessionId}`}
            flexDirection="column"
            borderStyle="round"
            borderColor={x.isMine ? PINK : 'inactive'}
            paddingX={1}
          >
            <Box key="title" justifyContent="space-between" columnGap={1}>
              <Box flexShrink={1} columnGap={1}>
                <Text color={x.isMine ? PINK : 'text'} bold>{x.label}</Text>
                {x.isMine ? <Text color={PINK}>· 이 세션</Text> : null}
              </Box>
              <Box flexShrink={0}><Text dimColor>{ago(now, x.updatedAt)}</Text></Box>
            </Box>
            <Box key="task"><Text>{x.task}</Text></Box>
            {x.doing ? (
              <Box key="doing" columnGap={1}>
                <Box flexShrink={0}><Text dimColor>└</Text></Box>
                <Box flexShrink={1}><Text dimColor italic>{x.doing}</Text></Box>
              </Box>
            ) : null}
          </Box>
        ))}

        <Box key="dec-head" columnGap={1} marginTop={1} marginBottom={1}>
          <Text backgroundColor={SKY} color={INK} bold>{' Decisions '}</Text>
          <Text dimColor>{`${total}`}</Text>
        </Box>
        {total === 0 ? <Box key="dec-empty" paddingLeft={1}><Text dimColor>정할 것이 없다.</Text></Box> : null}
        {withDecisions.map(x => (
          <Box key={`dec-${x.sessionId}`} flexDirection="column" marginBottom={1}>
            <Box key="title" columnGap={1}>
              <Text color={x.isMine ? PINK : 'text'} bold>{x.label}</Text>
              <Text dimColor>{`${x.decisions.length}`}</Text>
            </Box>
            {x.decisions.map((d, i) => (
              <Box key={`d-${i}`} columnGap={1} hover={{ scope: `row-${x.sessionId}-${i}`, backgroundColor: SKY_SOFT }}>
                <Box flexShrink={0}><Text color={SKY} hover={{ scope: `row-${x.sessionId}-${i}`, color: SKY_DEEP, backgroundColor: SKY_SOFT }}>▎</Text></Box>
                <Box flexShrink={0} width={2}><Text color={SKY} bold hover={{ scope: `row-${x.sessionId}-${i}`, color: SKY_DEEP, backgroundColor: SKY_SOFT }}>{`${i + 1}`}</Text></Box>
                <Box flexShrink={1} flexGrow={1}><Text hover={{ scope: `row-${x.sessionId}-${i}`, color: INK, backgroundColor: SKY_SOFT }}>{d}</Text></Box>
                <Box key={`frame-x-${i}`} flexShrink={0}>
                  <Button key={`x-${i}`} plain hover={{ bold: true, color: SKY_DEEP }} onPress={() => void dismiss($, x.sessionId, d)}>
                    <Text color={SKY} hover={{ scope: `row-${x.sessionId}-${i}`, color: SKY_DEEP, bold: true, backgroundColor: SKY_SOFT }}>×</Text>
                  </Button>
                </Box>
              </Box>
            ))}
          </Box>
        ))}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const b = await read($, board)
    if (e.props.hasSurvey || !b) return below

    const { Box, Button, Text } = $.ui.resolve(e)
    const folded = await read($, isFolded)
    const rest = await read($, others)
    const restDecisions = rest.reduce((n, x) => n + x.decisions.length, 0)
    const count = b.decisions.length
    const boardOpen = await read($, isBoardOpen)

    const actions = (
      <Box key="actions" flexShrink={0} columnGap={1}>
        <Box key="frame-toggle">
          <Button key="toggle" plain hover={{ underline: true, color: PINK }} onPress={() => update($, isFolded, f => !f)}>
            <Text dimColor>{folded ? 'Unfold' : 'Fold'}</Text>
          </Button>
        </Box>
        <Text dimColor>·</Text>
        <Box key="frame-board">
          <Button key="board" plain hover={{ underline: true, bold: true }} onPress={() => void toggleBoard($)}>
            <Text color={SKY}>{boardOpen ? 'Hide board' : 'Show board'}</Text>
          </Button>
        </Box>
      </Box>
    )
    const othersLine = rest.length ? (
      <Box key="frame-others" flexShrink={1}>
        <Button key="others" plain hover={{ underline: true }} onPress={() => void toggleBoard($)}>
          <Text dimColor>{`  다른 세션 ${rest.length} · `}</Text>
          <Text color={restDecisions ? SKY : 'inactive'}>{`Decisions ${restDecisions}`}</Text>
          <Text dimColor>{'  → /board'}</Text>
        </Button>
      </Box>
    ) : null
    const chip = (key: string, text: string, color: string) => (
      <Box key={key} flexShrink={0}><Text backgroundColor={color} color={INK} bold>{` ${text} `}</Text></Box>
    )

    if (folded) {
      return (
        <Box flexDirection="column">
          <Box key="folded" justifyContent="space-between" columnGap={1}>
            <Box flexShrink={1} columnGap={1}>
              {chip('now', 'Now', PINK)}
              <Box flexShrink={1}><Text bold wrap="truncate-end">{b.task}</Text></Box>
              {chip('dec', `Decisions ${count}`, count ? SKY : 'inactive')}
            </Box>
            {actions}
          </Box>
          {othersLine}
          {below}
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box key="task" columnGap={1}>
          {chip('now', 'Now', PINK)}
          <Box flexShrink={1}><Text bold>{b.task}</Text></Box>
        </Box>
        {b.doing ? (
          <Box key="doing" columnGap={1} paddingLeft={1}>
            <Box flexShrink={0}><Text color={PINK}>└</Text></Box>
            <Box flexShrink={1}><Text dimColor italic>{b.doing}</Text></Box>
          </Box>
        ) : null}
        <Box key="decisions-head">
          {chip('dec', `Decisions ${count}`, count ? SKY : 'inactive')}
        </Box>
        {b.decisions.map((d, i) => (
          <Box key={`d-${i}`} columnGap={1} hover={{ scope: `row-${'me'}-${i}`, backgroundColor: SKY_SOFT }}>
            <Box flexShrink={0}><Text color={SKY} hover={{ scope: `row-${'me'}-${i}`, color: SKY_DEEP, backgroundColor: SKY_SOFT }}>▎</Text></Box>
            <Box flexShrink={0} width={2}><Text color={SKY} bold hover={{ scope: `row-${'me'}-${i}`, color: SKY_DEEP, backgroundColor: SKY_SOFT }}>{`${i + 1}`}</Text></Box>
            <Box flexShrink={1} flexGrow={1}><Text hover={{ scope: `row-${'me'}-${i}`, color: INK, backgroundColor: SKY_SOFT }}>{d}</Text></Box>
            <Box key={`frame-x-${i}`} flexShrink={0}>
              <Button key={`x-${i}`} plain hover={{ bold: true, color: SKY_DEEP }} onPress={() => void $.session.id().then(id => dismiss($, id, d))}>
                <Text color={SKY} hover={{ scope: `row-${'me'}-${i}`, color: SKY_DEEP, bold: true, backgroundColor: SKY_SOFT }}>×</Text>
              </Button>
            </Box>
          </Box>
        ))}
        <Box key="footer" justifyContent="space-between" columnGap={1}>
          {othersLine ?? <Box key="spacer" />}
          {actions}
        </Box>
        {below}
      </Box>
    )
  })
}
