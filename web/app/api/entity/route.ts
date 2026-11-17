import { getEntity } from "@/lib/entities";
import { respond } from "@/lib/http";

export const maxDuration = 60;

/** One contractor with its permits, or one owner with its properties. */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  return respond(() => getEntity({ kind: params.get("kind") as "contractor" | "owner", id: params.get("id") ?? "" }));
}
