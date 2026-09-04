export async function resetDynamicFixture(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__reset`, { method: "POST" });
  if (!response.ok) throw new Error(`dynamic fixture reset failed: ${response.status}`);
}

export async function injectDynamicFailure(origin: string, actionId: "dynamic-load-async"): Promise<void> {
  const response = await fetch(`${origin}/__failure?action=${encodeURIComponent(actionId)}`, { method: "POST" });
  if (!response.ok) throw new Error(`dynamic fixture failure injection failed: ${response.status}`);
}
