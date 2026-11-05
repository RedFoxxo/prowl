/**
 * Functions that run inside the page. Playwright sends their source text, so
 * each must be self-contained: no imports, no outer variables, no helpers
 * defined elsewhere in this file.
 */

/** Attribute holding an element's ref, so the same element keeps the same ref between reads. */
export const REF_ATTR = 'data-prowl-ref'

export interface SnapshotArgs {
  refAttr: string
  /** Read only this element (a ref) and what is inside it. */
  scope?: string | undefined
}

export interface SnapshotResult {
  lines: string[]
  /** The scope ref no longer exists. */
  missing?: boolean
}

/**
 * The visible page as compact lines: headings as `#`, list items as `- `,
 * table rows as `a | b | c`, and every control as `[e12 button "Save"]`
 * with its state. Hidden elements are left out.
 */
export function pageSnapshot(args: SnapshotArgs): SnapshotResult {
  const REF = args.refAttr
  const counter = window as unknown as { __prowlNext?: number }
  const SKIP: Record<string, true> = { script: true, style: true, noscript: true, template: true, head: true, meta: true, link: true, path: true }
  const INPUT_ROLE: Record<string, string> = {
    checkbox: 'checkbox', radio: 'radio', button: 'button', submit: 'button', reset: 'button', image: 'button',
    range: 'slider', number: 'spinbutton', search: 'searchbox', file: 'file',
  }
  /** Controls whose content is their name: nothing inside them is read separately. */
  const LEAF: Record<string, true> = {
    button: true, link: true, checkbox: true, radio: true, switch: true, tab: true, menuitem: true, menuitemcheckbox: true,
    menuitemradio: true, option: true, slider: true, spinbutton: true, textbox: true, searchbox: true, file: true, combobox: true,
  }
  const CONTAINER: Record<string, true> = { listbox: true, treeitem: true, tree: true, menu: true, menubar: true, tablist: true, radiogroup: true }
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

  let lines: string[] = []
  let buf: string[] = []
  let prefix = ''
  /** The line being built holds a control; outside headings and table cells, each control gets its own line. */
  let hasControl = false
  let oneLine = false
  const flush = () => {
    const text = cut(clean(buf.join('')), 400)
    buf = []
    hasControl = false
    if (text !== '') {
      lines.push(prefix + text)
      prefix = ''
    }
  }

  const isControl = (el: Element) => el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement

  const hidden = (el: Element) => {
    if (el instanceof HTMLElement && el.hidden) return true
    if (el.getAttribute('aria-hidden') === 'true') return true
    const s = getComputedStyle(el)
    if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return true
    // Styled checkboxes and radios hide the real input with opacity 0; it still works.
    if (s.opacity === '0' && !isControl(el)) return true
    return s.display !== 'contents' && el.getClientRects().length === 0
  }

  const roleOf = (el: Element): string | undefined => {
    const explicit = el.getAttribute('role')?.trim().split(/\s+/)[0]
    if (explicit && explicit !== 'presentation' && explicit !== 'none' && explicit !== 'generic') return explicit
    const tag = el.localName
    if (tag === 'a' || tag === 'area') return el.hasAttribute('href') ? 'link' : undefined
    if (tag === 'button' || tag === 'summary') return 'button'
    if (tag === 'select') return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'input') return INPUT_ROLE[(el as HTMLInputElement).type] ?? 'textbox'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'dialog') return 'dialog'
    if (tag === 'table') return 'table'
    if (tag === 'li') return 'listitem'
    if (el instanceof HTMLElement && el.isContentEditable && el.hasAttribute('contenteditable')) return 'textbox'
    return undefined
  }

  const refOf = (el: Element) => {
    let ref = el.getAttribute(REF)
    if (!ref) {
      counter.__prowlNext = (counter.__prowlNext ?? 0) + 1
      ref = `e${counter.__prowlNext}`
      el.setAttribute(REF, ref)
    }
    return ref
  }

  const nameOf = (el: Element): string => {
    const aria = el.getAttribute('aria-label')
    if (aria && clean(aria)) return clean(aria)
    const by = el.getAttribute('aria-labelledby')
    if (by) {
      const text = clean(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' '))
      if (text) return text
    }
    if (isControl(el)) {
      const control = el as HTMLInputElement
      const labels = clean([...(control.labels ?? [])].map((l) => l.innerText).join(' '))
      if (labels) return labels
      if (el instanceof HTMLInputElement && (el.type === 'button' || el.type === 'submit' || el.type === 'reset')) return clean(el.value)
      const placeholder = el.getAttribute('placeholder')
      if (placeholder && clean(placeholder)) return clean(placeholder)
      return clean(el.getAttribute('title') ?? '')
    }
    if (el instanceof HTMLImageElement) return clean(el.alt)
    const text = clean(el instanceof HTMLElement ? el.innerText : (el.textContent ?? ''))
    return text || clean(el.getAttribute('title') ?? '')
  }

  const control = (el: Element, role: string) => {
    const parts = [`${refOf(el)} ${role}`]
    const name = cut(nameOf(el), 80)
    if (name) parts.push(JSON.stringify(name))
    if (el instanceof HTMLSelectElement) {
      const chosen = [...el.selectedOptions].map((o) => clean(o.text)).join(', ')
      if (chosen) parts.push(`= ${JSON.stringify(cut(chosen, 80))}`)
      if (el.options.length <= 12) parts.push(`options: ${[...el.options].map((o) => cut(clean(o.text), 40)).join(' | ')}`)
      else parts.push(`${el.options.length} options`)
    } else if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
      parts.push(el.checked ? 'checked' : 'unchecked')
    } else if (el instanceof HTMLInputElement && el.type === 'file') {
      parts.push(`${el.files?.length ?? 0} files`)
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const value = el.value
      if (value !== '' && value !== name) parts.push(el.type === 'password' ? '= "•••"' : `= ${JSON.stringify(cut(value, 120))}`)
    } else if (el instanceof HTMLElement && el.isContentEditable && role === 'textbox') {
      const value = clean(el.innerText)
      if (value !== '' && value !== name) parts.push(`= ${JSON.stringify(cut(value, 120))}`)
    }
    const checked = el.getAttribute('aria-checked')
    if (checked !== null && !(el instanceof HTMLInputElement)) parts.push(checked === 'true' ? 'checked' : checked === 'mixed' ? 'mixed' : 'unchecked')
    const expanded = el.getAttribute('aria-expanded')
    if (expanded !== null) parts.push(expanded === 'true' ? 'expanded' : 'collapsed')
    if (el.getAttribute('aria-selected') === 'true') parts.push('selected')
    if (el.getAttribute('aria-pressed') === 'true') parts.push('pressed')
    if (el.getAttribute('aria-current') && el.getAttribute('aria-current') !== 'false') parts.push('current')
    if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') parts.push('disabled')
    if ((el as HTMLInputElement).required || el.getAttribute('aria-required') === 'true') parts.push('required')
    if ((el as HTMLInputElement).readOnly || el.getAttribute('aria-readonly') === 'true') parts.push('readonly')
    if (el.getAttribute('aria-invalid') === 'true') parts.push('invalid')
    if (role === 'link') {
      const href = (el as HTMLAnchorElement).href
      if (href && !href.startsWith('javascript:')) {
        const url = new URL(href, location.href)
        const shown = url.origin === location.origin ? url.pathname + url.search + url.hash : href
        if (shown !== '#' && shown !== location.pathname + '#') parts.push(`→ ${cut(shown, 80)}`)
      }
    }
    return `[${parts.join(' ')}]`
  }

  /** The text of an element on one line, controls included. */
  const collect = (el: Element) => {
    const saved = { lines, buf, prefix, hasControl, oneLine }
    lines = []
    buf = []
    prefix = ''
    oneLine = true
    children(el).forEach(visit)
    flush()
    const text = lines.join(' ')
    ;({ lines, buf, prefix, hasControl, oneLine } = saved)
    return text
  }

  const children = (el: Element): Node[] => {
    if (el instanceof HTMLSlotElement) {
      const assigned = el.assignedNodes({ flatten: true })
      return assigned.length > 0 ? assigned : [...el.childNodes]
    }
    return [...(el.shadowRoot ?? el).childNodes]
  }

  const table = (el: Element) => {
    const caption = el instanceof HTMLTableElement && el.caption ? clean(el.caption.innerText) : ''
    if (caption) lines.push(`[table "${cut(caption, 80)}"]`)
    const rows = el instanceof HTMLTableElement ? [...el.rows] : [...el.querySelectorAll('[role=row]')]
    for (const row of rows) {
      if (hidden(row)) continue
      const cells = row instanceof HTMLTableRowElement ? [...row.cells] : [...row.querySelectorAll('[role=cell],[role=gridcell],[role=columnheader],[role=rowheader]')]
      const text = cells.filter((c) => !hidden(c)).map((c) => collect(c)).join(' | ')
      if (clean(text.replace(/\|/g, ''))) lines.push(cut(text, 600))
    }
  }

  const visit = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      buf.push(node.textContent ?? '')
      return
    }
    if (!(node instanceof Element)) return
    const el = node
    const tag = el.localName
    if (SKIP[tag] || hidden(el)) return
    // A label's text names its control; the control's line says it once.
    if (el instanceof HTMLLabelElement && el.control && !hidden(el.control)) {
      children(el).filter((n) => n instanceof Element).forEach(visit)
      return
    }
    if (tag === 'br') return flush()
    const role = roleOf(el)
    if (role && (LEAF[role] || CONTAINER[role])) {
      if (hasControl && !oneLine) flush()
      buf.push(` ${control(el, role)} `)
      hasControl = true
      if (LEAF[role]) return
    } else if (tag === 'iframe' || tag === 'frame') {
      flush()
      const title = el.getAttribute('title') || (el as HTMLIFrameElement).src
      lines.push(`[frame ${JSON.stringify(cut(title, 80))} (not read)]`)
      return
    } else if (tag === 'img' || role === 'img') {
      const alt = nameOf(el)
      if (alt) buf.push(` [image ${JSON.stringify(cut(alt, 80))}] `)
      return
    } else if (tag === 'svg') {
      const label = el.getAttribute('aria-label')
      if (label) buf.push(` [image ${JSON.stringify(cut(clean(label), 80))}] `)
      return
    } else if (tag === 'canvas' || tag === 'video') {
      const box = el.getBoundingClientRect()
      buf.push(` [${tag} ${Math.round(box.width)}×${Math.round(box.height)}] `)
      return
    } else if (role === 'heading') {
      flush()
      const level = Number(el.getAttribute('aria-level') ?? tag.slice(1)) || 2
      const text = collect(el)
      if (text) lines.push(`${'#'.repeat(Math.min(level, 6))} ${cut(text, 200)}`)
      return
    } else if (role === 'table' || role === 'grid') {
      flush()
      table(el)
      return
    } else if (role === 'dialog' || role === 'alertdialog' || role === 'alert' || role === 'status') {
      flush()
      const name = el.getAttribute('aria-label') ?? ''
      lines.push(`[${role}${name ? ` ${JSON.stringify(cut(clean(name), 80))}` : ''}]`)
      children(el).forEach(visit)
      flush()
      if (role === 'dialog' || role === 'alertdialog') lines.push(`[/${role}]`)
      return
    }
    const display = getComputedStyle(el).display
    const block = !display.startsWith('inline') && display !== 'contents'
    if (block || role === 'listitem') flush()
    if (role === 'listitem') prefix = '- '
    children(el).forEach(visit)
    if (block || role === 'listitem') flush()
  }

  let root: Element | null = document.body
  if (args.scope) {
    root = document.querySelector(`[${REF}="${args.scope}"]`)
    if (!root) return { lines: [], missing: true }
    visit(root)
  } else if (root) {
    children(root).forEach(visit)
  }
  flush()

  // Repeated identical lines (icons, separators, list rows) are printed once.
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    let n = 1
    while (lines[i + n] === lines[i]) n++
    out.push(n > 1 ? `${lines[i]} (×${n})` : lines[i]!)
    i += n - 1
  }
  return { lines: out }
}

/** Installed before any page script: records when the document last changed, for `settle`. */
export function watchMutations(refAttr: string): void {
  const w = window as unknown as { __prowlChanged?: number }
  if (w.__prowlChanged !== undefined) return
  w.__prowlChanged = performance.now()
  new MutationObserver((records) => {
    if (records.some((r) => r.attributeName !== refAttr)) w.__prowlChanged = performance.now()
  }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
}

/** Milliseconds since the document last changed. */
export function quietFor(): number {
  const w = window as unknown as { __prowlChanged?: number }
  return w.__prowlChanged === undefined ? Number.POSITIVE_INFINITY : performance.now() - w.__prowlChanged
}
