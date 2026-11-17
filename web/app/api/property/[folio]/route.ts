import { respond } from "@/lib/http";
import { getProperty } from "@/lib/queries";

/** One property with every permit filed against it. */
export async function GET(_request: Request, ctx: RouteContext<"/api/property/[folio]">) {
  const { folio } = await ctx.params;
  return respond(() => getProperty({ folio }));
}
