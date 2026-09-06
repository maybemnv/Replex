export async function resetDifficultFixture(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__reset`, { method: "POST" });
  if (!response.ok) throw new Error(`difficult fixture reset failed: ${response.status}`);
}

export async function injectDifficultFailure(origin: string, actionId: "difficult-run-validation"): Promise<void> {
  const response = await fetch(`${origin}/__failure?action=${encodeURIComponent(actionId)}`, { method: "POST" });
  if (!response.ok) throw new Error(`difficult fixture failure injection failed: ${response.status}`);
}
