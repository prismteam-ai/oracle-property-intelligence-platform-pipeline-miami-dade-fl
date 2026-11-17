import { respond, searchInput } from "@/lib/http";
import { findPlace } from "@/lib/queries";

/** Resolve a city or place name to coordinates. */
export async function GET(request: Request) {
  return respond(() => findPlace(searchInput(request) as { name: string }));
}
