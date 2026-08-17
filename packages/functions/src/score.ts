import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  getCodingTask,
  scorecardSchema,
  type IntegrityEvent,
  type Interview,
  type Job,
  type Scorecard,
  type TranscriptTurn,
} from "@ai-interviewer/shared";

export type ScoreSource = "openai" | "bedrock" | "heuristic";

export type ScoredResult = Scorecard & { gradedBy: ScoreSource };

function integrityScore(events: IntegrityEvent[]): number {
  const penalty = Math.min(
    10,
    events.filter((e) =>
      ["tab_hidden", "fullscreen_exit", "no_face", "multi_face", "paste_attempt"].includes(e.type),
    ).length,
  );
  return Math.max(0, 10 - penalty);
}

function normalizeCode(code: string): string {
  return code.replace(/\s+/g, " ").trim();
}

function isUnsolvedStarter(submitted: string | undefined, starter: string): boolean {
  if (!submitted?.trim()) return true;
  const a = normalizeCode(submitted);
  const b = normalizeCode(starter);
  if (a === b) return true;
  if (/\/\/\s*TODO|\/\*\s*TODO|#\s*TODO/i.test(submitted) && a.length < b.length * 1.35) {
    return true;
  }
  const shorter = Math.min(a.length, b.length);
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return true;
  return shorter / longer > 0.92 && /TODO|return value;|return \[\]|return List\.of\(\)/i.test(submitted);
}

function buildGradingPrompt(input: {
  job: Job;
  interview: Interview;
  turns: TranscriptTurn[];
  events: IntegrityEvent[];
  integrity: number;
  unsolved: boolean;
  taskTitle: string;
  taskPrompt: string;
  starter: string;
}): string {
  return `You are an expert technical hiring interviewer for IT roles.
Grade this candidate fairly and strictly from evidence only. Do not invent strengths that are not in the transcript or code.

Return ONLY valid JSON (no markdown) matching:
{
  "technical": 0-10,
  "communication": 0-10,
  "codeQuality": 0-10,
  "integrity": 0-10,
  "hireRecommendation": "yes" | "lean_yes" | "lean_no" | "no",
  "summary": "2-4 sentences for the recruiter",
  "strengths": ["..."],
  "concerns": ["..."]
}

Scoring guidance:
- technical: correctness/depth of spoken answers vs the JD and seniority. Thin or missing answers must score low. Grade a Junior more gently than Staff.
- communication: clarity, structure, relevance — not friendliness alone.
- codeQuality: compare submitted code to the starter and task. Unchanged starter / leftover TODOs = 0-2. Partial attempt = 3-5. Working solution = 6-9. Excellent = 10.
- integrity: start from the hint (${input.integrity}); lower for many tab_hidden, fullscreen_exit, no_face, multi_face, paste_attempt events.
- hireRecommendation: require both meaningful voice evidence AND a real coding attempt for lean_yes/yes.

Job title: ${input.job.title}
Seniority: ${input.job.seniority ?? "mid"}
Job description:
${input.job.description}

Coding task: ${input.taskTitle}
Instructions:
${input.taskPrompt}

Starter code provided to candidate:
\`\`\`
${input.starter}
\`\`\`

Code submitted by candidate:
\`\`\`
${input.interview.submittedCode || "(empty)"}
\`\`\`

Automated flag — appears still on starter/TODOs: ${input.unsolved}

Interview transcript (assistant = AI interviewer, user = candidate):
${input.turns.map((t) => `${t.role}: ${t.text}`).join("\n") || "(no transcript captured)"}

Integrity events:
${input.events.map((e) => `${e.at} ${e.type}${e.detail ? ` ${e.detail}` : ""}`).join("\n") || "(none)"}
`;
}

function parseScorecard(text: string, integrityFallback: number): Scorecard {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const json = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  return scorecardSchema.parse({
    ...json,
    integrity: typeof json.integrity === "number" ? json.integrity : integrityFallback,
  });
}

async function gradeWithOpenAi(
  apiKey: string,
  prompt: string,
  integrity: number,
): Promise<Scorecard> {
  const model = process.env.OPENAI_SCORE_MODEL || "gpt-4o-mini";
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You grade technical interviews. Be evidence-based and strict. Output JSON only.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) {
    throw new Error(`openai_score_failed: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("openai_score_empty");
  return parseScorecard(content, integrity);
}

async function gradeWithBedrock(prompt: string, integrity: number): Promise<Scorecard> {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error("bedrock_not_configured");
  const bedrock = new BedrockRuntimeClient({});
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: 1500,
        messages: [{ role: "user", content: prompt }],
      }),
    }),
  );
  const raw = JSON.parse(new TextDecoder().decode(res.body)) as {
    content?: { text?: string }[];
  };
  const text = raw.content?.[0]?.text;
  if (!text) throw new Error("bedrock_score_empty");
  return parseScorecard(text, integrity);
}

function emergencyHeuristic(input: {
  answered: number;
  unsolved: boolean;
  integrity: number;
}): ScoredResult {
  return {
    technical: Math.min(3, input.answered),
    communication: Math.min(3, input.answered),
    codeQuality: input.unsolved ? 1 : 4,
    integrity: input.integrity,
    hireRecommendation: "no",
    summary:
      "Emergency fallback only — AI grading failed. Do not trust these numbers; re-run scoring after fixing OpenAI/Bedrock access.",
    strengths: [],
    concerns: ["AI grading unavailable"],
    gradedBy: "heuristic",
  };
}

export async function scoreInterview(input: {
  job: Job;
  interview: Interview;
  turns: TranscriptTurn[];
  events: IntegrityEvent[];
  openaiKey?: string;
}): Promise<ScoredResult> {
  const task = getCodingTask({
    codingTask: input.interview.codingTask ?? input.job.codingTask,
    seniority: input.job.seniority,
  });
  const integrity = integrityScore(input.events);
  const unsolved = isUnsolvedStarter(input.interview.submittedCode, task.starter);
  const answered = input.turns.filter(
    (t) => t.role === "user" && t.text.trim().length >= 40,
  ).length;

  const prompt = buildGradingPrompt({
    job: input.job,
    interview: input.interview,
    turns: input.turns,
    events: input.events,
    integrity,
    unsolved,
    taskTitle: task.title,
    taskPrompt: task.prompt,
    starter: task.starter,
  });

  const withStarterGuard = (card: Scorecard, gradedBy: ScoreSource): ScoredResult => {
    if (unsolved && card.codeQuality > 3) {
      return {
        ...card,
        codeQuality: Math.min(card.codeQuality, 2),
        hireRecommendation:
          card.hireRecommendation === "yes" || card.hireRecommendation === "lean_yes"
            ? "lean_no"
            : card.hireRecommendation,
        concerns: [...card.concerns, "Code still looks like unfinished starter"],
        gradedBy,
      };
    }
    return { ...card, gradedBy };
  };

  // Primary: Bedrock Claude (AWS-native)
  try {
    const card = await gradeWithBedrock(prompt, integrity);
    return withStarterGuard(card, "bedrock");
  } catch (err) {
    console.error("Bedrock grading failed", err);
  }

  // Backup: OpenAI
  const openaiKey = input.openaiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const card = await gradeWithOpenAi(openaiKey, prompt, integrity);
      return withStarterGuard(card, "openai");
    } catch (err) {
      console.error("OpenAI grading failed", err);
    }
  }

  return emergencyHeuristic({ answered, unsolved, integrity });
}
