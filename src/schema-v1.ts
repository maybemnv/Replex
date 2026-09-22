/** Explicit V1 compatibility surface. The implementation remains in schema.ts. */
export * from "./schema.js";

import { ManifestSchema, ProjectSchema, type Project } from "./schema.js";

export const ProjectV1Schema = ProjectSchema;
export const ManifestV1Schema = ManifestSchema;
export type ProjectV1 = Project;

export function parseProjectV1(input: unknown): ProjectV1 {
  return ProjectV1Schema.parse(input);
}

export function parseManifestV1(input: unknown): ProjectV1 {
  return ManifestV1Schema.parse(input);
}
