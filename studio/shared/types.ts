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
  title?: string // the name shown on the board, free text. The file keeps its own name.
  loose?: boolean // a piece sitting on the board outside any frame (a file under loose/)
}

export interface Comment {
  id: string
  design: string // '' = pinned on the board itself, not on a design (a video, a picture, a section, or bare board)
  item?: string // board comment: the board object under the pin; x and y are then measured from its corner, so the pin travels with it
  x: number // artboard coordinates (board comments: board coordinates, or from the item's corner)
  y: number
  target: string // description of the element under the pin
  text: string
  author: 'user' | 'agent'
  resolved: boolean
  replies: { by: string; text: string; ts: number }[]
  ts: number
}

/** A planning object on the board, outside any HTML file: steps, notes, sections, media, links and the arrows between them. */
export type ItemKind = 'box' | 'text' | 'section' | 'image' | 'video' | 'link' | 'arrow'
export interface Item {
  id: string
  kind: ItemKind
  x: number // world position (arrows: ignored, drawn between `from` and `to`)
  y: number
  w: number
  h: number
  text?: string // box/text/section title/link label/arrow label
  src?: string // image/video: path inside the board folder (studio-assets/…)
  url?: string // link
  from?: string // arrow: item id or design id
  to?: string
  attach?: string // a note tied to an image/video item: moves with it
  color?: string
  fs?: number // text size in board px (default: the style's)
  rot?: number // degrees clockwise, about the middle
  fx?: boolean // flipped left-right
  fy?: boolean // flipped upside down
  crop?: { src: string; x: number; y: number; w: number; h: number } // image: the part of the original (src) showing, in its pixels
}

export interface Board {
  name: string
  root: string
  designs: Design[]
  comments: Comment[]
  items?: Item[]
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
