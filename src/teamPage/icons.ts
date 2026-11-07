// Line icons for buttons built in code, drawn like the ones in team.html (24-unit box, stroked with
// the text color). Buttons use these instead of symbol characters such as × or ↻.
export type IconName = 'close' | 'refresh' | 'external' | 'more' | 'prompt' | 'trash' | 'plus' | 'minus' | 'copy' | 'quote' | 'check' | 'stop' | 'retry' | 'edit' | 'download' | 'compare' | 'flag'

const PATHS: Record<IconName, string[]> = {
  close: ['M6.5 6.5l11 11', 'M17.5 6.5l-11 11'],
  refresh: ['M19 12a7 7 0 1 1-2.05-4.95', 'M19 4.5V8h-3.5'],
  external: ['M14 5h5v5', 'M19 5l-8 8', 'M17 13.5V18a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 5 18V8.5A1.5 1.5 0 0 1 6.5 7H11'],
  more: [],
  prompt: ['M7 3.8h6.4L17 7.4V20H7V3.8Z', 'M13.2 4v3.6h3.6', 'M9.6 11h4.8', 'M9.6 14h4.8', 'M9.6 17h2.8'],
  trash: ['M5 7h14', 'M10 4.5h4', 'M7 7l.8 11.2A1.5 1.5 0 0 0 9.3 19.5h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7', 'M10.5 10.5v5.5', 'M13.5 10.5v5.5'],
  plus: ['M12 5.5v13', 'M5.5 12h13'],
  minus: ['M5.5 12h13'],
  copy: ['M10.5 8.5h7a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2h-7a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2Z', 'M15.5 8.5v-2a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2'],
  quote: ['M5 7.5h4.5V12c0 2.4-1.3 4-3.5 4.5', 'M5 7.5V12h4.5', 'M14 7.5h4.5V12c0 2.4-1.3 4-3.5 4.5', 'M14 7.5V12h4.5'],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  stop: ['M8 6.5h8A1.5 1.5 0 0 1 17.5 8v8a1.5 1.5 0 0 1-1.5 1.5H8A1.5 1.5 0 0 1 6.5 16V8A1.5 1.5 0 0 1 8 6.5Z'],
  retry: ['M5 12a7 7 0 1 0 2.05-4.95', 'M5 4.5V8h3.5'],
  edit: ['M15 5.5l3.5 3.5L9 18.5H5.5V15L15 5.5Z', 'M13 7.5l3.5 3.5'],
  download: ['M12 4.5v10', 'M7.5 10.5 12 15l4.5-4.5', 'M5.5 19h13'],
  compare: ['M7 7.5h11', 'M15 4.5l3 3-3 3', 'M17 16.5H6', 'M9 13.5l-3 3 3 3'],
  flag: ['M6 20.5V4.5', 'M6 5h10.5l-2 3.5 2 3.5H6'],
}

const SVG_NS = 'http://www.w3.org/2000/svg'

export function createIcon(name: IconName, documentRef: Document = document): SVGSVGElement {
  const svg = documentRef.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.classList.add('ui-icon', `ui-icon-${name}`)
  for (const d of PATHS[name]) {
    const path = documentRef.createElementNS(SVG_NS, 'path')
    path.setAttribute('d', d)
    svg.append(path)
  }
  if (name === 'more') {
    for (const cx of [6, 12, 18]) {
      const dot = documentRef.createElementNS(SVG_NS, 'circle')
      dot.setAttribute('cx', String(cx))
      dot.setAttribute('cy', '12')
      dot.setAttribute('r', '1.2')
      svg.append(dot)
    }
  }
  return svg
}
