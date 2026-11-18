// Studio: the HTML file is the design. These types describe the board around the files.

export interface Design {
  id: string // path relative to the board root, e.g. "ads/E-us-vs-them/index.html"
  x: number // position on the canvas
  y: number
  w: number // artboard size (the .ad element, or the page at `width`)
  h: number
  width?: number // viewport width for page-type designs (emails, briefs)
  rev: string // hash of the current source
  dirty?: boolean // differs from the agent's last version (has hand edits)
}

export interface Comment {
  id: string
  design: string
  x: number // artboard coordinates
  y: number
  target: string // description of the element under the pin
  text: string
  author: 'user' | 'agent'
  resolved: boolean
  replies: { by: string; text: string; ts: number }[]
  ts: number
}

export interface Board {
  name: string
  root: string
  designs: Design[]
  comments: Comment[]
}

/** One change to an element in the source. `sid` is the element's index in document order. */
export type Edit =
  | { kind: 'style'; sid: number; props: Record<string, string | null> }
  | { kind: 'attr'; sid: number; name: string; value: string | null }
  | { kind: 'inner'; sid: number; html: string }
  | { kind: 'remove'; sid: number }
  | { kind: 'duplicate'; sid: number }
  | { kind: 'insert'; parent: number; html: string }

export const SIZES: Record<string, [number, number]> = { '4x5': [1080, 1350], '9x16': [1080, 1920], '1x1': [1080, 1080] }
