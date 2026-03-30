import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { StateFileSchema, type SessionState } from "./schema.js";

/**
 * Persists active session records to a JSON file on disk.
 *
 * Each session is identified by label. Operations are read-modify-write
 * on the single file — fine for single-user, handful-of-sessions scale.
 */
export class SessionStore {
  constructor(private readonly stateFile: string) {}

  save(session: SessionState): void {
    const sessions = this.load().filter((s) => s.label !== session.label);
    sessions.push(session);
    this.persist(sessions);
  }

  get(label: string): SessionState | undefined {
    return this.load().find((s) => s.label === label);
  }

  remove(label: string): void {
    this.persist(this.load().filter((s) => s.label !== label));
  }

  list(): SessionState[] {
    return this.load();
  }

  private load(): SessionState[] {
    if (!existsSync(this.stateFile)) return [];
    const raw = JSON.parse(readFileSync(this.stateFile, "utf-8"));
    return StateFileSchema.parse(raw).sessions;
  }

  private persist(sessions: SessionState[]): void {
    const tmp = join(dirname(this.stateFile), `.state.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
    renameSync(tmp, this.stateFile);
  }
}
