// Compares two folders of screenshots from scripts/visual/snap.mjs pixel by pixel and lists the
// screens that differ, with how many pixels and where. Exits with 1 when any screen differs.
//
//   npm run visual:compare -- test-artifacts/visual/before test-artifacts/visual/after
//
// A pixel differs when a channel moves by more than 2 levels (smaller moves are anti-aliasing noise
// between runs). Two areas change from run to run on their own and are left out: the members'
// avatar colours in the orchestration window (they come from random ids) and the times in search
// results.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { inflateSync } from 'node:zlib'

const TOLERANCE = 2
const NOISE = [
  { prefix: 'orchestration-', area: [180, 330, 240, 720] },
  { prefix: 'search-', area: [600, 260, 670, 460] },
]

// An 8-bit, non-interlaced PNG (what Chrome's screenshots are) to raw pixels.
export function decodePng(buffer) {
  let position = 8
  let width = 0
  let height = 0
  let channels = 0
  const data = []
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position)
    const type = buffer.toString('ascii', position + 4, position + 8)
    const chunk = buffer.subarray(position + 8, position + 8 + length)
    if (type === 'IHDR') {
      width = chunk.readUInt32BE(0)
      height = chunk.readUInt32BE(4)
      const colorTypes = { 0: 1, 2: 3, 4: 2, 6: 4 }
      channels = colorTypes[chunk[9]]
      if (chunk[8] !== 8 || !channels || chunk[12] !== 0) throw new Error('Only 8-bit, non-interlaced PNGs are supported')
    } else if (type === 'IDAT') {
      data.push(chunk)
    } else if (type === 'IEND') {
      break
    }
    position += 12 + length
  }
  const raw = inflateSync(Buffer.concat(data))
  const stride = width * channels
  const pixels = Buffer.alloc(height * stride)
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]
    const line = y * (stride + 1) + 1
    const row = y * stride
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? pixels[row + x - channels] : 0
      const up = y > 0 ? pixels[row - stride + x] : 0
      const upLeft = y > 0 && x >= channels ? pixels[row - stride + x - channels] : 0
      let value = raw[line + x]
      if (filter === 1) value += left
      else if (filter === 2) value += up
      else if (filter === 3) value += (left + up) >> 1
      else if (filter === 4) {
        const estimate = left + up - upLeft
        const toLeft = Math.abs(estimate - left)
        const toUp = Math.abs(estimate - up)
        const toUpLeft = Math.abs(estimate - upLeft)
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft
      }
      pixels[row + x] = value & 255
    }
  }
  return { width, height, channels, pixels }
}

function compare(before, after, name) {
  const a = decodePng(readFileSync(join(before, name)))
  const b = decodePng(readFileSync(join(after, name)))
  if (a.width !== b.width || a.height !== b.height) return `size ${a.width}x${a.height} → ${b.width}x${b.height}`
  const ignored = NOISE.filter(noise => name.startsWith(noise.prefix)).map(noise => noise.area)
  const colors = Math.min(a.channels, b.channels, 3)
  let count = 0
  let box = [Infinity, Infinity, -1, -1]
  for (let y = 0; y < a.height; y += 1) {
    for (let x = 0; x < a.width; x += 1) {
      if (ignored.some(([left, top, right, bottom]) => x >= left && x < right && y >= top && y < bottom)) continue
      const ia = (y * a.width + x) * a.channels
      const ib = (y * b.width + x) * b.channels
      let moved = false
      for (let c = 0; c < colors; c += 1) {
        if (Math.abs(a.pixels[ia + c] - b.pixels[ib + c]) > TOLERANCE) moved = true
      }
      if (!moved) continue
      count += 1
      box = [Math.min(box[0], x), Math.min(box[1], y), Math.max(box[2], x), Math.max(box[3], y)]
    }
  }
  return count ? `${count} pixels in ${box.join(',')}` : undefined
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [before, after] = process.argv.slice(2).map(path => resolve(path))
  if (!before || !after || !existsSync(before) || !existsSync(after)) {
    console.error('Usage: node scripts/visual/compare.mjs <before folder> <after folder>')
    process.exit(2)
  }
  const names = [...new Set([...readdirSync(before), ...readdirSync(after)])].filter(name => name.endsWith('.png')).sort()
  let differing = 0
  for (const name of names) {
    const result = existsSync(join(before, name)) && existsSync(join(after, name)) ? compare(before, after, name) : 'missing on one side'
    if (result) {
      differing += 1
      console.log(`${name}: ${result}`)
    }
  }
  console.log(`${names.length} screens, ${differing} differ`)
  process.exit(differing ? 1 : 0)
}
