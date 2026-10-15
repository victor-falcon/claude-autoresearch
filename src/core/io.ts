/**
 * The file access the core needs, injected so the same logic runs on `$.fs`
 * inside the mod and on in-memory fakes in tests.
 *
 * Paths handed to it are absolute (POSIX separators).
 */
export interface FileIO {
  /** Whether anything exists at `path`. Never rejects for a missing path. */
  exists(path: string): Promise<boolean>;
  /** Whether `path` exists and is a directory. */
  isDirectory(path: string): Promise<boolean>;
  /** The file's UTF-8 text. Rejects when it is missing or unreadable. */
  readText(path: string): Promise<string>;
}

/** Read a file, answering "" when it is missing or unreadable. */
export async function readTextOrEmpty(io: FileIO, path: string): Promise<string> {
  try {
    if (!(await io.exists(path))) return "";
    return await io.readText(path);
  } catch {
    return "";
  }
}
