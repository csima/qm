export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const json = (body: unknown, status = 200) => Response.json(body, { status });

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  if (!/^application\/json(;|$)/i.test(req.headers.get("content-type") ?? ""))
    throw new HttpError(415, "send the body as application/json");
  const parsed = (await req.json().catch(() => null)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new HttpError(400, "body must be a JSON object");
  return parsed as Record<string, unknown>;
}

export function hex(bytes: number): string {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function asHttp(status: number): (error: unknown) => never {
  return (error) => {
    throw error instanceof HttpError ? error : new HttpError(status, (error as Error).message);
  };
}
