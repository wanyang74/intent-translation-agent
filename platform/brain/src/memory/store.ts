// Where session memories (condense.ts) are kept between a session being forgotten and its ID coming back. The brain
// saves a memory at the end of every turn, so a restart loses at most the turn that was running, and loads one when a
// turn arrives for a session it doesn't hold.
//   FileMemoryStore      one JSON file per session in a folder (sites/<site>/session_log/ when run locally), deleted
//                        after keepHours without activity; git-ignored, since memories hold what users typed
//   InMemoryMemoryStore  the same rules in a Map, for tests and for runs that shouldn't touch the disk
// Rules: a memory that is too old, for another site, or unreadable is treated as absent, never as an error. The file
// store never stops serving: a failed read or write is reported once and the brain goes on without memory.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { MEMORY_VERSION, type SessionMemory } from './condense.ts';

export interface MemoryStore {
  save(memory: SessionMemory): void;
  /** The session's memory if there is one, for this site, written within keepHours; null otherwise. */
  load(sessionId: string, now: number): SessionMemory | null;
}

const HOUR_MS = 60 * 60 * 1000;

/** Whether a memory can be used: the right version, session and site, and recent enough. */
function usable(memory: SessionMemory | null, sessionId: string, site: string, keepHours: number, now: number): memory is SessionMemory {
  return !!memory && memory.version === MEMORY_VERSION && memory.sessionId === sessionId && memory.site === site && now - memory.lastSeen <= keepHours * HOUR_MS;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly memories = new Map<string, SessionMemory>();
  private readonly site: string;
  private readonly keepHours: number;

  constructor(options: { site: string; keepHours: number }) {
    this.site = options.site;
    this.keepHours = options.keepHours;
  }

  save(memory: SessionMemory): void {
    this.memories.set(memory.sessionId, structuredClone(memory));
  }

  load(sessionId: string, now: number): SessionMemory | null {
    const memory = this.memories.get(sessionId) ?? null;
    if (!usable(memory, sessionId, this.site, this.keepHours, now)) {
      this.memories.delete(sessionId);
      return null;
    }
    return structuredClone(memory);
  }
}

/** A session ID as a file name: the client makes it up, so anything outside a safe set is replaced. */
export function memoryFileName(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100)}.json`;
}

export class FileMemoryStore implements MemoryStore {
  readonly dir: string;
  private readonly site: string;
  private readonly keepHours: number;
  private readonly now: () => number;
  private lastPrune = 0;
  private failed = false;

  constructor(options: { dir: string; site: string; keepHours: number; now?: () => number }) {
    this.dir = options.dir;
    this.site = options.site;
    this.keepHours = options.keepHours;
    this.now = options.now ?? Date.now;
    this.prune();
  }

  save(memory: SessionMemory): void {
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(path.join(this.dir, memoryFileName(memory.sessionId)), JSON.stringify(memory));
      // Pruning lists the folder, so at most once an hour.
      if (this.now() - this.lastPrune > HOUR_MS) this.prune();
    } catch (error) {
      this.report(error);
    }
  }

  load(sessionId: string, now: number): SessionMemory | null {
    try {
      return this.read(path.join(this.dir, memoryFileName(sessionId)), sessionId, now);
    } catch (error) {
      this.report(error);
      return null;
    }
  }

  /** Deletes memories past keepHours (or unreadable), so nothing personal lingers. */
  prune(): void {
    this.lastPrune = this.now();
    try {
      if (!existsSync(this.dir)) return;
      for (const name of readdirSync(this.dir).filter((candidate) => candidate.endsWith('.json'))) {
        const file = path.join(this.dir, name);
        const stored = this.parse(file);
        if (stored) this.read(file, stored.sessionId, this.now());
        else rmSync(file, { force: true });
      }
    } catch (error) {
      this.report(error);
    }
  }

  /** A memory file if it's usable; otherwise the file is deleted and the answer is null. */
  private read(file: string, sessionId: string, now: number): SessionMemory | null {
    if (!existsSync(file)) return null;
    const memory = this.parse(file);
    if (usable(memory, sessionId, this.site, this.keepHours, now)) return memory;
    rmSync(file, { force: true });
    return null;
  }

  private parse(file: string): SessionMemory | null {
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as SessionMemory;
    } catch {
      return null;
    }
  }

  /** Reports the first failure only: a broken folder stays broken, and one line says so. */
  private report(error: unknown): void {
    if (!this.failed) console.error(`session memory: can't use ${this.dir} (${String(error)}); serving goes on without it`);
    this.failed = true;
  }
}
