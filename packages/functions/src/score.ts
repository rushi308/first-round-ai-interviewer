import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  getCodingTask,
  jobIncludesCoding,
  orderTranscriptTurns,
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
  includesCoding: boolean;
  unsolved: boolean;
  taskTitle: string;
  taskPrompt: string;
  starter: string;
}): string {
  const codingBlock = input.includesCoding
    ? `Coding task: ${input.taskTitle}
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

- codeQuality: compare submitted code to the starter and task. Unchanged starter / leftover TODOs = 0-2. Partial attempt = 3-5. Working solution = 6-9. Excellent = 10.
- hireRecommendation: require both meaningful voice evidence AND a real coding attempt for lean_yes/yes.`
    : `This role has NO coding task. Do not invent a codeQuality score. Omit codeQuality from the JSON.
- hireRecommendation: based on voice evidence only. lean_yes/yes still need meaningful, JD-relevant answers.`;

  return `You are an expert technical hiring interviewer for IT roles.
Grade this candidate fairly and strictly from evidence only. Do not invent strengths that are not in the transcript or code.

Return ONLY valid JSON (no markdown) matching:
{
  "technical": 0-10,
  "communication": 0-10,${input.includesCoding ? `
  "codeQuality": 0-10,` : ""}
  "integrity": 0-10,
  "hireRecommendation": "yes" | "lean_yes" | "lean_no" | "no",
  "summary": "2-4 sentences for the recruiter",
  "strengths": ["..."],
  "concerns": ["..."],
  "qaReview": [
    {
      "question": "the question Riley asked",
      "answer": "what the candidate actually said (keep their wording; light cleanup only)",
      "bestAnswer": "a sample spoken answer in first person, built FROM their answer"
    }
  ]
}

Scoring guidance:
- technical: correctness/depth of spoken answers vs the JD and seniority. Thin or missing answers must score low. Grade a Junior more gently than Staff.
- communication: clarity, structure, relevance — not friendliness alone.
- codeQuality: compare submitted code to the starter and task. Unchanged starter / leftover TODOs = 0-2. Partial attempt = 3-5. Working solution = 6-9. Excellent = 10.
- integrity: start from the hint (${input.integrity}); lower for many tab_hidden, fullscreen_exit, no_face, multi_face, paste_attempt events.
- qaReview: one item per substantive question Riley asked. Skip greetings and wrap-up lines.
- qaReview.answer: quote or faithfully summarize what THIS candidate said. Do not replace it with a model answer.
- qaReview.bestAnswer: write a sample best answer AS IF this candidate had answered strongly. Start from their actual points: keep what they got right, then add the missing structure, specifics, tradeoffs, and seniority-calibrated depth. Write it in first person as a spoken interview answer (4–8 sentences). Do not invent jobs, companies, or tools they never mentioned. If they said nothing, write a standalone model answer for this seniority and JD.
${codingBlock}

Job title: ${input.job.title}
Seniority: ${input.job.seniority ?? "mid"}
Job description:
${input.job.description}

Interview transcript (assistant = AI interviewer, user = candidate):
${input.turns.map((t) => `${t.role}: ${t.text}`).join("\n") || "(no transcript captured)"}

Integrity events:
${input.events.map((e) => `${e.at} ${e.type}${e.detail ? ` ${e.detail}` : ""}`).join("\n") || "(none)"}
`;
}

function parseScorecard(text: string, integrityFallback: number, includesCoding: boolean): Scorecard {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const json = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  return scorecardSchema.parse({
    ...json,
    integrity: typeof json.integrity === "number" ? json.integrity : integrityFallback,
    codeQuality: includesCoding
      ? typeof json.codeQuality === "number"
        ? json.codeQuality
        : 0
      : undefined,
    qaReview: Array.isArray(json.qaReview)
      ? json.qaReview
          .filter((item: { question?: unknown }) => typeof item?.question === "string")
          .map((item: {
            question?: unknown;
            answer?: unknown;
            bestAnswer?: unknown;
            sampleBestAnswer?: unknown;
            improvedAnswer?: unknown;
          }) => ({
            question: String(item.question ?? ""),
            answer: String(item.answer ?? "(no answer)"),
            bestAnswer: String(
              item.bestAnswer || item.sampleBestAnswer || item.improvedAnswer || "",
            ),
          }))
      : [],
  });
}

async function gradeWithOpenAi(
  apiKey: string,
  prompt: string,
  integrity: number,
  includesCoding: boolean,
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
            "You grade technical interviews. Be evidence-based and strict. Output JSON only. For each question, include a sample bestAnswer rewritten from what the candidate actually said.",
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
  return parseScorecard(content, integrity, includesCoding);
}

async function gradeWithBedrock(prompt: string, integrity: number, includesCoding: boolean): Promise<Scorecard> {
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
        max_tokens: 3500,
        messages: [{ role: "user", content: prompt }],
      }),
    }),
  );
  const raw = JSON.parse(new TextDecoder().decode(res.body)) as {
    content?: { text?: string }[];
  };
  const text = raw.content?.[0]?.text;
  if (!text) throw new Error("bedrock_score_empty");
  return parseScorecard(text, integrity, includesCoding);
}

function emergencyHeuristic(input: {
  answered: number;
  includesCoding: boolean;
  unsolved: boolean;
  integrity: number;
}): ScoredResult {
  return {
    technical: Math.min(3, input.answered),
    communication: Math.min(3, input.answered),
    ...(input.includesCoding ? { codeQuality: input.unsolved ? 1 : 4 } : {}),
    integrity: input.integrity,
    hireRecommendation: "no",
    summary:
      "Emergency fallback only — AI grading failed. Do not trust these numbers; re-run scoring after fixing OpenAI/Bedrock access.",
    strengths: [],
    concerns: ["AI grading unavailable"],
    qaReview: [],
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
  const includesCoding = jobIncludesCoding(input.job) || Boolean(input.interview.codingTask);
  const task = includesCoding
    ? getCodingTask({
        codingTask: input.interview.codingTask ?? input.job.codingTask,
        seniority: input.job.seniority,
      })
    : null;
  const integrity = integrityScore(input.events);
  const unsolved = includesCoding && task
    ? isUnsolvedStarter(input.interview.submittedCode, task.starter)
    : false;
  const answered = input.turns.filter(
    (t) => t.role === "user" && t.text.trim().length >= 40,
  ).length;
  const turns = orderTranscriptTurns(input.turns);

  const prompt = buildGradingPrompt({
    job: input.job,
    interview: input.interview,
    turns,
    events: input.events,
    integrity,
    includesCoding,
    unsolved,
    taskTitle: task?.title ?? "",
    taskPrompt: task?.prompt ?? "",
    starter: task?.starter ?? "",
  });

  const withStarterGuard = (card: Scorecard, gradedBy: ScoreSource): ScoredResult => {
    if (includesCoding && unsolved && (card.codeQuality ?? 0) > 3) {
      return {
        ...card,
        codeQuality: Math.min(card.codeQuality ?? 0, 2),
        hireRecommendation:
          card.hireRecommendation === "yes" || card.hireRecommendation === "lean_yes"
            ? "lean_no"
            : card.hireRecommendation,
        concerns: [...card.concerns, "Code still looks like unfinished starter"],
        gradedBy,
      };
    }
    if (!includesCoding) {
      return { ...card, codeQuality: undefined, gradedBy };
    }
    return { ...card, gradedBy };
  };

  // Primary: Bedrock Claude (AWS-native)
  try {
    const card = await gradeWithBedrock(prompt, integrity, includesCoding);
    return withStarterGuard(card, "bedrock");
  } catch (err) {
    console.error("Bedrock grading failed", err);
  }

  // Backup: OpenAI
  const openaiKey = input.openaiKey || process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const card = await gradeWithOpenAi(openaiKey, prompt, integrity, includesCoding);
      return withStarterGuard(card, "openai");
    } catch (err) {
      console.error("OpenAI grading failed", err);
    }
  }

  return emergencyHeuristic({ answered, includesCoding, unsolved, integrity });
}
