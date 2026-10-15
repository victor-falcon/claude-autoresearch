// Composition root: one register* call per feature module, nothing else.
// Each feature lives in its own folder under src/; shared glue in src/runtime.

import type { Register } from 'claude-code'

import { registerCommand } from '../src/command/index.ts'
import { registerExport } from '../src/export/index.ts'
import { registerLoop } from '../src/loop/index.ts'
import { registerRuntime } from '../src/runtime/index.ts'
import { registerTools } from '../src/tools/index.ts'
import { registerUi } from '../src/ui/index.ts'

export const register: Register = on => {
  // First registered is outermost: the runtime loads state before the features.
  registerRuntime(on)
  registerTools(on)
  registerCommand(on)
  registerLoop(on)
  registerUi(on)
  registerExport(on)
}
