import type { Environment, Flow } from "../../../src/schema.js";

export function normalEnvironment(origin: string): Environment {
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

export function normalFlow(origin: string): Flow {
  return {
    id: "normal-approved-flow",
    approvedAt: "2026-09-01T00:00:00.000Z",
    prohibitedActions: ["delete", "publish", "purchase", "send"],
    steps: [
      {
        id: "open-release-page",
        order: 0,
        action: "goto",
        target: { kind: "url", value: `${origin}/` },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "release-page" },
          expected: "Release Replay Demo",
        },
        sceneKey: "open-demo",
      },
      {
        id: "open-filter",
        order: 1,
        action: "click",
        target: { kind: "role", value: "button", name: "Open filters" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "testId", value: "filter-panel" },
          expected: "Filter releases",
        },
        sceneKey: "open-filter",
      },
      {
        id: "enter-filter",
        order: 2,
        action: "fill",
        target: { kind: "label", value: "Filter value" },
        valueRef: "filterValue",
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "visible",
          target: { kind: "label", value: "Filter value" },
          expected: "Filter value",
        },
        sceneKey: "apply-filter",
      },
      {
        id: "apply-filter",
        order: 3,
        action: "click",
        target: { kind: "role", value: "button", name: "Apply" },
        consequential: false,
        approved: true,
        checkpoint: {
          kind: "text",
          target: { kind: "testId", value: "result" },
          expected: "Showing 3 matching releases",
        },
        sceneKey: "apply-filter",
      },
    ],
  };
}

export const flow = normalFlow("http://127.0.0.1:4173");
export const environment = normalEnvironment("http://127.0.0.1:4173");
