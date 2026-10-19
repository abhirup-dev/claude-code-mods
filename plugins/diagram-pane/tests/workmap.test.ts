import { expect, mock, test } from 'claude-code/testing'
import { foldText, parseMermaid } from '../hooks/draw.js'
import { toMermaid } from '../hooks/graph.js'

// The workmap layer: pins are files in ~/.claude/workmaps/<project>/, the
// transcript folds pinned mermaid to one line, click anchors open code.

const PIN = 'Here is the flow:\n\n```mermaid\nflowchart TD\n  A[Cart] --> B[Pay]\n```\n'
const CHANGED = 'flowchart TD\n  A[Cart] --> B[Pay]\n  B --> R[Refund]\n'

// A tiny in-memory filesystem for the noun events the plugin calls
function fakeFs(on, files = new Map<string, string>()) {
  let tick = 1
  const list = (dir: string) =>
    [...files.entries()]
      .filter(([p]) => p.startsWith(dir + '/'))
      .map(([p]) => p.slice(dir.length + 1).split('/')[0])
      .filter((n, i, a) => n && a.indexOf(n) === i)
      .map(name => {
        const full = dir + '/' + name
        const isDir = ![...files.keys()].some(p => p.startsWith(full + '/'))
        return { name, kind: isDir ? 'file' : 'dir', size: (files.get(full) || '').length, mtimeMs: tick, isLink: false }
      })
  on('fs.list', (_$: any, e: any) => ({ value: list(String(e.path ?? '')) }))
  on('fs.read', (_$: any, e: any) => {
    const text = files.get(String(e.path))
    return text === undefined ? { error: 'not found: ' + e.path } : { value: text }
  })
  on('fs.write', (_$: any, e: any) => { files.set(String(e.path), String(e.text)); tick += 1; return { value: undefined } })
  return files
}

function world(on, files: Map<string, string>, messages: () => unknown[] = () => [
  { role: 'user', text: 'explain checkout', toolUses: [] },
  { role: 'assistant', text: PIN, toolUses: [] },
]) {
  mock.store(on)
  mock.env(on, { HOME: '/h' })
  mock.clock(on)
  on('session.id', () => ({ value: 'wm-1' }))
  on('session.messages', () => ({ value: messages() }))
  on('ui.panes', () => ({ value: [{ id: 'diagrams', title: 'Diagrams', isPlaced: true }] }))
  on('ui.open', () => ({ value: undefined }))
  on('command.register', () => ({ value: undefined }))
  on('tool.register', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  fakeFs(on, files)
}

const start = ($: any) => $.session.start({ cwd: '/p/genai', surface: 'terminal', isInteractive: true })
const get = async ($: any) => String(((await $.tool.call({ tool: 'mcp__diagram-pane__diagram_get' } as never)) as { result?: unknown }).result)
const set = ($: any, input: Record<string, unknown>) =>
  ($.tool.call({ tool: 'mcp__diagram-pane__diagram_set', ...input } as never) as Promise<{ result?: unknown; deny?: string }>)

const pinDir = '/h/.claude/workmaps/genai'

test('a diagram drawn in chat is materialized to a pin file, and diagram_get names it', async ($, on) => {
  const files = new Map()
  world(on, files)
  await start($)
  const got = await get($)
  const name = [...files.keys()].find(p => p.startsWith(pinDir + '/'))
  expect(name).toBeDefined()
  expect(name).toMatch(/^\/h\/\.claude\/workmaps\/genai\/01-.*\.md$/)
  expect(files.get(name!)).toContain('flowchart TD')
  expect(files.get(name!)).toContain('A[Cart] --> B[Pay]')
  expect(got).toContain('file: ' + name)
})

test('editing the pin file changes the pane; the transcript scan does not resurrect the old pin', async ($, on) => {
  const files = new Map()
  world(on, files)
  await start($)
  await get($)
  const name = [...files.keys()].find(p => p.startsWith(pinDir + '/'))!
  files.set(name, files.get(name)!.replace('A[Cart] --> B[Pay]', 'A[Cart] --> B[Pay]\n  B --> R[Refund]'))
  const got = await get($)
  expect(got).toContain('"Refund"')
  expect([...files.keys()].filter(p => p.startsWith(pinDir + '/')).length).toBe(1)
})

test('an unpinned file leaves the pane, keeps its diagram seen, and is not re-pinned from the transcript', async ($, on) => {
  const files = new Map()
  world(on, files)
  await start($)
  await get($)
  const name = [...files.keys()].find(p => p.startsWith(pinDir + '/'))!
  files.set(name, '<!-- workmap: unpinned -->\n' + files.get(name)!)
  const got = await get($)
  expect(got).toContain('No pinned diagrams')
  expect([...files.keys()].filter(p => p.startsWith(pinDir + '/')).length).toBe(1) // no resurrection
})

test('diagram_set on a pin writes the change back to its file', async ($, on) => {
  const files = new Map()
  world(on, files)
  await start($)
  await get($)
  const name = [...files.keys()].find(p => p.startsWith(pinDir + '/'))!
  const r = await set($, { target: 'pin:1', mermaid: CHANGED })
  expect(r.deny).toBeUndefined()
  expect(files.get(name)).toContain('"Refund"')
  // The pane's pin and the file now agree, and a rescan keeps one pin
  const got = await get($)
  expect(got).toContain('"Refund"')
})

test('a click anchor parses into the node, survives the toMermaid round trip, and opens code in the pane', async ($, on) => {
  const anchored = '```mermaid\nflowchart TD\n  A[Cart] --> B[Pay]\n  click B "src/checkout.go:2"\n```\n'
  const files = new Map([['/p/genai/src/checkout.go', 'package checkout\n\nfunc Pay() {}\n']])
  world(on, files, () => [
    { role: 'user', text: 'explain checkout', toolUses: [] },
    { role: 'assistant', text: anchored, toolUses: [] },
  ])
  await start($)
  await get($)  // the first sync materializes the pin; the pane needs it before mounting

  const g = parseMermaid('flowchart TD\n  A[Cart] --> B[Pay]\n  click B "src/checkout.go:2"')!
  expect(g.nodes.find(n => n.id === 'B')?.anchor).toBe('src/checkout.go:2')
  expect(toMermaid(g)).toContain('click B "src/checkout.go:2"')

  const ui = await $.ui.mount({
    plugin: 'diagram-pane', surface: 'terminal', component: 'Pane', requestId: 'diagrams',
    props: { title: 'Diagrams', isFocused: true, bodyColumns: 60, placement: 'dock' } as never,
  })
  await ui.press({ key: 'pin:0' } as never)   // open the pin
  await ui.press({ key: 'node:B' } as never)  // drill into the anchored box
  expect(await ui.find({ type: 'Text', text: /⚓ src\/checkout\.go:2/ } as never)).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /func Pay\(\) \{\}/ } as never)).toBeDefined()
})

test('foldText folds only pinned mermaid blocks, to one line naming the pin', async () => {
  const text = 'Intro\n\n' + PIN + '\n\n```mermaid\nflowchart TD\n  X[X] --> Y[Y]\n```\n\n```bash\nls\n```\n'
  const folded = foldText(text, code => code.includes('Cart'))
  expect(folded).toContain('▸ diagram: Here is the flow — pinned')
  expect(folded).not.toContain('A[Cart] --> B[Pay]')
  // The unpinned mermaid, and every other fence, pass through untouched
  expect(folded).toContain('X[X] --> Y[Y]')
  expect(folded).toContain('```bash')
})
