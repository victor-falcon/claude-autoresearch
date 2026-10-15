import assert from "node:assert/strict";
import test from "node:test";

import { INIT_EXPERIMENT_SCHEMA, LOG_EXPERIMENT_SCHEMA, RUN_EXPERIMENT_SCHEMA } from "../../src/core/schemas.ts";

// Ported from pi-autoresearch tests/log-params-schema.test.mjs

function collectKeyPaths(value: unknown, targetKey: string, path = "$", hits: string[] = []): string[] {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeyPaths(item, targetKey, `${path}[${index}]`, hits));
    return hits;
  }
  if (!value || typeof value !== "object") return hits;

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`;
    if (key === targetKey) hits.push(childPath);
    collectKeyPaths(child, targetKey, childPath, hits);
  }
  return hits;
}

test("log_experiment schema should avoid patternProperties for provider compatibility", () => {
  const patternPropertyPaths = collectKeyPaths(LOG_EXPERIMENT_SCHEMA, "patternProperties");

  assert.equal(
    patternPropertyPaths.length,
    0,
    `unexpected patternProperties found in log_experiment schema at: ${patternPropertyPaths.join(", ")}`,
  );
  assert.match(
    JSON.stringify(LOG_EXPERIMENT_SCHEMA),
    /"additionalProperties"/,
    "expected the schema to keep dynamic object support via additionalProperties",
  );
});

test("tool schemas require the same fields as upstream", () => {
  assert.deepEqual(INIT_EXPERIMENT_SCHEMA.required, ["name", "metric_name"]);
  assert.deepEqual(RUN_EXPERIMENT_SCHEMA.required, ["command"]);
  assert.deepEqual(LOG_EXPERIMENT_SCHEMA.required, ["commit", "metric", "status", "description"]);
  assert.deepEqual(LOG_EXPERIMENT_SCHEMA.properties.status.enum, ["keep", "discard", "crash", "checks_failed"]);
});
