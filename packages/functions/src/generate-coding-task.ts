import { randomUUID } from "node:crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  codingTaskSchema,
  GENERIC_CODING_TASK,
  type CodingTask,
  type Seniority,
} from "@ai-interviewer/shared";

const ANGLES = [
  "validate and normalize records from this domain",
  "deduplicate items while preserving first-seen order",
  "parse a small log line or payload into structured data",
  "compute a summary or aggregate over a list",
  "merge two partial lists from this domain",
  "group items by a key that appears in the JD",
  "apply multiple filter conditions (never age)",
  "transform nested config into a flat result",
  "implement a tiny in-memory window or cooldown counter",
  "map status codes or states to a user-facing label",
];

function parseTask(text: string): CodingTask | null {
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    return codingTaskSchema.parse(JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned));
  } catch {
    return null;
  }
}

function isUsableTask(task: CodingTask): boolean {
  const blob = `${task.title}\n${task.prompt}\n${task.starter}`;
  if (/filterUsersByAge|ageThreshold|fizzbuzz|two[\s-]?sum/i.test(blob)) return false;
  if (!/TODO/i.test(task.starter)) return false;
  if (/\.filter\s*\(/.test(task.starter)) return false;
  if (task.prompt.trim().length < 40) return false;
  return true;
}

function languageFromJd(title: string, description: string): CodingTask["language"] {
  const t = `${title} ${description}`.toLowerCase();
  if (/\bpython\b/.test(t)) return "python";
  if (/\bjava\b/.test(t) && !/javascript/.test(t)) return "java";
  if (/\bgo(lang)?\b/.test(t)) return "go";
  return "typescript";
}

function fallbackTask(opts: { title: string; description: string }): CodingTask {
  const language = languageFromJd(opts.title, opts.description);
  const seed = randomUUID().slice(0, 6);
  if (language === "python") {
    return {
      title: "Normalize identifiers",
      language,
      prompt: `From this ${opts.title} role: implement normalize_ids(raw) that trims, lowercases, drops empties, and returns unique ids in first-seen order. (${seed})`,
      starter: `def normalize_ids(raw: list[str]) -> list[str]:
    # TODO
    return raw
`,
    };
  }
  return {
    ...GENERIC_CODING_TASK,
    prompt: `${GENERIC_CODING_TASK.prompt} Ground this in the ${opts.title} domain. (${seed})`,
  };
}

function promptFor(opts: {
  title: string;
  description: string;
  seniority: Seniority;
  angle: string;
  seed: string;
}): string {
  return `Create a unique 5-minute coding exercise for this IT role. Infer language and domain only from the job description.
Return JSON only:
{"title":"short title","language":"typescript|python|java|go","prompt":"what to implement, 2-4 sentences","starter":"starter code with a TODO and no solution"}

Angle for this variant: ${opts.angle}
Variation seed: ${opts.seed}

Rules:
- Solvable in 5 minutes by a ${opts.seniority} engineer.
- One function or small module. No UI framework boilerplate unless the JD is clearly frontend.
- The problem MUST use nouns, data, or workflows from the JD — not a generic users/age toy problem.
- Never use filterUsersByAge, ageThreshold, fizzbuzz, two-sum, or todo-list apps.
- Starter must compile/parse, include TODO, and MUST NOT implement the solution (no .filter / real logic).
- Do not require network, databases, or private APIs.

Job title: ${opts.title}
JD:
${opts.description}
`;
}

async function generateOnce(
  opts: { title: string; description: string; seniority: Seniority; openaiKey?: string },
  angle: string,
  seed: string,
): Promise<CodingTask | null> {
  const prompt = promptFor({ ...opts, angle, seed });
  if (opts.openaiKey) {
    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${opts.openaiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: process.env.OPENAI_SCORE_MODEL || "gpt-4o-mini",
          temperature: 0.9,
          response_format: { type: "json_object" },
          messages: [
            {
              role: "system",
              content:
                "You write unique, JD-grounded coding interview tasks. JSON only. Never repeat filterUsersByAge or generic age-filter problems. Starter code is an empty stub with TODO, never a solution.",
            },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
        const content = data.choices?.[0]?.message?.content;
        const task = content ? parseTask(content) : null;
        if (task && isUsableTask(task)) return task;
      }
    } catch (err) {
      console.error("OpenAI coding task generation failed", err);
    }
  }

  const modelId = process.env.BEDROCK_MODEL_ID;
  if (modelId) {
    try {
      const bedrock = new BedrockRuntimeClient({});
      const res = await bedrock.send(
        new InvokeModelCommand({
          modelId,
          contentType: "application/json",
          accept: "application/json",
          body: JSON.stringify({
            anthropic_version: "bedrock-2023-05-31",
            max_tokens: 1200,
            temperature: 0.9,
            messages: [{ role: "user", content: prompt }],
          }),
        }),
      );
      const raw = JSON.parse(new TextDecoder().decode(res.body)) as {
        content?: { text?: string }[];
      };
      const text = raw.content?.[0]?.text;
      const task = text ? parseTask(text) : null;
      if (task && isUsableTask(task)) return task;
    } catch (err) {
      console.error("Bedrock coding task generation failed", err);
    }
  }

  return null;
}

export async function generateCodingTask(opts: {
  title: string;
  description: string;
  seniority: Seniority;
  openaiKey?: string;
}): Promise<CodingTask> {
  for (let i = 0; i < 3; i++) {
    const angle = ANGLES[Math.floor(Math.random() * ANGLES.length)];
    const seed = randomUUID().slice(0, 8);
    const task = await generateOnce(opts, angle, seed);
    if (task) return task;
  }
  return fallbackTask(opts);
}
