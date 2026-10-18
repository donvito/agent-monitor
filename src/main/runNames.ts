import { promises as fs } from 'node:fs';
import path from 'node:path';

/** Longest name kept for a run. */
const MAX_NAME_LENGTH = 200;

/**
 * User-given run names, kept in the app's own JSON file (run id → name).
 * Agent files are never written; writes replace the file atomically.
 */
export class RunNameStore {
  private names?: Record<string, string>;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly file: string) {}

  async all(): Promise<Record<string, string>> {
    return { ...(await this.load()) };
  }

  /** Sets a run's name; a blank name removes it. Resolves to every name after the change. */
  set(runId: string, name: string): Promise<Record<string, string>> {
    const write = this.queue.then(async () => {
      const names = { ...(await this.load()) };
      const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
      if (trimmed) names[runId] = trimmed;
      else delete names[runId];
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(temporary, `${JSON.stringify(names, null, 2)}\n`, 'utf8');
      await fs.rename(temporary, this.file);
      this.names = names;
      return { ...names };
    });
    this.queue = write.catch(() => undefined);
    return write;
  }

  private async load(): Promise<Record<string, string>> {
    if (this.names) return this.names;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await fs.readFile(this.file, 'utf8'));
    } catch {
      parsed = {};
    }
    const names: Record<string, string> = {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      for (const [runId, name] of Object.entries(parsed)) if (typeof name === 'string' && name.trim()) names[runId] = name;
    }
    this.names = names;
    return names;
  }
}
