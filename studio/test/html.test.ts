import { describe, expect, it } from 'vitest'
import { annotate, applyEdits, indexHtml, outline, parseDecls } from '../server/html'
import { plainSpaces, restack, sidAfter } from '../src/commands'

const SRC = `<!doctype html><meta charset="utf-8">
<style>.ad>*{position:absolute}.h{top:150px;font-size:56px}</style><div class="ad" style="background:#f4efe6">
<img class="logo" src="../../shared/img/logo.png" style="top:56px;height:60px">
<div class="c h">Clear lenses block<br>5 to 20%. <em>Dusk blocks ~99%.</em></div>
<div class="col" style="left:420px;background:url('a;b.png')"></div><p>one<p>two
</div>`

const sidOf = (s: string, pred: (e: ReturnType<typeof indexHtml>[number]) => boolean) => indexHtml(s).find(pred)!.sid

describe('html source editing', () => {
  it('indexes elements with their source positions', () => {
    const els = indexHtml(SRC)
    expect(els.map((e) => e.tag)).toEqual(['meta', 'style', 'div', 'img', 'div', 'br', 'em', 'div', 'p', 'p'])
    const h = els[4]
    expect(SRC.slice(h.start, h.end)).toMatch(/^<div class="c h">.*<\/div>$/s)
    expect(h.text).toBe('Clear lenses block 5 to 20%.')
    expect(els[3].parent).toBe(2)
  })

  it('changes one style and leaves every other byte alone', () => {
    const img = sidOf(SRC, (e) => e.tag === 'img')
    const r = applyEdits(SRC, [{ kind: 'style', sid: img, props: { top: '80px', translate: '10px 0px' } }])
    expect(r.source).toBe(SRC.replace('style="top:56px;height:60px"', 'style="top:80px;height:60px;translate:10px 0px"'))
    expect(r.structural).toBe(false)
    expect(r.notes[0]).toContain('top: 56px → 80px')
  })

  it('adds a style attribute when there is none, and removes it when empty', () => {
    const h = sidOf(SRC, (e) => e.attrs.class?.value === 'c h')
    const a = applyEdits(SRC, [{ kind: 'style', sid: h, props: { 'font-size': '62px' } }])
    expect(a.source).toContain('<div class="c h" style="font-size:62px">Clear')
    const b = applyEdits(a.source, [{ kind: 'style', sid: h, props: { 'font-size': null } }])
    expect(b.source).toBe(SRC)
  })

  it('keeps semicolons inside url() and quotes', () => {
    expect(parseDecls(`left:420px;background:url('a;b.png');font-family:"A;B", serif`)).toEqual([['left', '420px'], ['background', `url('a;b.png')`], ['font-family', '"A;B", serif']])
  })

  it('rewrites text, removes, duplicates and inserts', () => {
    const h = sidOf(SRC, (e) => e.attrs.class?.value === 'c h')
    const t = applyEdits(SRC, [{ kind: 'inner', sid: h, html: 'New <em>copy</em>' }])
    expect(t.source).toContain('<div class="c h">New <em>copy</em></div>')
    expect(t.structural).toBe(true)
    const img = sidOf(SRC, (e) => e.tag === 'img')
    const d = applyEdits(SRC, [{ kind: 'duplicate', sid: img }])
    expect(d.source.match(/<img/g)!.length).toBe(2)
    expect(indexHtml(d.source)[d.newSid!].tag).toBe('img')
    const rm = applyEdits(d.source, [{ kind: 'remove', sid: d.newSid! }])
    expect(rm.source).toBe(SRC)
    const ad = sidOf(SRC, (e) => e.attrs.class?.value === 'ad')
    const ins = applyEdits(SRC, [{ kind: 'insert', parent: ad, html: '<div style="left:0">Hi</div>' }])
    expect(ins.source.endsWith('<div style="left:0">Hi</div></div>')).toBe(true)
    expect(indexHtml(ins.source)[ins.newSid!].text).toBe('Hi')
  })

  it('sets and removes attributes', () => {
    const img = sidOf(SRC, (e) => e.tag === 'img')
    const a = applyEdits(SRC, [{ kind: 'attr', sid: img, name: 'src', value: 'new "x".png' }])
    expect(a.source).toContain('src="new &quot;x&quot;.png"')
    const b = applyEdits(SRC, [{ kind: 'attr', sid: img, name: 'class', value: null }])
    expect(b.source).toContain('<img src="../../shared/img/logo.png"')
  })

  it('annotates without changing sids, and outlines for agents', () => {
    const a = annotate(SRC)
    expect(a).toContain('<div data-sid="2" class="ad"')
    expect(a).toContain('<em data-sid="6">')
    const o = outline(SRC)
    expect(o).toContain('<div.c.h> "Clear lenses block 5 to 20%."')
    expect(o).not.toContain('<meta')
  })

  it('fails loudly when the element is gone', () => {
    expect(() => applyEdits(SRC, [{ kind: 'remove', sid: 99 }])).toThrow(/not found/)
  })
})

describe('authoring check', () => {
  it('passes a well-built ad and flags the things that break editing', async () => {
    const { lint } = await import('../server/html')
    const good = `<!doctype html><style>body{margin:0}.ad{position:relative;width:1080px;height:1350px;overflow:hidden}.ad>*{position:absolute}</style>
<div class="ad"><img class="hero" src="a.png" style="left:0;top:300px;width:1080px"><div class="headline" style="left:80px;top:120px">Sleep <em>deeper</em></div></div>`
    expect(lint(good)).toEqual([])
    const bad = `<style>.ad>*{position:absolute}.x::before{content:"★"}.hero{background:url(a.png) !important;pointer-events:none}</style>
<div class="ad"><div>Loose text<div class="inner">block</div></div><div class="hero" style="right:0;bottom:0"></div></div><script>document.body.append('x')</script>`
    const msgs = lint(bad).map((f) => f.msg).join('\n')
    for (const word of ['<script>', '::before/::after', 'CSS background', '!important', 'pointer-events', 'loose text', 'no class', 'right/bottom']) expect(msgs).toContain(word)
  })
})

describe('editor logic', () => {
  it('moves several selected layers as one block, keeping their order', () => {
    const order = ['photo', 'a', 'b', 'c', 'd'] // back to front; photo is the background (floor 1)
    const pick = (...x: string[]) => new Set(x)
    // two neighbours, one step forward: both move (one at a time they would swap back)
    expect(restack(order, pick('a', 'b'), 1, 'forward')).toEqual(['photo', 'c', 'a', 'b', 'd'])
    expect(restack(order, pick('c', 'd'), 1, 'backward')).toEqual(['photo', 'a', 'c', 'd', 'b'])
    // to front / back whatever the click order, and never behind the background
    expect(restack(order, pick('c', 'a'), 1, 'front')).toEqual(['photo', 'b', 'd', 'a', 'c'])
    expect(restack(order, pick('d', 'b'), 1, 'back')).toEqual(['photo', 'b', 'd', 'a', 'c'])
    expect(restack(order, pick('a'), 1, 'backward')).toEqual(order)
    expect(restack(order, pick('d'), 1, 'forward')).toEqual(order)
    // the background itself may be moved
    expect(restack(order, pick('photo'), 0, 'forward')).toEqual(['a', 'photo', 'b', 'c', 'd'])
  })

  it('turns a lone typed &nbsp; back into a space, but leaves deliberate ones', () => {
    expect(plainSpaces('Buy two now', 'Buy two&nbsp;now')).toBe('Buy two now')
    expect(plainSpaces('Line one<br>two', 'Line one&nbsp;<br>two&nbsp;')).toBe('Line one<br>two')
    // also when the line ends inside an inline tag (a struck price, a restyled word)
    expect(plainSpaces('Was <s>$204</s>', 'Was <s>$204&nbsp;</s><br>now&nbsp;</b>')).toBe('Was <s>$204</s><br>now</b>')
    // a run of spaces used as padding stays
    expect(plainSpaces('x', '★★★★★&nbsp; &nbsp;Rated 4.9/5')).toBe('★★★★★&nbsp; &nbsp;Rated 4.9/5')
    // the copy already tied two words together on purpose: nothing is touched
    expect(plainSpaces('Buy&nbsp;2, get 1 free', 'Buy&nbsp;2, get one&nbsp;free')).toBe('Buy&nbsp;2, get one&nbsp;free')
  })

  it('renumbers elements after a text edit that added or removed tags', () => {
    // the copy is element 10 and held 2 tags; the edit added one <br>
    const fin = { design: 'a', after: 12, delta: 1 }
    expect(sidAfter(fin, 'a', 13)).toBe(14) // the next piece moves along
    expect(sidAfter(fin, 'a', 10)).toBe(10) // the copy itself and everything before it stay
    expect(sidAfter(fin, 'a', 7)).toBe(7)
    expect(sidAfter(fin, 'b', 13)).toBe(13) // another design is not affected
    expect(sidAfter(null, 'a', 13)).toBe(13)
  })

  it('adds new elements as the last child, so a z-index is what puts them in front', () => {
    const ad = sidOf(SRC, (e) => e.attrs.class?.value === 'ad')
    const r = applyEdits(SRC, [{ kind: 'insert', parent: ad, html: '<div style="left:0;z-index:4">Top</div>' }])
    const els = indexHtml(r.source)
    expect(els[r.newSid!].attrs.style.value).toBe('left:0;z-index:4')
    expect(els[r.newSid!].parent).toBe(ad)
  })

  it('drops an emptied text block as one remove, shifting later sids by the tags it held', () => {
    const h = sidOf(SRC, (e) => e.attrs.class?.value === 'c h') // holds <br> and <em>
    const col = sidOf(SRC, (e) => e.attrs.class?.value === 'col')
    const r = applyEdits(SRC, [{ kind: 'remove', sid: h }])
    expect(sidOf(r.source, (e) => e.attrs.class?.value === 'col')).toBe(sidAfter({ design: 'a', after: h + 2, delta: -3 }, 'a', col))
  })
})
