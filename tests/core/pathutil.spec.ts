import assert from "node:assert/strict";
import test from "node:test";
import * as path from "node:path";

import { dirname, join, normalize, relative, resolve } from "../../src/core/pathutil.ts";

const cases = ["/a/b/../c", "/a//b/./c/", "a/../../b", "/..", "./x", "", "/"];

test("normalize, join, dirname, resolve and relative agree with node:path (posix)", () => {
  for (const p of cases) {
    if (p === "") continue;
    assert.equal(normalize(p), path.posix.normalize(p).replace(/(.)\/$/, "$1"), p);
    assert.equal(dirname(p), path.posix.dirname(path.posix.normalize(p)), p);
  }
  assert.equal(join("/w", ".auto", "log.jsonl"), path.posix.join("/w", ".auto", "log.jsonl"));
  assert.equal(join("/w", "../x"), "/x");
  assert.equal(resolve("/w", "sub/../bench"), path.posix.resolve("/w", "sub/../bench"));
  assert.equal(resolve("/w", "/abs"), "/abs");
  for (const [from, to] of [["/w", "/w/.auto/log.jsonl"], ["/w/a", "/w/b/c"], ["/w", "/w"], ["/w/x", "/elsewhere"]] as const) {
    assert.equal(relative(from, to), path.posix.relative(from, to), `${from} -> ${to}`);
  }
});
