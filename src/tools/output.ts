// Output handling for run_experiment and the hooks: tail truncation as pi's
// `truncateTail`, a rolling tail buffer, and byte-bounded cuts. Pure: no `$`.

/** What run_experiment shows the model (upstream EXPERIMENT_MAX_*). */
export const EXPERIMENT_MAX_LINES = 10
export const EXPERIMENT_MAX_BYTES = 4 * 1024

/** pi's DEFAULT_MAX_*: the wider window kept for parsing and display. */
export const DEFAULT_MAX_LINES = 2000
export const DEFAULT_MAX_BYTES = 50 * 1024

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function byteLength(text: string): number {
  return encoder.encode(text).length
}

/** pi's `formatSize`: "512B", "4.0KB", "1.2MB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`
}

export type TailTruncation = {
  content: string
  truncated: boolean
  truncatedBy: 'lines' | 'bytes' | null
  totalLines: number
  outputLines: number
}

/** The last `maxBytes` bytes of `text`, never splitting a character. */
function lastBytes(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text)
  if (bytes.length <= maxBytes) return text
  let start = bytes.length - maxBytes
  // Skip continuation bytes (10xxxxxx) so the cut lands on a character start.
  while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++
  return decoder.decode(bytes.subarray(start))
}

/**
 * Keep the last `maxLines` lines within `maxBytes` (pi's `truncateTail`):
 * whole lines only, except a last line longer than the byte limit.
 */
export function truncateTail(content: string, maxLines: number, maxBytes: number): TailTruncation {
  const lines = content.split('\n')
  const totalLines = lines.length
  if (totalLines <= maxLines && byteLength(content) <= maxBytes) {
    return { content, truncated: false, truncatedBy: null, totalLines, outputLines: totalLines }
  }

  const kept: string[] = []
  let keptBytes = 0
  let truncatedBy: 'lines' | 'bytes' = 'lines'
  for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
    const line = lines[i]!
    const lineBytes = byteLength(line) + (kept.length > 0 ? 1 : 0)
    if (keptBytes + lineBytes > maxBytes) {
      truncatedBy = 'bytes'
      if (kept.length === 0) {
        const partial = lastBytes(line, maxBytes)
        kept.unshift(partial)
        keptBytes = byteLength(partial)
      }
      break
    }
    kept.unshift(line)
    keptBytes += lineBytes
  }
  if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = 'lines'
  return { content: kept.join('\n'), truncated: true, truncatedBy, totalLines, outputLines: kept.length }
}

/**
 * The tail of a growing output, bounded to about `maxBytes` (upstream keeps
 * twice pi's byte limit): old text is dropped from the front, then the front
 * is trimmed to the next line start so no partial line leads.
 */
export class RollingTail {
  private text = ''
  private bytes = 0
  totalBytes = 0

  constructor(private readonly maxBytes: number) {}

  push(chunk: string): void {
    const chunkBytes = byteLength(chunk)
    this.totalBytes += chunkBytes
    this.text += chunk
    this.bytes += chunkBytes
    if (this.bytes <= this.maxBytes) return
    let kept = lastBytes(this.text, this.maxBytes)
    const newline = kept.indexOf('\n')
    if (newline !== -1 && newline < kept.length - 1) kept = kept.slice(newline + 1)
    this.text = kept
    this.bytes = byteLength(kept)
  }

  toString(): string {
    return this.text
  }
}

const NEWLINE = 0x0a

/**
 * Cut `text` to at most `maxBytes` bytes at the last newline, else at the
 * last whole character (upstream hooks.ts `truncateAtBoundary`).
 */
export function cutAtBoundary(text: string, maxBytes: number): string {
  const bytes = encoder.encode(text).subarray(0, maxBytes)
  const newlineEnd = bytes.lastIndexOf(NEWLINE)
  if (newlineEnd >= 0) return decoder.decode(bytes.subarray(0, newlineEnd + 1))
  let end = bytes.length
  while (end > 0 && (bytes[end - 1]! & 0xc0) === 0x80) end--
  if (end > 0 && (bytes[end - 1]! & 0xc0) === 0xc0) end--
  return decoder.decode(bytes.subarray(0, end))
}
