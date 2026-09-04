import type { Environment, Flow } from "../../../src/schema.js";

export interface DynamicFlowOptions {
  changed?: boolean;
}

export function dynamicEnvironment(origin: string): Environment {
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

export function dynamicFlow(origin: string, options: DynamicFlowOptions = {}): Flow {
  const expectedRecords = options.changed ? 84 : 42;
  return {
    id: "dynamic-approved-flow",
    approvedAt: "2026-09-01T00:00:00.000Z",
    prohibitedActions: ["delete", "publish", "purchase", "send"],
    steps: [
      {
        id: "dynamic-open-login",
        order: 0,
        action: "goto",
        target: { kind: "url", value: `${origin}/login` },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "auth-page" },
          expected: "Dynamic Workspace",
        },
        sceneKey: "authenticate",
      },
      {
        id: "dynamic-fill-email",
        order: 1,
        action: "fill",
        target: { kind: "label", value: "Email" },
        valueRef: "dynamicEmail",
        consequential: false,
        approved: true,
        checkpoint: { kind: "visible", target: { kind: "label", value: "Email" }, expected: "Email" },
        sceneKey: "authenticate",
      },
      {
        id: "dynamic-fill-password",
        order: 2,
        action: "fill",
        target: { kind: "label", value: "Password" },
        valueRef: "dynamicPassword",
        consequential: false,
        approved: true,
        checkpoint: { kind: "visible", target: { kind: "label", value: "Password" }, expected: "Password" },
        sceneKey: "authenticate",
      },
      {
        id: "dynamic-sign-in",
        order: 3,
        action: "click",
        target: { kind: "role", value: "button", name: "Sign in" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "dashboard" },
          expected: "Dynamic Workspace",
        },
        sceneKey: "authenticate",
      },
      {
        id: "dynamic-select-plan",
        order: 4,
        action: "select",
        target: { kind: "testId", value: "plan-select" },
        valueRef: "dynamicPlan",
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "attribute",
          target: { kind: "testId", value: "plan-select" },
          expected: "data-state=selected",
        },
        sceneKey: "choose-plan",
      },
      {
        id: "dynamic-open-details",
        order: 5,
        action: "click",
        target: { kind: "role", value: "button", name: "Open details" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "details-modal" },
          expected: "Release details",
        },
        sceneKey: "inspect-details",
      },
      {
        id: "dynamic-load-async",
        order: 6,
        action: "click",
        target: { kind: "role", value: "button", name: "Load async data" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "text",
          target: { kind: "testId", value: "data-status" },
          expected: `Loaded ${expectedRecords} records`,
        },
        sceneKey: "load-async",
      },
      {
        id: "dynamic-save-workspace",
        order: 7,
        action: "click",
        target: { kind: "role", value: "button", name: "Save workspace" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "toast" },
          expected: "Saved locally",
        },
        sceneKey: "save-toast",
      },
    ],
  };
}

export const flow = dynamicFlow("http://127.0.0.1:4174");
export const environment = dynamicEnvironment("http://127.0.0.1:4174");
