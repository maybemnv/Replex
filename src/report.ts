import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Project } from "./schema.js";

export interface ReportInput {
  render?: { path: string; durationMs: number; verification: "passed" | "failed" };
  checks?: Array<{ code: string; passed: boolean; detail: string }>;
  operations?: Array<{ id: string; actor: string; accepted: boolean; detail: string }>;
}

/** Writes a read-only local review surface; it never changes the canonical project. */
export function generateReport(project: Project, root: string, input: ReportInput = {}): string {
  const reportPath = join(root, "report.html");
  writeFileSync(join(root, "tokens.css"), TOKENS, "utf8");
  writeFileSync(reportPath, reportHtml(project, input), "utf8");
  return reportPath;
}

function reportHtml(project: Project, input: ReportInput): string {
  const scenes = [...project.scenes].sort((left, right) => left.order - right.order);
  const duration = scenes.reduce((sum, scene) => sum + (scene.sourceOutMs - scene.sourceInMs) / scene.speed, 0);
  const checks = input.checks ?? [];
  const operations = input.operations ?? [];
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Release Replay evidence — ${escapeHtml(project.projectId)}</title>
  <link rel="stylesheet" href="tokens.css">
  <style>
/* Hallmark · genre: editorial · macrostructure: Long Document · theme: Newsprint · enrichment: none · nav: N6 · footer: Ft2 */
* { box-sizing: border-box; }
body { margin: 0; background: var(--color-paper); color: var(--color-ink); font-family: var(--font-body); line-height: 1.6; }
a { color: var(--color-accent); text-underline-offset: var(--space-xs); }
a:focus-visible, video:focus-visible { outline: var(--rule-focus) solid var(--color-focus); outline-offset: var(--space-xs); }
.masthead { border-bottom: var(--rule-hairline) solid var(--color-rule); padding: var(--space-md) var(--space-lg) var(--space-sm); text-align: center; }
.masthead p, .masthead h1 { margin: 0; }
.issue { color: var(--color-muted); font-family: var(--font-mono); font-size: var(--text-xs); letter-spacing: var(--tracking-wide); }
.masthead h1 { font-family: var(--font-display); font-size: var(--text-display-s); font-weight: var(--weight-display); line-height: 1; }
main { margin: 0 auto; max-width: var(--measure-wide); padding: var(--space-2xl) var(--space-lg) var(--space-3xl); }
.lede { color: var(--color-muted); font-size: var(--text-lg); max-width: var(--measure); }
.strip { border-block: var(--rule-hairline) solid var(--color-rule); display: grid; gap: var(--space-md); grid-template-columns: repeat(3, 1fr); margin: var(--space-xl) 0; padding: var(--space-md) 0; }
.strip b { display: block; font-family: var(--font-display); font-size: var(--text-xl); font-variant-numeric: tabular-nums; font-weight: var(--weight-display); }
.strip span, .muted { color: var(--color-muted); font-size: var(--text-sm); }
section { margin-top: var(--space-2xl); }
h2 { font-family: var(--font-display); font-size: var(--text-xl); font-weight: var(--weight-display); line-height: 1.15; margin: 0 0 var(--space-sm); }
.spec { border-collapse: collapse; font-variant-numeric: tabular-nums; width: 100%; }
.spec th, .spec td { border-bottom: var(--rule-hairline) solid var(--color-rule); padding: var(--space-sm) 0; text-align: left; vertical-align: top; }
.spec th { font-family: var(--font-mono); font-size: var(--text-xs); font-weight: var(--weight-body); letter-spacing: var(--tracking-wide); width: 30%; }
.scene { border-top: var(--rule-hairline) solid var(--color-rule); display: grid; gap: var(--space-sm); grid-template-columns: minmax(0, 1fr) minmax(var(--space-3xl), 2fr); padding: var(--space-lg) 0; }
.scene h3 { font-family: var(--font-display); font-size: var(--text-lg); font-weight: var(--weight-display); margin: 0; }
.scene p { margin: 0; }
.status-pass { color: var(--color-pass); }
.status-fail { color: var(--color-fail); }
video { background: var(--color-ink); display: block; margin-top: var(--space-md); max-width: 100%; width: 100%; }
.foot-line { border-top: var(--rule-hairline) solid var(--color-rule); color: var(--color-muted); font-size: var(--text-sm); margin-top: var(--space-3xl); padding-top: var(--space-md); }
@media (max-width: 700px) { main { padding-inline: var(--space-md); } .strip, .scene { grid-template-columns: 1fr; } .masthead h1 { font-size: var(--text-xl); } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto; transition-duration: var(--dur-reduced); } }
  </style>
</head>
<body>
  <header class="masthead" aria-label="Release Replay evidence report">
    <p class="issue">RELEASE REPLAY · LOCAL POC EVIDENCE</p>
    <h1>Revision ${escapeHtml(project.currentRevisionId)}</h1>
  </header>
  <main>
    <p class="lede">${escapeHtml(project.brief.message)} This report records project facts and mechanical checks. It does not assess taste, persuasion, or publishability.</p>
    <div class="strip" aria-label="Project summary">
      <div><b>${scenes.length}</b><span>ordered scenes</span></div>
      <div><b>${Math.round(duration / 1000)}s</b><span>derived duration</span></div>
      <div><b>${checks.filter((check) => check.passed).length}/${checks.length}</b><span>recorded checks passing</span></div>
    </div>
    <section>
      <h2>Approved environment</h2>
      <table class="spec"><tbody>
        <tr><th>Project</th><td>${escapeHtml(project.projectId)}</td></tr>
        <tr><th>Audience</th><td>${escapeHtml(project.brief.audience)}</td></tr>
        <tr><th>Origin</th><td>${escapeHtml(project.environment.appOrigin)}</td></tr>
        <tr><th>Capture contract</th><td>${project.environment.viewport.width}×${project.environment.viewport.height} · ${escapeHtml(project.environment.locale)} · ${escapeHtml(project.environment.timezone)}</td></tr>
      </tbody></table>
    </section>
    <section>
      <h2>Scene provenance</h2>
      ${scenes.map((scene) => sceneRow(project, scene)).join("\n")}
    </section>
    <section>
      <h2>Verification record</h2>
      ${checks.length ? `<table class="spec"><tbody>${checks.map((check) => `<tr><th class="${check.passed ? "status-pass" : "status-fail"}">${escapeHtml(check.code)}</th><td>${escapeHtml(check.detail)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No verification record is attached.</p>`}
    </section>
    <section>
      <h2>Operation audit</h2>
      ${operations.length ? `<table class="spec"><tbody>${operations.map((operation) => `<tr><th class="${operation.accepted ? "status-pass" : "status-fail"}">${escapeHtml(operation.actor)} · ${operation.accepted ? "accepted" : "rejected"}</th><td>${escapeHtml(operation.id)} · ${escapeHtml(operation.detail)}</td></tr>`).join("")}</tbody></table>` : `<p class="muted">No operation audit is attached.</p>`}
    </section>
    ${input.render ? `<section><h2>Authoritative render</h2><p class="muted">${escapeHtml(input.render.verification)} · ${Math.round(input.render.durationMs / 1000)} seconds · <a href="${safeHref(input.render.path)}">open MP4</a></p><video controls preload="metadata" src="${safeHref(input.render.path)}">Your browser cannot play this local MP4.</video></section>` : ""}
    <footer class="foot-line"><p>Generated from the canonical project revision. Local evidence only.</p></footer>
  </main>
</body>
</html>`;
}

function sceneRow(project: Project, scene: Project["scenes"][number]): string {
  const capture = project.captures[scene.captureId];
  const overlays = Object.values(project.overlays).filter((overlay) => overlay.sceneId === scene.id);
  return `<article class="scene"><div><h3>${escapeHtml(scene.sceneKey)}</h3><p class="muted">${escapeHtml(scene.id)}</p></div><div><p>${escapeHtml(capture?.id ?? "missing capture")} · ${escapeHtml(capture?.checkpointActionId ?? "missing checkpoint")} · ${Math.round((scene.sourceOutMs - scene.sourceInMs) / scene.speed)}ms</p><p class="muted">${overlays.length ? overlays.map((overlay) => `${escapeHtml(overlay.kind)}: ${escapeHtml(overlay.text)}`).join(" · ") : "No overlays"} · ${escapeHtml(scene.transition.type)} · ${scene.transition.durationMs}ms</p></div></article>`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]!);
}

function safeHref(value: string): string {
  return escapeHtml(value.replace(/\\/g, "/").replace(/^\/+|\.\.(?:\/|$)/g, ""));
}

const TOKENS = `:root {
  --color-paper: oklch(97% 0.012 82);
  --color-ink: oklch(24% 0.025 48);
  --color-muted: oklch(49% 0.028 56);
  --color-accent: oklch(47% 0.13 34);
  --color-pass: oklch(43% 0.10 145);
  --color-fail: oklch(48% 0.16 28);
  --color-rule: oklch(76% 0.025 67);
  --color-focus: oklch(55% 0.15 245);
  --font-display: "Newsreader", "Iowan Old Style", ui-serif, serif;
  --font-body: "IBM Plex Sans", ui-sans-serif, sans-serif;
  --font-mono: "IBM Plex Mono", ui-monospace, monospace;
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-lg: 1.25rem;
  --text-xl: clamp(1.75rem, 4vw, 3rem);
  --text-display-s: clamp(2.25rem, 6vw, 5rem);
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 1.5rem;
  --space-xl: 2.25rem;
  --space-2xl: 4rem;
  --space-3xl: 6rem;
  --measure: 65ch;
  --measure-wide: 75rem;
  --tracking-wide: 0.08em;
  --weight-body: 450;
  --weight-display: 700;
  --rule-hairline: 1px;
  --rule-focus: 2px;
  --ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --dur-reduced: 0ms;
}
`;
