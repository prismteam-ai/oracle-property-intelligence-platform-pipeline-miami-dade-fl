/** Liveness check for the host's readiness probe. Deliberately touches nothing else. */
export function GET() {
  return Response.json({ status: "ok" });
}
