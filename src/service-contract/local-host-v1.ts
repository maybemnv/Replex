import { z } from "zod";
import { IdSchema } from "../schema.js";

/** Local host bridge only; excluded from ServiceCommand and model-facing tools. */
export const LocalImportAuthorizationRequestV1Schema = z.object({
  hostContractVersion: z.literal("v1"),
  sourcePath: z.string().min(1).max(4096),
  importMethod: z.enum(["file_picker", "path"]).optional(),
}).strict();

export const LocalImportAuthorizationResponseV1Schema = z.object({
  hostContractVersion: z.literal("v1"),
  token: IdSchema,
  filename: z.string().min(1).max(255).refine((value) => !/[\\/:\0-\x1f]/.test(value), "filename must not contain a path or control characters"),
  sizeBytes: z.number().int().positive().max(268_435_456),
}).strict();

export type LocalImportAuthorizationRequestV1 = z.infer<typeof LocalImportAuthorizationRequestV1Schema>;
export type LocalImportAuthorizationResponseV1 = z.infer<typeof LocalImportAuthorizationResponseV1Schema>;
