import type {
  ApplyOperationsRequest,
  ImportAssetRequest,
  CancelJobRequest,
  CancelJobResponse,
  CapabilitySet,
  CreateProjectRequest,
  JobEvent,
  JobEventPage,
  JobView,
  OpenProjectRequest,
  ProjectCreatedResponse,
  ProjectSnapshot,
  ServiceCommand,
} from "../service-contract/index.js";
import { authorizeLocalImport, type AuthorizedLocalImport } from "../import-v2.js";
import {
  ApplyOperationsRequestSchema,
  ImportAssetRequestSchema,
  CancelJobRequestSchema,
  CreateProjectRequestSchema,
  OpenProjectRequestSchema,
} from "../service-contract/index.js";
import { LocalJobRuntime } from "./local-jobs.js";
import { LocalProjectService } from "./local.js";

export class LocalExecutor {
  private readonly projects: LocalProjectService;
  private readonly jobs: LocalJobRuntime;

  constructor(options: { workspaceRoot: string }) {
    this.projects = new LocalProjectService(options);
    this.jobs = new LocalJobRuntime(options.workspaceRoot, this.projects);
  }

  start(): Promise<void> {
    return this.jobs.start();
  }

  stop(): Promise<void> {
    return this.jobs.stop();
  }

  createProject(request: CreateProjectRequest): Promise<ProjectCreatedResponse> {
    return this.projects.createProject(request);
  }

  openProject(request: OpenProjectRequest): Promise<ProjectSnapshot> {
    return this.projects.openProject(request);
  }

  submitApplyOperations(request: ApplyOperationsRequest): Promise<JobView> {
    return this.jobs.submitApplyOperations(request);
  }

  async authorizeLocalImport(sourcePath: string, approvedRoots: string[], importMethod: "file_picker" | "path" = "file_picker"): Promise<AuthorizedLocalImport> {
    const source = await authorizeLocalImport(sourcePath, approvedRoots, importMethod);
    this.jobs.registerAuthorizedImport(source);
    return source;
  }

  submitImportAsset(request: ImportAssetRequest): Promise<JobView> {
    return this.jobs.submitImportAsset(request);
  }

  getJob(jobId: string): Promise<JobView> {
    return this.jobs.getJob(jobId);
  }

  waitForJob(jobId: string, timeoutMs?: number): Promise<JobView> {
    return this.jobs.waitForJob(jobId, timeoutMs);
  }

  cancelJob(request: CancelJobRequest): Promise<CancelJobResponse> {
    return this.jobs.cancelJob(request);
  }

  eventsAfter(projectId: string, afterSequence?: number, limit?: number): Promise<JobEventPage> {
    return this.jobs.eventsAfter(projectId, afterSequence, limit);
  }

  onEvent(listener: (event: JobEvent) => void): () => void {
    return this.jobs.onEvent(listener);
  }

  capabilities(): CapabilitySet {
    return this.projects.capabilities();
  }

  dispatch(command: Extract<ServiceCommand, "create_project" | "open_project" | "import_asset" | "apply_operations" | "cancel_job">, input: unknown): Promise<unknown> {
    switch (command) {
      case "create_project": return this.createProject(CreateProjectRequestSchema.parse(input));
      case "open_project": return this.openProject(OpenProjectRequestSchema.parse(input));
      case "apply_operations": return this.submitApplyOperations(ApplyOperationsRequestSchema.parse(input));
      case "import_asset": return this.submitImportAsset(ImportAssetRequestSchema.parse(input));
      case "cancel_job": return this.cancelJob(CancelJobRequestSchema.parse(input));
    }
  }
}
