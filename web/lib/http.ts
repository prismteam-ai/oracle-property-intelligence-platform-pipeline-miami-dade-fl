import { ZodError } from "zod";

/** Turn URL search parameters into a plain object: numbers, booleans and comma lists decoded. */
export function searchInput(request: Request, lists: string[] = []): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    if (value === "") continue;
    if (lists.includes(key)) out[key] = value.split(",");
    else if (value === "true" || value === "false") out[key] = value === "true";
    else if (/^-?\d+(\.\d+)?$/.test(value) && key !== "folio") out[key] = Number(value);
    else out[key] = value;
  }
  return out;
}

/** Run a handler and map failures to honest HTTP errors. */
export async function respond(handler: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await handler());
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: "Invalid input", issues: error.issues }, { status: 400 });
    }
    console.error(error);
    return Response.json({ error: error instanceof Error ? error.message : "Query failed" }, { status: 500 });
  }
}
