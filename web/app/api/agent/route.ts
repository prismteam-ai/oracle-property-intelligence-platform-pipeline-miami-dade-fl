import { z } from "zod";
import { askAgent } from "@/lib/agent";
import { respond } from "@/lib/http";

export const maxDuration = 120;

const input = z.object({ question: z.string().min(5).max(600) });

/** Ask the lead-discovery agent a question. Returns the answer and every tool call behind it. */
export async function POST(request: Request) {
  return respond(async () => {
    const { question } = input.parse(await request.json());
    return askAgent(question);
  });
}
