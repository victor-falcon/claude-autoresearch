import type { On } from 'claude-code'

/**
 * The widget above the prompt, the status line and the fullscreen dashboard
 * pane. View-only toggles (expanded, fullscreen) may stay module-local or be
 * added to the contract as new keys.
 *
 * No-op stub wired into hooks/register.tsx; implemented in T5.
 */
export function registerUi(_on: On): void {}
