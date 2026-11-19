import { describe, expect, it } from 'vitest'
import { planOf } from '../server/plan'
import type { Board, Item } from '../shared/types'

const box = (id: string, x: number, y: number, text: string, extra: Partial<Item> = {}): Item => ({ id, kind: 'box', x, y, w: 400, h: 180, text, ...extra })
const arrow = (from: string, to: string, text = ''): Item => ({ id: `a-${from}-${to}`, kind: 'arrow', x: 0, y: 0, w: 0, h: 0, from, to, text })
const board = (items: Item[], extra: Partial<Board> = {}): Board => ({ name: 'B', root: '/r', designs: [], comments: [], items, ...extra })

describe('planOf', () => {
  it('lists chained steps in arrow order', () => {
    const p = planOf('B', '/r', board([box('c', 1200, 0, 'Third'), box('a', 0, 0, 'First'), box('b', 600, 0, 'Second'), arrow('a', 'b'), arrow('b', 'c', 'then')]))
    expect(p).toContain('1. [First]\n  2. [Second]\n  3. [Third] (arrow says: then)')
  })
  it('lists a branch from its split point', () => {
    const p = planOf('B', '/r', board([box('a', 0, 0, 'Start'), box('b', 600, 0, 'Left'), box('c', 600, 400, 'Right'), arrow('a', 'b'), arrow('a', 'c')]))
    expect(p).toContain('Flow 2 (in order) — branches off the step above:\n  1. [Start]\n  2. [Right]')
  })
  it('groups by section and ties notes to media', () => {
    const items: Item[] = [
      { id: 's', kind: 'section', x: -100, y: -100, w: 3000, h: 2000, text: 'Refs' },
      { id: 'v', kind: 'video', x: 0, y: 0, w: 640, h: 360, src: 'studio-assets/x.mp4' },
      box('n', 0, 400, 'Copy this pacing', { attach: 'v' }),
    ]
    const p = planOf('B', '/r', board(items))
    expect(p).toContain('## Refs\n- Video file: /r/studio-assets/x.mp4\n    Note attached to it: "Copy this pacing"')
  })
  it('lists designs with their file and open comments', () => {
    const p = planOf('B', '/r', board([], { designs: [{ id: 'ads/A/index.html', x: 0, y: 0, w: 1080, h: 1350, rev: '1', title: 'Hero' }], comments: [{ id: 'c1', design: 'ads/A/index.html', x: 1, y: 1, target: 'headline', text: 'bigger', author: 'user', resolved: false, replies: [], ts: 1 }] }))
    expect(p).toContain('Design: Hero — file /r/ads/A/index.html (1080×1350)\n    Open comments: "bigger" on headline')
  })
})
