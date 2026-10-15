import type { On } from 'claude-code'

/**
 * Mode activation (`shouldAutoActivateAutoresearch` + `decisions`, which also
 * sets `enabled`), auto-resume (`autoResume`), compaction rehydration and the
 * system-prompt section.
 *
 * No-op stub wired into hooks/register.tsx; implemented in T4.
 */
export function registerLoop(_on: On): void {}
