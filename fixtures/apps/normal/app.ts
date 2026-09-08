export interface NormalFixtureState {
  changed: boolean;
  failureActionId?: string;
}

export function renderNormalFixture(state: NormalFixtureState): string {
  const result = state.failureActionId === "apply-filter"
    ? "Filter failed"
    : state.changed ? "Showing 4 matching releases" : "Showing 3 matching releases";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Release Replay Demo</title></head>
<body><main data-testid="release-page"><h1>Release Replay Demo</h1>
  <button type="button" aria-label="Open filters" id="open-filter">Open filters</button>
  <section data-testid="filter-panel" hidden><h2>Filter releases</h2>
    <label for="filter-value">Filter value</label><input id="filter-value" name="filter-value">
    <button type="button" aria-label="Apply" id="apply-filter">Apply</button>
  </section>
  <p data-testid="result" hidden>${result}</p>
</main><script>
  document.querySelector('#open-filter').addEventListener('click', () => { document.querySelector('[data-testid="filter-panel"]').hidden = false; });
  document.querySelector('#apply-filter').addEventListener('click', () => { document.querySelector('[data-testid="result"]').hidden = false; });
</script></body></html>`;
}
