import { query } from "@/lib/engine";

export const maxDuration = 120;

/**
 * Keep-warm target. A schedule calls this every few minutes so a visitor does not wait
 * for a cold start: it loads the published snapshot into this instance if it is not
 * already loaded. The short pause makes simultaneous calls land on separate instances.
 */
async function warm() {
  const result = await query("SELECT 1 AS ok");
  await new Promise((resolve) => setTimeout(resolve, 400));
  return Response.json({ status: "warm", snapshot: result.snapshot.id });
}

export const GET = warm;
export const POST = warm;
