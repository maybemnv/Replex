export interface DynamicFixtureState {
  changed: boolean;
  failureActionId?: string;
}

export function renderDynamicFixture(state: DynamicFixtureState): string {
  const records = state.changed ? 84 : 42;
  const failureActionId = JSON.stringify(state.failureActionId ?? "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Dynamic Workspace</title>
<style>@keyframes replex-live-pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.25; } } [data-testid="live-indicator"] { animation: replex-live-pulse 1s linear infinite; font-size: 28px; }</style></head>
<body>
  <span data-testid="live-indicator" aria-hidden="true">●</span>
  <main data-testid="auth-page">
    <h1>Dynamic Workspace</h1>
    <form id="login-form">
      <label for="email">Email</label><input id="email" name="email" type="email">
      <label for="password">Password</label><input id="password" name="password" type="password">
      <button type="submit">Sign in</button>
      <p data-testid="auth-error" hidden>Disposable credentials were rejected</p>
    </form>
  </main>
  <section data-testid="dashboard" hidden>
    <h2>Dynamic Workspace</h2>
    <label for="plan">Plan</label>
    <select id="plan" data-testid="plan-select" data-state="idle">
      <option value="standard">Standard</option><option value="priority">Priority</option>
    </select>
    <button type="button" id="details">Open details</button>
    <button type="button" id="load">Load async data</button>
    <button type="button" id="save">Save workspace</button>
    <p data-testid="data-status">Not loaded</p>
    <p data-testid="toast" hidden>Saved locally</p>
  </section>
  <section data-testid="details-modal" hidden><h3>Release details</h3><p>Modal details for the selected plan.</p></section>
  <script>
    const failureActionId = ${failureActionId};
    const auth = document.querySelector('[data-testid="auth-page"]');
    const dashboard = document.querySelector('[data-testid="dashboard"]');
    const modal = document.querySelector('[data-testid="details-modal"]');
    const status = document.querySelector('[data-testid="data-status"]');
    document.querySelector('#login-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const valid = document.querySelector('#email').value === 'demo@example.test' && document.querySelector('#password').value === 'fixture-password';
      if (!valid) { document.querySelector('[data-testid="auth-error"]').hidden = false; return; }
      auth.hidden = true; dashboard.hidden = false;
    });
    document.querySelector('#plan').addEventListener('change', (event) => {
      event.currentTarget.dataset.state = 'selected';
    });
    document.querySelector('#details').addEventListener('click', () => { modal.hidden = false; });
    document.querySelector('#load').addEventListener('click', () => {
      status.textContent = 'Loading asynchronous data'; status.dataset.state = 'loading';
      if (failureActionId === 'dynamic-load-async') {
        status.textContent = 'Async request timed out'; status.dataset.state = 'error'; return;
      }
      setTimeout(() => {
        status.textContent = 'Loaded ${records} records'; status.dataset.state = 'ready';
      }, 80);
    });
    document.querySelector('#save').addEventListener('click', () => {
      const toast = document.querySelector('[data-testid="toast"]'); toast.hidden = false;
    });
  </script>
</body></html>`;
}
