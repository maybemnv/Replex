export async function resetNormalFixture(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__reset`, { method: "POST" });
  if (!response.ok) throw new Error(`normal fixture reset failed: ${response.status}`);
}
