import { respond, searchInput } from "@/lib/http";
import { searchProperties, type PropertySearchInput } from "@/lib/queries";

export const maxDuration = 60;

/** Properties within a radius, optionally filtered by roof age, sale age and owner location. */
export async function GET(request: Request) {
  return respond(() => searchProperties(searchInput(request, ["ownerLocation"]) as PropertySearchInput));
}
