import { create } from 'zustand'
import type { Comment, Design } from '../shared/types'

export type Tool = 'move' | 'hand' | 'text' | 'rect' | 'ellipse' | 'note'
export interface Box { x: number; y: number; w: number; h: number }
export interface Guide { axis: 'x' | 'y'; pos: number; from: number; to: number }

export interface State {
  boards: { name: string; root: string; exists: boolean }[]
  board: string
  root: string
  designs: Record<string, Design>
  order: string[]
  loaded: Record<string, string> // rev currently shown in each iframe
  comments: Comment[]
  sel: { design: string | null; sids: number[] }
  hover: { design: string; sid: number | null } | null
  editing: { design: string; sid: number } | null
  openComment: string | null
  tool: Tool
  space: boolean
  view: { x: number; y: number; z: number }
  size: { w: number; h: number }
  guides: Guide[]
  marquee: Box | null
  connected: boolean
  toast: string | null
  tick: number // bumped whenever a live document changes, so overlays re-measure
  // what to do once a design has reloaded: select `sid` (null = keep what is selected) and maybe start typing in it
  afterLoad: { design: string; sid: number | null; edit?: boolean; at?: { x: number; y: number } } | null
  ask: { title: string; body: string; ok: string; danger?: boolean; resolve: (v: boolean) => void } | null
}

export const useStore = create<State>(() => ({
  boards: [], board: '', root: '', designs: {}, order: [], loaded: {}, comments: [],
  sel: { design: null, sids: [] }, hover: null, editing: null, openComment: null, tool: 'move', space: false,
  view: { x: 80, y: 80, z: 0.3 }, size: { w: 800, h: 600 }, guides: [], marquee: null,
  connected: false, toast: null, tick: 0, afterLoad: null, ask: null,
}))
export const get = useStore.getState
export const set = useStore.setState
export const bump = () => set({ tick: get().tick + 1 })
export const clientId = Math.random().toString(36).slice(2, 10)

let toastTimer: ReturnType<typeof setTimeout> | null = null
export function toast(msg: string) {
  set({ toast: msg })
  if (toastTimer) clearTimeout(toastTimer)
  toastTimer = setTimeout(() => set({ toast: null }), 4500)
}

/** In-app confirmation. Resolves true only when the user clicks the confirm button. */
export function ask(title: string, body: string, ok: string, danger = true): Promise<boolean> {
  return new Promise((resolve) => set({ ask: { title, body, ok, danger, resolve: (v) => { set({ ask: null }); resolve(v) } } }))
}

export function select(design: string | null, sids: number[] = []) {
  set({ sel: { design, sids }, openComment: null })
}
