export function sitePath(
  path = "",
  base = (import.meta as ImportMeta & { env?: { BASE_URL?: string } }).env
    ?.BASE_URL ?? "/",
): string {
  return `${base.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
