import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import { generateText, isStepCount, tool } from "ai";
import { TOOLS } from "./tools";

/**
 * The lead-discovery agent.
 *
 * Division of labour:
 * - The model decides which tools to call and writes the explanation.
 * - Every count, property and permit comes from a tool, which runs SQL over
 *   the published snapshot. The model is told to state nothing it did not get
 *   from a tool, and the tool calls are returned beside the answer so a reader
 *   can check it against the records.
 */

// Tried in order. Measured on the free tier: the newest models time out or return
// "high demand", so the default is the one that answers a tool call in about a second.
const MODELS = (process.env.AGENT_MODELS ?? "gemini-3.5-flash-lite,gemini-3-flash-preview,gemini-3.5-flash").split(",").map((m) => m.trim());
// A healthy answer takes 4 to 25 seconds; a longer wait is a hung call, better abandoned for the next model.
const ATTEMPT_TIMEOUT_MS = 40_000;
/** The whole question must finish inside the function's 120 s limit. */
const BUDGET_MS = 100_000;
/** The free model tier often answers "high demand" or hangs for a few seconds, so the list of models is tried up to twice, within the budget. */
const ATTEMPTS = [...MODELS, ...MODELS];

const SYSTEM = `You help a roofing company find leads in Miami-Dade County, Florida, using a published dataset of county property, permit and contractor records.

Rules:
- Use the tools for every fact. Never state a count, address, owner, date or contractor that did not come from a tool result.
- When a question names a place, call find_place first, then search around the coordinates it returns. Use the radius the question gives; if it gives none ("near", "around"), use 3 miles and say so.
- "Older than 15 years" means minRoofAge 15. "Open for many years" means sort by longest open; mention how long each has been open.
- Report the total number of matches and say how many you are listing. List at most 8 items; the full rows are shown to the user beside your answer.
- One search is normally enough. Do not call get_property or query_sql unless the question asks for something the search result does not contain.
- Property results are one row per street address; if matches_at_address is more than 1, say how many units match there.
- For each property say the roof year and its basis: "roof permit" (a completed roof permit) or "year built" (a proxy, since county permits only go back to 2020).
- For each permit give the permit number, issue date, how long it has been open, the derived status, and the contractor name and licence number. If no contractor is printed, say so. Where a state licence was found, give its standing and activity (for example "Current, Active") and flag Probation, Suspended or Inactive clearly; if none was found say "not in the state licence file", which does not by itself mean unlicensed. BBB ratings are not in the dataset: say that plainly instead of guessing. Where a permit has a bbb_profile_url, give it as "BBB profile (matched by name)" so the reader can check the rating themselves.
- Permit status is derived from inspection dates because the county publishes none. Say "no approved final inspection on record" rather than "open" as a legal fact.
- End with a short "Assumptions and gaps" line listing anything you assumed and any data the question needed that is missing.
- Be concise. Use short lists, not long paragraphs.`;

/**
 * The model key. On AWS it is an encrypted SSM parameter named by
 * GEMINI_KEY_PARAMETER, read once per warm instance, so the key is never in the
 * function's configuration. Elsewhere it comes from the environment.
 */
let keyPromise: Promise<string> | null = null;
function modelKey(): Promise<string> {
  keyPromise ??= (async () => {
    const parameter = process.env.GEMINI_KEY_PARAMETER;
    if (!parameter) {
      const key = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
      if (!key) throw new Error("No language model key is configured");
      return key;
    }
    const result = await new SSMClient({}).send(new GetParameterCommand({ Name: parameter, WithDecryption: true }));
    if (!result.Parameter?.Value) throw new Error(`SSM parameter ${parameter} is empty`);
    return result.Parameter.Value;
  })().catch((error) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}

export interface AgentStep {
  tool: string;
  input: unknown;
  output: unknown;
}

export async function askAgent(question: string): Promise<{ answer: string; steps: AgentStep[]; model: string }> {
  let lastError: unknown;
  const started = Date.now();
  for (const [attempt, model] of ATTEMPTS.entries()) {
    const left = BUDGET_MS - (Date.now() - started);
    if (left < 5_000) break;
    if (attempt > 0 && attempt % MODELS.length === 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
    try {
      return await askWith(model, question, Math.min(ATTEMPT_TIMEOUT_MS, left));
    } catch (error) {
      lastError = error;
      console.error(`Agent model ${model} failed:`, error instanceof Error ? error.message : error);
    }
  }
  throw new Error(`The language model is unavailable right now (${lastError instanceof Error ? lastError.message : "unknown error"}). The data tools on this page still work.`);
}

async function askWith(model: string, question: string, timeoutMs: number): Promise<{ answer: string; steps: AgentStep[]; model: string }> {
  const steps: AgentStep[] = [];
  const tools = Object.fromEntries(
    TOOLS.map((spec) => [
      spec.name,
      tool({
        description: spec.description,
        inputSchema: spec.inputSchema,
        execute: async (input: unknown) => {
          const output = await (spec.run as (input: unknown) => Promise<unknown>)(input);
          steps.push({ tool: spec.name, input, output });
          return output;
        },
      }),
    ]),
  );
  const google = createGoogleGenerativeAI({ apiKey: await modelKey() });
  const result = await generateText({
    model: google(model),
    system: SYSTEM,
    prompt: question,
    tools,
    stopWhen: isStepCount(8),
    temperature: 0,
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(timeoutMs),
  });
  // If the model used every step on tool calls it leaves no text; say so instead of returning nothing.
  const answer = result.text.trim() || "I ran several searches but did not reach a written answer. The records I retrieved are listed below.";
  return { answer, steps, model };
}
