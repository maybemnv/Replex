import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { LocalProjectStore } from "./project-store.js";

const MAX_ENTRIES = 10_000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const directStage = /^(?:import-[a-zA-Z0-9]{6}|[a-f0-9]{16}-[a-zA-Z0-9]{6})$/;
const motionStage = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export interface StagingCleanupReport { removedDirectories: number; skippedDirectories: number; unavailableProjects: number }

function contained(root: string, path: string): boolean {
  const relation = relative(root, path);
  return !relation || (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

/** Host startup only: caller must own the workspace lease and must not have resumed workers yet. */
export async function cleanupAbandonedStaging(workspaceRoot: string, now = Date.now()): Promise<StagingCleanupReport> {
  const requested = resolve(workspaceRoot);
  const rootInfo = await lstat(requested);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("invalid cleanup workspace");
  const root = await realpath(requested);
  const store = new LocalProjectStore(root);
  const catalog = await store.listProjects();
  const report = { removedDirectories: 0, skippedDirectories: 0, unavailableProjects: catalog.unavailableCount };
  let remaining = MAX_ENTRIES;
  const cutoff = now - STALE_AFTER_MS;

  const directory = async (path: string) => {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !contained(root, await realpath(path))) throw new Error("unsafe staging directory");
    return info;
  };
  const staleTree = async (path: string): Promise<boolean> => {
    if (--remaining < 0) return false;
    const info = await lstat(path);
    if (info.isSymbolicLink() || info.mtimeMs > cutoff) return false;
    if (info.isFile()) return info.nlink === 1;
    if (!info.isDirectory()) return false;
    for (const entry of await readdir(path)) if (!await staleTree(join(path, entry))) return false;
    return true;
  };
  const prune = async (parent: string, pattern: RegExp) => {
    try { await directory(parent); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.skippedDirectories++;
      return;
    }
    for (const entry of await readdir(parent)) {
      if (remaining <= 0) { report.skippedDirectories++; return; }
      if (!pattern.test(entry)) { report.skippedDirectories++; continue; }
      const path = join(parent, entry);
      try {
        const before = await directory(path);
        if (!await staleTree(path)) { report.skippedDirectories++; continue; }
        await directory(parent);
        const current = await directory(path);
        if (current.dev !== before.dev || current.ino !== before.ino) throw new Error("staging directory changed");
        await rm(path, { recursive: true });
        report.removedDirectories++;
      } catch { report.skippedDirectories++; }
    }
  };

  for (const project of catalog.projects) {
    if (remaining <= 0) break;
    const projectRoot = await store.projectRoot(project.projectId);
    const staging = join(projectRoot, ".replex-staging");
    try { await directory(staging); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.skippedDirectories++;
      continue;
    }
    await prune(staging, directStage);
    const motion = join(staging, "motion");
    try { await directory(motion); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") report.skippedDirectories++;
      continue;
    }
    await prune(join(motion, "jobs"), motionStage);
  }
  return report;
}
