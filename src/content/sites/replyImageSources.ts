import type { ReplyImageSource } from '../../group/types'

// Reads the generated images inside a reply: <img> elements matching `selector` whose https source
// passes `accepts`, once each, with their alt text and size.
export function readGeneratedImages(node: Node, selector: string, accepts: (url: URL, image: HTMLImageElement) => boolean): ReplyImageSource[] {
  const scope = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  if (!scope) return []
  const bySource = new Map<string, ReplyImageSource>()
  for (const image of scope.querySelectorAll<HTMLImageElement>(selector)) {
    let url: URL
    try {
      url = new URL(image.currentSrc || image.src, location.href)
    } catch {
      continue
    }
    if (url.protocol !== 'https:' || !accepts(url, image)) continue
    if (bySource.has(url.href)) continue
    const width = image.naturalWidth || image.width
    const height = image.naturalHeight || image.height
    bySource.set(url.href, {
      sourceUrl: url.href,
      ...(image.alt.trim() ? { alt: image.alt.trim() } : {}),
      ...(width > 0 ? { width } : {}),
      ...(height > 0 ? { height } : {}),
    })
  }
  return [...bySource.values()]
}
