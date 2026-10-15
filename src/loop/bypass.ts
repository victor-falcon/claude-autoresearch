// Where an organization manages Claude Code, the engine passes over a user
// plugin's `prompt.compose` and `session.compact` hooks (the debug log says
// "bypassed by cc-plugin-sec-default"). These flags record whether ours ran
// this process, so the loop can fall back to what still reaches it: context
// on `prompt.submit`, the `/compact` command, and the transcript shrinking.

let composeHookRan = false
let compactHookRan = false

export function markComposeHook(): void {
  composeHookRan = true
}

/** Whether the system-prompt section is known to be in the prompt. */
export function hasComposeHook(): boolean {
  return composeHookRan
}

export function markCompactHook(): void {
  compactHookRan = true
}

/** Whether a compaction is seen by the `session.compact` hook. */
export function hasCompactHook(): boolean {
  return compactHookRan
}
