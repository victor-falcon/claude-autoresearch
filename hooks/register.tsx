// Composition root: one register* call per feature module, nothing else.
// Each feature lives in its own folder under src/; shared glue in src/runtime.

import type { Register } from 'claude-code'

import { registerCommand } from '../src/command/index.ts'
import { registerExport } from '../src/export/index.ts'
import { registerLoop } from '../src/loop/index.ts'
import { startRuntime } from '../src/runtime/index.ts'
import { registerTools, startTools } from '../src/tools/index.ts'
import { registerUi, startUi } from '../src/ui/index.ts'

export const register: Register = on => {
  // A module may hook session.start only once without a matcher, so it lives
  // here: the runtime loads the state first, then each feature's start work.
  on('session.start', async ($, e, next) => {
    await startRuntime($)
    await startTools($)
    await startUi($)
    return next(e)
  })

  registerTools(on)
  registerCommand(on)
  registerLoop(on)
  registerUi(on)
  registerExport(on)
}
