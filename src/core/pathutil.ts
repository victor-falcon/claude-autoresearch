/**
 * Minimal POSIX path helpers. The mod runs without Node, so `node:path` is not
 * available; these cover what session-file resolution needs.
 */

export const SEP = "/";

export function isAbsolute(p: string): boolean {
  return p.startsWith(SEP);
}

/** Collapse `.`, `..` and repeated separators. Keeps a leading `/`. */
export function normalize(p: string): string {
  const absolute = isAbsolute(p);
  const out: string[] = [];
  for (const part of p.split(SEP)) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(part);
  }
  const joined = out.join(SEP);
  if (absolute) return SEP + joined;
  return joined || ".";
}

export function join(...parts: string[]): string {
  return normalize(parts.filter((part) => part !== "").join(SEP));
}

/** Resolve `target` against `base` (`target` wins when absolute). */
export function resolve(base: string, target: string): string {
  return isAbsolute(target) ? normalize(target) : join(base, target);
}

export function dirname(p: string): string {
  const normalized = normalize(p);
  const index = normalized.lastIndexOf(SEP);
  if (index < 0) return ".";
  if (index === 0) return SEP;
  return normalized.slice(0, index);
}

/** Relative path from `from` to `to`; both absolute. */
export function relative(from: string, to: string): string {
  const fromParts = normalize(from).split(SEP).filter(Boolean);
  const toParts = normalize(to).split(SEP).filter(Boolean);
  let common = 0;
  while (common < fromParts.length && common < toParts.length && fromParts[common] === toParts[common]) {
    common++;
  }
  const up = fromParts.slice(common).map(() => "..");
  return [...up, ...toParts.slice(common)].join(SEP);
}
