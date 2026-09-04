export interface DifficultFixtureState {
  changed: boolean;
  failureActionId?: string;
}

export function renderDifficultFixture(state: DifficultFixtureState): string {
  const validation = state.changed ? "Validation passed for updated plan" : "Validation passed for baseline plan";
  const failureActionId = JSON.stringify(state.failureActionId ?? "");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Release plan wizard</title></head>
<body>
  <main data-testid="wizard-page"><h1>Release plan wizard</h1>
    <section data-testid="step-one"><h2>Choose a release</h2><p>Step 1 of 3</p><button type="button" id="next">Next step</button></section>
    <section data-testid="step-two" hidden><h2>Configure release</h2>
      <label for="project-name">Project name</label><input id="project-name" name="project-name">
      <label for="asset-upload">Release asset</label><input id="asset-upload" data-testid="asset-upload" type="file" data-state="idle">
      <button type="button" id="continue">Continue</button>
    </section>
    <section data-testid="step-three" hidden><h2>Review</h2><p>Step 3 of 3</p>
      <p data-testid="validation-status">Validation idle</p><button type="button" id="validate">Run validation</button>
    </section>
  </main>
  <script>
    const failureActionId = ${failureActionId};
    const one = document.querySelector('[data-testid="step-one"]');
    const two = document.querySelector('[data-testid="step-two"]');
    const three = document.querySelector('[data-testid="step-three"]');
    const upload = document.querySelector('[data-testid="asset-upload"]');
    const status = document.querySelector('[data-testid="validation-status"]');
    document.querySelector('#next').addEventListener('click', () => { one.hidden = true; two.hidden = false; });
    upload.addEventListener('change', () => { upload.dataset.state = 'selected'; });
    document.querySelector('#continue').addEventListener('click', () => { two.hidden = true; three.hidden = false; });
    document.querySelector('#validate').addEventListener('click', () => {
      status.textContent = 'Validating release over a slow connection';
      if (failureActionId === 'difficult-run-validation') { status.textContent = 'Validation timed out'; return; }
      setTimeout(() => { status.textContent = '${validation}'; }, 120);
    });
  </script>
</body></html>`;
}
