import type { FileIO } from "../../src/core/io.ts";
import { dirname } from "../../src/core/pathutil.ts";

/** An in-memory FileIO: files by absolute path; folders implied by them. */
export class FakeIO implements FileIO {
  readonly files = new Map<string, string>();
  readonly dirs = new Set<string>();

  constructor(files: Record<string, string> = {}) {
    for (const [path, text] of Object.entries(files)) this.write(path, text);
  }

  write(path: string, text: string): void {
    this.files.set(path, text);
    this.mkdir(dirname(path));
  }

  mkdir(path: string): void {
    for (let dir = path; !this.dirs.has(dir); dir = dirname(dir)) {
      this.dirs.add(dir);
      if (dir === "/" || dir === ".") break;
    }
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path);
  }

  async isDirectory(path: string): Promise<boolean> {
    return this.dirs.has(path);
  }

  async readText(path: string): Promise<string> {
    const text = this.files.get(path);
    if (text === undefined) throw new Error(`ENOENT: ${path}`);
    return text;
  }
}
