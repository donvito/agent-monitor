import { createReadStream, promises as fs } from 'node:fs';
import { createInterface } from 'node:readline';

/** Bytes read from the end of a Claude session first; titles are appended as the session goes on. */
const TAIL_BYTES = 256 * 1024;

function lastAiTitle(text: string): string | undefined {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].includes('"ai-title"')) continue;
    try {
      const value = JSON.parse(lines[index]) as { type?: unknown; aiTitle?: unknown };
      if (value.type === 'ai-title' && typeof value.aiTitle === 'string' && value.aiTitle.trim()) return value.aiTitle.trim();
    } catch {
      // The first line of the tail can be cut; earlier lines are checked by the full read.
    }
  }
  return undefined;
}

/** The latest title Claude Code gave a session (`ai-title` records), read from the end of its file. */
export async function claudeTitle(file: string): Promise<string | undefined> {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const title = lastAiTitle(buffer.toString('utf8'));
    if (title !== undefined || start === 0) return title;
  } finally {
    await handle.close();
  }
  return lastAiTitle(await fs.readFile(file, 'utf8'));
}

/** Codex thread names from `session_index.jsonl` (thread id → name); later entries win. */
export async function codexThreadNames(indexFile: string): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  let text: string;
  try {
    text = await fs.readFile(indexFile, 'utf8');
  } catch {
    return names;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as { id?: unknown; thread_name?: unknown };
      if (typeof value.id === 'string' && typeof value.thread_name === 'string' && value.thread_name.trim()) names.set(value.id, value.thread_name.trim());
    } catch {
      // Skip a damaged line and keep the rest of the index.
    }
  }
  return names;
}

/**
 * The name the user gave a Claude Code session (`/rename` or `claude --name`), stored as `custom-title` records.
 * It can be anywhere in the file, so the whole file is streamed; the latest record wins.
 */
export async function claudeCustomTitle(file: string): Promise<string | undefined> {
  let title: string | undefined;
  const lines = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes('"custom-title"')) continue;
    try {
      const value = JSON.parse(line) as { type?: unknown; customTitle?: unknown };
      if (value.type === 'custom-title' && typeof value.customTitle === 'string') title = value.customTitle.trim() || undefined;
    } catch {
      // Skip a damaged line.
    }
  }
  return title;
}
