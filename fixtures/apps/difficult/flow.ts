import type { Environment, Flow } from "../../../src/schema.js";

export interface DifficultFlowOptions {
  changed?: boolean;
}

export function difficultEnvironment(origin: string): Environment {
  return {
    appOrigin: origin,
    allowedOrigins: [origin],
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezone: "Asia/Calcutta",
    browserVersion: "bundled-chromium",
    reducedMotion: "reduce",
    colorScheme: "light",
    resetLabel: "POST /__reset",
  };
}

export function difficultFlow(origin: string, options: DifficultFlowOptions = {}): Flow {
  const expectedValidation = options.changed ? "Validation passed for updated plan" : "Validation passed for baseline plan";
  return {
    id: "difficult-approved-flow",
    approvedAt: "2026-09-01T00:00:00.000Z",
    prohibitedActions: ["delete", "publish", "purchase", "send"],
    steps: [
      {
        id: "difficult-open-wizard",
        order: 0,
        action: "goto",
        target: { kind: "url", value: `${origin}/` },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "wizard-page" },
          expected: "Release plan wizard",
        },
        sceneKey: "open-wizard",
      },
      {
        id: "difficult-next-step",
        order: 1,
        action: "click",
        target: { kind: "role", value: "button", name: "Next step" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "step-two" },
          expected: "Configure release",
        },
        sceneKey: "configure-step",
      },
      {
        id: "difficult-fill-project",
        order: 2,
        action: "fill",
        target: { kind: "label", value: "Project name" },
        valueRef: "difficultProjectName",
        consequential: false,
        approved: true,
        checkpoint: { kind: "visible", target: { kind: "label", value: "Project name" }, expected: "Project name" },
        sceneKey: "upload-asset",
      },
      {
        id: "difficult-upload-asset",
        order: 3,
        action: "upload",
        target: { kind: "testId", value: "asset-upload" },
        valueRef: "difficultAsset",
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "attribute",
          target: { kind: "testId", value: "asset-upload" },
          expected: "data-state=selected",
        },
        sceneKey: "upload-asset",
      },
      {
        id: "difficult-continue-review",
        order: 4,
        action: "click",
        target: { kind: "role", value: "button", name: "Continue" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "step-three" },
          expected: "Review",
        },
        sceneKey: "review-state",
      },
      {
        id: "difficult-run-validation",
        order: 5,
        action: "click",
        target: { kind: "role", value: "button", name: "Run validation" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "text",
          target: { kind: "testId", value: "validation-status" },
          expected: expectedValidation,
        },
        sceneKey: "slow-validation",
      },
    ],
  };
}

export const flow = difficultFlow("http://127.0.0.1:4175");
export const environment = difficultEnvironment("http://127.0.0.1:4175");
