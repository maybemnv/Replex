import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, lstat, realpath, rename, unlink } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { canonicalJson } from "../canonical-json.js";
import {
  applyOperationBatch,
  OperationLogRecordSchema,
  semanticHashV2,
  type OperationBatchInput,
  type OperationBatchResult,
  type OperationLogRecord,
} from "../operations-v2.js";
import { IdSchema } from "../schema.js";
import { ProjectV2Schema, type ProjectV2 } from "../schema-v2.js";

export type LocalProjectStoreErrorCode =
  | "PROJECT_NOT_FOUND"
  | "REVISION_NOT_FOUND"
  | "INVALID_OPERATION"
  | "IDEMPOTENCY_CONFLICT"
  | "STORAGE_FAILED";

export class LocalProjectStoreError extends Error {
  constructor(readonly code: LocalProjectStoreErrorCode, message: string) {
    super(message);
    this.name = "LocalProjectStoreError";
  }
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");
const MAX_PROJECT_BYTES = 128 * 1024 * 1024;
const OPERATION_LOG_RELATIVE_PATH = "operations/operations.jsonl";

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path));
}

function invalidStorage(): LocalProjectStoreError {
  return new LocalProjectStoreError("STORAGE_FAILED", "local project storage is invalid or unavailable");
}

export class LocalProjectStore {
  private rootPromise?: Promise<string>;
  private static readonly projectTails = new Map<string, Promise<void>>();

  constructor(private readonly workspaceRoot: string) {}

  async create(projectInput: ProjectV2, createFingerprint: string, displayName: string): Promise<ProjectV2> {
    const project = ProjectV2Schema.parse(projectInput);
    this.assertProjectIntegrity(project);
    return this.withProjectLock(project.projectId, async () => {
      const root = await this.root();
      const directory = await this.projectDirectory(root, project.projectId, true);
      const metadataPath = join(directory, "metadata.json");
      const existingMetadata = await this.readJsonIfExists<{ projectId: string; createFingerprint: string; displayName: string }>(metadataPath, root);
      if (existingMetadata && (existingMetadata.projectId !== project.projectId || existingMetadata.createFingerprint !== createFingerprint)) {
        throw new LocalProjectStoreError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different request");
      }

      const current = await this.readJsonIfExists<unknown>(join(directory, "project.json"), root);
      if (current !== undefined) {
        if (!existingMetadata) throw invalidStorage();
        const parsed = ProjectV2Schema.safeParse(current);
        if (!parsed.success || parsed.data.projectId !== project.projectId) throw invalidStorage();
        this.assertProjectIntegrity(parsed.data);
        await this.assertOperationLog(parsed.data);
        return parsed.data;
      }

      if (!existingMetadata) {
        await this.writeJsonAtomic(metadataPath, { projectId: project.projectId, createFingerprint, displayName }, root);
      }
      await this.ensureDirectory(directory, "revisions", root);
      await this.ensureDirectory(directory, "operations", root);
      await this.ensureDirectory(directory, "assets", root);
      await this.ensureDirectory(directory, "evidence", root);
      await this.ensureDirectory(directory, "renders", root);
      await this.writeJsonAtomic(this.revisionPath(directory, project.currentRevisionId), project, root);
      await this.writeTextAtomic(join(directory, OPERATION_LOG_RELATIVE_PATH), "", root);
      await this.writeJsonAtomic(join(directory, "project.json"), project, root);
      return project;
    });
  }
  async current(projectId: string): Promise<ProjectV2> {
    const root = await this.root();
    const directory = await this.projectDirectory(root, projectId, false);
    const value = await this.readJsonIfExists<unknown>(join(directory, "project.json"), root);
    if (value === undefined) throw new LocalProjectStoreError("PROJECT_NOT_FOUND", "project does not exist");
    const parsed = ProjectV2Schema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId) throw invalidStorage();
    this.assertProjectIntegrity(parsed.data);
    await this.assertOperationLog(parsed.data);
    return parsed.data;
  }

  async revision(projectId: string, revisionId: string): Promise<ProjectV2> {
    if (!IdSchema.safeParse(revisionId).success) throw new LocalProjectStoreError("REVISION_NOT_FOUND", "revision does not exist");
    const current = await this.current(projectId);
    return this.revisionFromCurrent(current, revisionId);
  }

  async currentAndRevision(projectId: string, revisionId: string): Promise<{ current: ProjectV2; selected: ProjectV2 }> {
    if (!IdSchema.safeParse(revisionId).success) throw new LocalProjectStoreError("REVISION_NOT_FOUND", "revision does not exist");
    const current = await this.current(projectId);
    const selected = revisionId === current.currentRevisionId ? current : await this.revisionFromCurrent(current, revisionId);
    return { current, selected };
  }

  private async revisionFromCurrent(current: ProjectV2, revisionId: string): Promise<ProjectV2> {
    const projectId = current.projectId;
    if (!current.revisions.some((revision) => revision.id === revisionId)) throw new LocalProjectStoreError("REVISION_NOT_FOUND", "revision does not exist");
    const root = await this.root();
    const directory = await this.projectDirectory(root, projectId, false);
    const value = await this.readJsonIfExists<unknown>(this.revisionPath(directory, revisionId), root);
    if (value === undefined) throw new LocalProjectStoreError("REVISION_NOT_FOUND", "revision does not exist");
    const parsed = ProjectV2Schema.safeParse(value);
    if (!parsed.success || parsed.data.projectId !== projectId || parsed.data.currentRevisionId !== revisionId) throw invalidStorage();
    this.assertProjectIntegrity(parsed.data);
    return parsed.data;
  }

  async operationLog(projectId: string): Promise<OperationLogRecord[]> {
    const root = await this.root();
    const directory = await this.projectDirectory(root, projectId, false);
    const path = join(directory, OPERATION_LOG_RELATIVE_PATH);
    const text = await this.readTextIfExists(path, root);
    if (text === undefined || text === "") return [];
    try {
      return text.split(/\r?\n/).filter(Boolean).map((line) => OperationLogRecordSchema.parse(JSON.parse(line)));
    } catch {
      throw invalidStorage();
    }
  }

  async applyBatch(projectId: string, batch: OperationBatchInput): Promise<OperationBatchResult> {
    return this.withProjectLock(projectId, async () => {
      const current = await this.current(projectId);
      const log = await this.operationLog(projectId);
      const committedRevisions = new Set(current.revisions.map((revision) => revision.id));
      const committedLog = log.filter((record) => committedRevisions.has(record.resultRevisionId));
      const prior = committedLog.filter((record) => record.intentId === batch.intentId);
      if (prior.length > 0) {
        const inputs = Array.isArray(batch.operations) ? batch.operations : [];
        const sameRequest = prior.length === inputs.length
          && prior.every((record, index) =>
            record.baseRevisionId === batch.baseRevisionId
            && record.actor === batch.actor
            && canonicalJson(record.input) === canonicalJson(inputs[index]));
        if (!sameRequest) throw new LocalProjectStoreError("IDEMPOTENCY_CONFLICT", "idempotency key was already used for a different operation batch");
        const revisionId = prior[0]!.resultRevisionId;
        return { ok: true, project: current, revisionId, operationLog: prior };
      }

      const result = applyOperationBatch(current, batch);
      if (!result.ok) return result;
      const root = await this.root();
      const directory = await this.projectDirectory(root, projectId, false);

      await this.writeJsonAtomic(this.revisionPath(directory, result.revisionId), result.project, root);
      const byId = new Map(committedLog.map((record) => [record.id, record]));
      for (const record of result.operationLog) {
        const existing = byId.get(record.id);
        if (existing && canonicalJson(existing) !== canonicalJson(record)) throw invalidStorage();
        byId.set(record.id, record);
      }
      const nextLog = [...byId.values()];
      await this.writeTextAtomic(join(directory, OPERATION_LOG_RELATIVE_PATH), nextLog.map(canonicalJson).join("\n") + "\n", root);
      // This rename publishes the new canonical revision. Earlier failures leave project.json unchanged.
      await this.writeJsonAtomic(join(directory, "project.json"), result.project, root);
      return result;
    });
  }

  private assertProjectIntegrity(project: ProjectV2): void {
    if (project.operationLogRef !== OPERATION_LOG_RELATIVE_PATH) throw invalidStorage();
    const current = project.revisions.find((revision) => revision.id === project.currentRevisionId);
    if (!current || current.manifestSha256 !== semanticHashV2(project)) throw invalidStorage();
  }

  private async assertOperationLog(project: ProjectV2): Promise<void> {
    const root = await this.root();
    const directory = await this.projectDirectory(root, project.projectId, false);
    const log = await this.operationLog(project.projectId);
    const revisions = new Map(project.revisions.map((revision) => [revision.id, revision]));
    const snapshots = new Map<string, ProjectV2>();
    const recordsByRevision = new Map<string, OperationLogRecord[]>();
    for (const record of log) {
      const records = recordsByRevision.get(record.resultRevisionId) ?? [];
      records.push(record);
      recordsByRevision.set(record.resultRevisionId, records);
    }
    const readSnapshot = async (revisionId: string): Promise<ProjectV2> => {
      const cached = snapshots.get(revisionId);
      if (cached) return cached;
      const value = await this.readJsonIfExists<unknown>(this.revisionPath(directory, revisionId), root);
      const parsed = ProjectV2Schema.safeParse(value);
      if (!parsed.success || parsed.data.projectId !== project.projectId || parsed.data.currentRevisionId !== revisionId) throw invalidStorage();
      this.assertProjectIntegrity(parsed.data);
      snapshots.set(revisionId, parsed.data);
      return parsed.data;
    };

    const seen = new Set<string>();
    for (const revision of project.revisions) {
      if (revision.parentId && !seen.has(revision.parentId)) throw invalidStorage();
      const child = await readSnapshot(revision.id);
      const records = recordsByRevision.get(revision.id) ?? [];
      if (records.length !== revision.operationIds.length
        || records.some((record, index) => record.id !== revision.operationIds[index]
          || record.baseRevisionId !== revision.parentId
          || record.actor !== revision.actor)) throw invalidStorage();

      if (!revision.parentId) {
        if (seen.size !== 0 || records.length !== 0) throw invalidStorage();
        seen.add(revision.id);
        continue;
      }
      if (records.length === 0) throw invalidStorage();
      const first = records[0]!;
      if (records.some((record) => record.intentId !== first.intentId
        || record.createdAt !== first.createdAt
        || canonicalJson(record.evidenceRefs) !== canonicalJson(first.evidenceRefs))) throw invalidStorage();

      const parent = await readSnapshot(revision.parentId);
      const replay = applyOperationBatch(parent, {
        baseRevisionId: revision.parentId,
        actor: first.actor,
        intentId: first.intentId,
        evidenceRefs: first.evidenceRefs,
        operations: records.map((record) => record.input),
        createdAt: first.createdAt,
      });
      if (!replay.ok || replay.revisionId !== revision.id
        || replay.operationLog.some((record, index) => canonicalJson(record) !== canonicalJson(records[index]))
        || semanticHashV2(replay.project) !== semanticHashV2(child)) throw invalidStorage();
      seen.add(revision.id);
    }

    if (seen.size !== revisions.size || !seen.has(project.currentRevisionId)) throw invalidStorage();
  }
  private revisionPath(directory: string, revisionId: string): string {
    return join(directory, "revisions", sha256(revisionId) + ".json");
  }

  // ponytail: per-process locks are enough for one local daemon; add an OS lock if multiple daemons share this workspace.
  private async withProjectLock<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    if (!IdSchema.safeParse(projectId).success) throw new LocalProjectStoreError("PROJECT_NOT_FOUND", "project does not exist");
    const workspace = await this.root();
    const lockKey = (process.platform === "win32" ? workspace.toLowerCase() : workspace) + "|" + projectId;
    const previous = LocalProjectStore.projectTails.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const held = new Promise<void>((resolveHeld) => { release = resolveHeld; });
    const tail = previous.then(() => held);
    LocalProjectStore.projectTails.set(lockKey, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (LocalProjectStore.projectTails.get(lockKey) === tail) LocalProjectStore.projectTails.delete(lockKey);
    }
  }

  private async root(): Promise<string> {
    this.rootPromise ??= (async () => {
      const requested = resolve(this.workspaceRoot);
      await mkdir(requested, { recursive: true, mode: 0o700 });
      const info = await lstat(requested);
      if (info.isSymbolicLink() || !info.isDirectory()) throw invalidStorage();
      return await realpath(requested);
    })();
    return this.rootPromise;
  }

  private async projectDirectory(root: string, projectId: string, create: boolean): Promise<string> {
    if (!IdSchema.safeParse(projectId).success) throw new LocalProjectStoreError("PROJECT_NOT_FOUND", "project does not exist");
    const projectsRoot = await this.ensureDirectory(root, "projects", root, create);
    const directory = join(projectsRoot, sha256(projectId));
    if (!within(root, directory)) throw invalidStorage();
    if (create) return this.ensureExistingOrCreateDirectory(directory, root);
    try {
      const info = await lstat(directory);
      const real = await realpath(directory);
      if (info.isSymbolicLink() || !info.isDirectory() || !within(root, real)) throw invalidStorage();
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalProjectStoreError("PROJECT_NOT_FOUND", "project does not exist");
      throw error;
    }
  }

  private async ensureDirectory(parent: string, name: string, root: string, create = true): Promise<string> {
    const path = join(parent, name);
    if (!within(root, path)) throw invalidStorage();
    if (create) {
      try { await mkdir(path, { mode: 0o700 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalidStorage(); }
    }
    try {
      const info = await lstat(path);
      const real = await realpath(path);
      if (info.isSymbolicLink() || !info.isDirectory() || !within(root, real)) throw invalidStorage();
      return real;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new LocalProjectStoreError("PROJECT_NOT_FOUND", "project does not exist");
      throw error;
    }
  }

  private async ensureExistingOrCreateDirectory(path: string, root: string): Promise<string> {
    if (!within(root, path)) throw invalidStorage();
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw invalidStorage(); }
    const info = await lstat(path);
    const real = await realpath(path);
    if (info.isSymbolicLink() || !info.isDirectory() || !within(root, real)) throw invalidStorage();
    return real;
  }

  private async readJsonIfExists<T>(path: string, root: string): Promise<T | undefined> {
    const text = await this.readTextIfExists(path, root);
    if (text === undefined) return undefined;
    try { return JSON.parse(text) as T; }
    catch { throw invalidStorage(); }
  }

  private async readTextIfExists(path: string, root: string): Promise<string | undefined> {
    try {
      const info = await lstat(path);
      const real = await realpath(path);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1 || !within(root, real) || info.size > MAX_PROJECT_BYTES) throw invalidStorage();
      return await readFile(real, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeJsonAtomic(path: string, value: unknown, root: string): Promise<void> {
    await this.writeTextAtomic(path, canonicalJson(value) + "\n", root);
  }

  private async writeTextAtomic(path: string, text: string, root: string): Promise<void> {
    if (Buffer.byteLength(text, "utf8") > MAX_PROJECT_BYTES || !within(root, resolve(path))) throw invalidStorage();
    const directory = await realpath(join(path, ".."));
    if (!within(root, directory)) throw invalidStorage();
    const tempPath = join(directory, ".tmp-" + randomUUID());
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(tempPath, "wx", 0o600);
      await handle.writeFile(text, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(tempPath, path);
    } catch {
      await handle?.close().catch(() => undefined);
      await unlink(tempPath).catch(() => undefined);
      throw invalidStorage();
    }
  }
}
