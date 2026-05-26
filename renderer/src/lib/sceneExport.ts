import type { LogMessage } from './api'

export type ExportFormat = 'markdown' | 'text'

function pad(n: number, w = 2): string {
  return String(n).padStart(w, '0')
}

function formatTimestamp(ts: number): string {
  const d = new Date(ts * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Resolved scene-export tag for a message. Prefers the semantic label
// (`m.label`, set by the IC/OOC resolver) over the parser bucket
// (`m.kind`) so an export of an IC-filtered slice doesn't carry "(OOC)"
// on borderline lines that the resolver re-classified. Falls back to
// the parser bucket when there's no label (system rows, untyped ads).
function exportTag(m: LogMessage): string {
  if (m.label) return m.label === 'IC' ? '' : m.label.toUpperCase()
  return m.kind === 'ic' ? '' : m.kind.toUpperCase()
}

export function exportMessages(
  messages: LogMessage[],
  partner: string,
  character: string,
  format: ExportFormat
): string {
  if (messages.length === 0) return ''
  const start = formatTimestamp(messages[0].ts)
  const end = formatTimestamp(messages[messages.length - 1].ts)

  if (format === 'markdown') {
    const lines: string[] = []
    lines.push(`# ${partner} — ${character}`)
    lines.push(`*${start} → ${end} · ${messages.length.toLocaleString()} messages*`)
    lines.push('')
    let lastDay = ''
    for (const m of messages) {
      const day = formatTimestamp(m.ts).slice(0, 10)
      if (day !== lastDay) {
        lines.push(`## ${day}`)
        lines.push('')
        lastDay = day
      }
      const time = formatTimestamp(m.ts).slice(11, 19)
      const tag = exportTag(m)
      const suffix = tag ? ` *(${tag})*` : ''
      lines.push(`**${time} — ${m.speaker}${suffix}:** ${m.text}`)
      lines.push('')
    }
    return lines.join('\n')
  }

  // Plain text
  const lines: string[] = []
  lines.push(`${partner} — ${character}`)
  lines.push(`${start} → ${end}  (${messages.length.toLocaleString()} messages)`)
  lines.push('')
  let lastDay = ''
  for (const m of messages) {
    const day = formatTimestamp(m.ts).slice(0, 10)
    if (day !== lastDay) {
      lines.push(`--- ${day} ---`)
      lastDay = day
    }
    const time = formatTimestamp(m.ts).slice(11, 19)
    const tag = exportTag(m)
    const suffix = tag ? ` [${tag}]` : ''
    lines.push(`[${time}] ${m.speaker}${suffix}: ${m.text}`)
  }
  return lines.join('\n')
}
