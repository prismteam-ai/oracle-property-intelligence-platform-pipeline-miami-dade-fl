import { searchEntities } from "@/lib/entities";
import { respond } from "@/lib/http";

export const maxDuration = 60;

/** Contractors, owners or businesses by name. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return respond(() =>
    searchEntities({
      kind: params.get("kind") as "contractor" | "owner" | "business",
      q: params.get("q") ?? "",
      ...(params.get("limit") ? { limit: Number(params.get("limit")) } : {}),
      ...(params.get("sort") ? { sort: params.get("sort") as "roofing_permits" } : {}),
    }),
  );
}
