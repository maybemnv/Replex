export async function changeDynamicFixture(origin: string): Promise<void> {
  const response = await fetch(`${origin}/__change`, { method: "POST" });
  if (!response.ok) throw new Error(`dynamic fixture change failed: ${response.status}`);
}
