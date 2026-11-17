import { respond, searchInput } from "@/lib/http";
import { searchPermits, type PermitSearchInput } from "@/lib/queries";

export const maxDuration = 60;

/** Permits within a radius, longest-open first, with contractor details. */
export async function GET(request: Request) {
  return respond(() => searchPermits(searchInput(request) as PermitSearchInput));
}
