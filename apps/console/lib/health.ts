// Health payload for GET /api/health. Deliberately tiny: no environment details,
// no secrets, nothing about firms (SECURITY.md §4).

export interface Health {
  status: "ok";
  service: "offmanual-console";
  version: string;
  time: string;
}

export function health(
  now: Date = new Date(),
  version: string = process.env.OM_CONSOLE_VERSION ?? "0.0.0-dev",
): Health {
  return { status: "ok", service: "offmanual-console", version, time: now.toISOString() };
}
