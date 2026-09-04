export async function changeDifficultFixture(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__change`, { method: "POST" });
  if (!response.ok) throw new Error(`difficult fixture change failed: ${response.status}`);
}
