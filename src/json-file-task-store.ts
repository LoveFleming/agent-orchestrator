/**
 * JsonFileTaskStore — File-based TaskStore for @a2a-js/sdk
 *
 * Implements the SDK's TaskStore interface with JSON file persistence.
 * Tasks are stored as individual JSON files in a directory.
 *
 * Additional methods beyond the SDK interface:
 *   list()           — list all tasks
 *   delete(taskId)   — delete a task
 *   findByContext()  — find latest task in a context
 *   appendEvent()    — append lifecycle event
 *   appendMemory()   — append memory fragment
 *   saveTokens()     — record token usage
 *   saveCheckpoint() — save checkpoint snapshot
 *   saveTrace()      — save trace entry
 */

import { readFile, writeFile, readdir, unlink, mkdir } from "fs/promises";
import { resolve } from "path";
import type { Task } from "@a2a-js/sdk";
import type { TaskStore as ITaskStore, ServerCallContext } from "@a2a-js/sdk/server";

export class JsonFileTaskStore implements ITaskStore {
  private dir: string;
  private maxCheckpoints: number;
  private maxEvents: number;
  private initialized = false;

  constructor(dir: string, opts?: { maxCheckpoints?: number; maxEvents?: number }) {
    this.dir = dir;
    this.maxCheckpoints = opts?.maxCheckpoints ?? 10;
    this.maxEvents = opts?.maxEvents ?? 500;
  }

  private async ensureDir() {
    if (!this.initialized) {
      await mkdir(this.dir, { recursive: true });
      this.initialized = true;
    }
  }

  private path(taskId: string): string {
    const safe = String(taskId).replace(/[^a-zA-Z0-9_-]/g, "");
    return resolve(this.dir, `${safe}.json`);
  }

  // ── SDK Interface ──

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    await this.ensureDir();
    const enriched = task as any;
    if (!enriched.createdAt) enriched.createdAt = new Date().toISOString();
    enriched.updatedAt = new Date().toISOString();
    await writeFile(this.path(task.id), JSON.stringify(enriched, null, 2), "utf-8");
  }

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    try {
      const raw = await readFile(this.path(taskId), "utf-8");
      return JSON.parse(raw) as Task;
    } catch {
      return undefined;
    }
  }

  // ── Extended Methods ──

  async list(filter?: { contextId?: string; state?: string }): Promise<Task[]> {
    await this.ensureDir();
    try {
      const files = await readdir(this.dir);
      const tasks: Task[] = [];
      for (const f of files.filter(f => f.endsWith(".json")).sort().reverse()) {
        try {
          tasks.push(JSON.parse(await readFile(resolve(this.dir, f), "utf-8")));
        } catch {}
      }
      if (filter?.contextId) return tasks.filter((t: any) => t.contextId === filter.contextId);
      if (filter?.state) return tasks.filter((t: any) => t.status?.state === filter.state);
      return tasks;
    } catch {
      return [];
    }
  }

  async delete(taskId: string): Promise<void> {
    try { await unlink(this.path(taskId)); } catch {}
  }

  async findByContext(contextId: string): Promise<Task | undefined> {
    const tasks = await this.list({ contextId });
    return tasks.length > 0 ? tasks[0] : undefined;
  }

  async appendEvent(taskId: string, event: Record<string, any>): Promise<void> {
    const task = await this.load(taskId) as any;
    if (!task) return;
    if (!task.events) task.events = [];
    task.events.push({ ...event, ts: event.ts || Date.now() });
    if (task.events.length > this.maxEvents) {
      task.events = task.events.slice(-this.maxEvents);
    }
    await this.save(task);
  }

  async appendMemory(taskId: string, memory: Record<string, any>): Promise<void> {
    const task = await this.load(taskId) as any;
    if (!task) return;
    if (!task.memory) task.memory = [];
    task.memory.push({ ...memory, ts: memory.ts || Date.now() });
    await this.save(task);
  }

  async saveTokens(taskId: string, usage: { prompt: number; completion: number; total: number }): Promise<void> {
    const task = await this.load(taskId) as any;
    if (!task) return;
    if (!task.tokenUsage) task.tokenUsage = { prompt: 0, completion: 0, total: 0 };
    task.tokenUsage.prompt += usage.prompt || 0;
    task.tokenUsage.completion += usage.completion || 0;
    task.tokenUsage.total += usage.total || 0;
    task.tokenUsage.lastUpdated = new Date().toISOString();
    await this.save(task);
  }

  async saveCheckpoint(taskId: string, data: any, label?: string): Promise<void> {
    const task = await this.load(taskId) as any;
    if (!task) return;
    if (!task.checkpoints) task.checkpoints = [];
    task.checkpoints.push({
      id: `cp_${Date.now()}`,
      label: label || `checkpoint-${task.checkpoints.length + 1}`,
      data: JSON.parse(JSON.stringify(data)),
      ts: new Date().toISOString(),
    });
    if (task.checkpoints.length > this.maxCheckpoints) {
      task.checkpoints = task.checkpoints.slice(-this.maxCheckpoints);
    }
    await this.save(task);
  }

  async saveTrace(taskId: string, trace: Record<string, any>): Promise<void> {
    const task = await this.load(taskId) as any;
    if (!task) return;
    if (!task.trace) task.trace = [];
    task.trace.push({ ...trace, ts: trace.ts || Date.now() });
    await this.save(task);
  }
}
