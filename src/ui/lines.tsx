// Turns the pure formatter's toned lines into Text rows of a surface.

import type { ElementConstructor, RenderElement, TextProps } from 'claude-code'

import type { Line, Tone } from './format.ts'

const TONES: Record<Tone, TextProps> = {
  text: {},
  muted: { dimColor: true },
  dim: { dimColor: true },
  accent: { color: 'suggestion' },
  title: { color: 'claude' },
  border: { color: 'subtle' },
  success: { color: 'success' },
  warning: { color: 'warning' },
  error: { color: 'error' },
}

export function toneProps(tone: Tone, bold?: boolean): TextProps {
  return bold ? { ...TONES[tone], bold: true } : TONES[tone]
}

/** One Text row of a line, never wrapped: the formatter already fits the width. */
export function lineText(Text: ElementConstructor<TextProps>, line: Line, key?: string): RenderElement {
  return (
    <Text key={key} wrap="truncate">
      {line.length === 0 ? ' ' : line.map((part, i) => <Text key={String(i)} {...toneProps(part.tone, part.bold)}>{part.text}</Text>)}
    </Text>
  )
}

export function lineRows(Text: ElementConstructor<TextProps>, lines: readonly Line[]): RenderElement[] {
  return lines.map((line, i) => lineText(Text, line, String(i)))
}
