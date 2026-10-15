import assert from "node:assert/strict";
import test from "node:test";

import {
  AUTO_DIR,
  hookScriptCandidates,
  hookScriptPath,
  sessionFileCandidates,
  sessionFilePath,
} from "../../src/core/paths.ts";
import { FakeIO } from "./fake-io.ts";

// Ported from pi-autoresearch tests/paths.test.mjs

const dir = "/work";

test("a brand-new session resolves to the .auto layout", async () => {
  const io = new FakeIO();
  io.mkdir(dir);
  assert.equal(await sessionFilePath(io, dir, "log"), `${dir}/${AUTO_DIR}/log.jsonl`);
  assert.equal(await sessionFilePath(io, dir, "prompt"), `${dir}/${AUTO_DIR}/prompt.md`);
  assert.equal(await sessionFilePath(io, dir, "config"), `${dir}/${AUTO_DIR}/config.json`);
  assert.equal(await sessionFilePath(io, dir, "measure"), `${dir}/${AUTO_DIR}/measure.sh`);
});

test("an existing legacy file is read in place for backwards compatibility", async () => {
  const io = new FakeIO({ [`${dir}/autoresearch.jsonl`]: "{}\n" });
  assert.equal(await sessionFilePath(io, dir, "log"), `${dir}/autoresearch.jsonl`);
});

test("the .auto layout wins when both new and legacy files exist", async () => {
  const io = new FakeIO({
    [`${dir}/autoresearch.jsonl`]: "{}\n",
    [`${dir}/${AUTO_DIR}/log.jsonl`]: "{}\n",
  });
  assert.equal(await sessionFilePath(io, dir, "log"), `${dir}/${AUTO_DIR}/log.jsonl`);
});

test("current sessions do not inherit stale legacy peer files", async () => {
  const io = new FakeIO({
    [`${dir}/${AUTO_DIR}/log.jsonl`]: "{}\n",
    [`${dir}/autoresearch.config.json`]: '{"maxIterations":1}\n',
    [`${dir}/autoresearch.checks.sh`]: "#!/usr/bin/env bash\n",
  });

  assert.equal(await sessionFilePath(io, dir, "config"), `${dir}/${AUTO_DIR}/config.json`);
  assert.equal(await sessionFilePath(io, dir, "checks"), `${dir}/${AUTO_DIR}/checks.sh`);
});

test("legacy files are used only when no current layout exists", async () => {
  const io = new FakeIO({ [`${dir}/autoresearch.config.json`]: '{"maxIterations":1}\n' });
  assert.equal(await sessionFilePath(io, dir, "config"), `${dir}/autoresearch.config.json`);
});

test("session file candidates expose both paths for cleanup", () => {
  assert.deepEqual(sessionFileCandidates(dir, "log"), {
    current: `${dir}/${AUTO_DIR}/log.jsonl`,
    legacy: `${dir}/autoresearch.jsonl`,
  });
  assert.deepEqual(hookScriptCandidates(dir, "before"), {
    current: `${dir}/${AUTO_DIR}/hooks/before.sh`,
    legacy: `${dir}/autoresearch.hooks/before.sh`,
  });
});

test("hook scripts prefer .auto/hooks and fall back to the legacy directory", async () => {
  const io = new FakeIO();
  assert.equal(await hookScriptPath(io, dir, "before"), `${dir}/${AUTO_DIR}/hooks/before.sh`);

  io.write(`${dir}/autoresearch.hooks/after.sh`, "#!/usr/bin/env bash\n");
  assert.equal(await hookScriptPath(io, dir, "after"), `${dir}/autoresearch.hooks/after.sh`);
});

test("current sessions ignore stale legacy hooks", async () => {
  const io = new FakeIO({
    [`${dir}/${AUTO_DIR}/log.jsonl`]: "{}\n",
    [`${dir}/autoresearch.hooks/after.sh`]: "#!/usr/bin/env bash\n",
  });

  assert.equal(await hookScriptPath(io, dir, "after"), `${dir}/${AUTO_DIR}/hooks/after.sh`);
});

test("an .auto/hooks folder alone selects the current layout", async () => {
  const io = new FakeIO({ [`${dir}/autoresearch.md`]: "# rules\n" });
  io.mkdir(`${dir}/${AUTO_DIR}/hooks`);

  assert.equal(await sessionFilePath(io, dir, "prompt"), `${dir}/${AUTO_DIR}/prompt.md`);
});
