import { createServer } from "node:http";
import { normalEnvironment, normalFlow } from "../../fixtures/apps/normal/flow.js";
import { issueFixtureNetworkGrant } from "../capture-network-policy.js";
import type { BrowserTargets } from "../service/local.js";

/** Bundled fake product only. Its narrow grant cannot authorize user-supplied capture targets. */
export async function startDemoFixture() {
  let changed = false;
  const server = createServer((request, response) => {
    if (request.method === "POST" && request.url === "/__reset") { response.writeHead(204).end(); return; }
    if (request.method !== "GET" || request.url !== "/") { response.writeHead(404).end(); return; }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Release Replay Demo</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#0d171c;color:#eef7f4;font:24px system-ui,sans-serif}
main{max-width:1500px;margin:100px auto;padding:60px;border:1px solid #30433f;border-radius:24px;background:#14242a}
header{display:flex;justify-content:space-between;align-items:center}small{color:#68dcb4;letter-spacing:3px}h1{font-size:64px;letter-spacing:-3px;margin:24px 0}p{color:#adc1ba}
button{background:#7ce5b6;border:0;border-radius:12px;padding:20px 32px;font:600 24px system-ui;cursor:pointer;color:#10221b}
section{padding:32px;margin-top:36px;border-radius:16px;background:#1f3338}input{margin:0 24px;padding:16px;border:1px solid #59736a;border-radius:8px;background:#102024;color:white;font-size:24px}
.cards{display:flex;gap:24px;margin-top:40px}.cards article{flex:1;padding:28px;border:1px solid #38524a;border-radius:16px}.cards strong{display:block;font-size:40px;margin:10px 0}
#note{color:#7ce5b6;font-weight:600}
</style></head><body><main data-testid="release-page">
<header><small>REPLEX / RELEASES</small><small>PRODUCT UPDATE</small></header>
<h1>Release Replay Demo</h1><p>Show the release. Keep the story up to date.</p>
<button aria-label="Open filters" id="open-filter">Open filters</button>
<section data-testid="filter-panel" hidden><h2>Filter releases</h2>
<label for="filter-value">Filter value</label><input id="filter-value"/><button aria-label="Apply" id="apply">Apply</button>
<p data-testid="result" hidden></p>
<p id="note" hidden>${changed ? "New: saved release filters are ready." : "Release filters, ready for your team."}</p>
<small data-testid="demo-ready" hidden>Ready to share</small></section>
<div class="cards"><article><small>RELEASES</small><strong>03</strong><p>Ready to share</p></article><article><small>WORKFLOW</small><strong>One view</strong><p>Everything in context</p></article><article><small>STATUS</small><strong>Shipped</strong><p>Built for the next change</p></article></div>
</main><script>
document.querySelector('#open-filter').onclick=()=>{document.querySelector('[data-testid="filter-panel"]').hidden=false};
document.querySelector('#apply').onclick=()=>{
setTimeout(()=>{const result=document.querySelector('[data-testid="result"]');result.textContent='Showing 3 matching releases';result.hidden=false;document.querySelector('#note').hidden=false},200);
setTimeout(()=>{document.querySelector('[data-testid="demo-ready"]').hidden=false},3500);
};
</script></body></html>`);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("The bundled demo fixture could not start.");
  const origin = `http://127.0.0.1:${address.port}`;
  const flow = normalFlow(origin);
  flow.steps.push({
    id: "demo-hold-result", order: flow.steps.length, action: "waitFor", consequential: false, approved: true,
    checkpoint: { kind: "visible", target: { kind: "testId", value: "demo-ready" }, expected: "Ready to share" }, sceneKey: "apply-filter",
  });
  const browserTargets: BrowserTargets = {
    [flow.id]: { flow, environment: normalEnvironment(origin), values: { filterValue: "release" }, resetUrl: origin + "/__reset" },
  };
  return {
    origin, flow, browserTargets, fixtureGrants: [issueFixtureNetworkGrant(server)],
    change: () => { changed = true; },
    close: () => new Promise<void>((resolve, reject) => { server.closeAllConnections(); server.close((error) => error ? reject(error) : resolve()); }),
  };
}
