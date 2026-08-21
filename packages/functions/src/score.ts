import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import {
  extractQaPairs,
  getCodingTask,
  jobIncludesCoding,
  orderTranscriptTurns,
  scorecardSchema,
  type IntegrityEvent,
  type Interview,
  type Job,
  type QaReviewItem,
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

function coerceScore(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(10, n));
}

function coerceHire(value: unknown): Scorecard["hireRecommendation"] {
  const raw = String(value ?? "no")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
  if (raw === "yes" || raw === "lean_yes" || raw === "lean_no" || raw === "no") return raw;
  return "no";
}

function mergeQaReview(
  pairs: { question: string; answer: string }[],
  reviews: QaReviewItem[] | undefined,
): QaReviewItem[] {
  if (!pairs.length) return reviews ?? [];
  const list = reviews ?? [];
  return pairs.map((pair, i) => {
    const hit = list[i];
    return {
      question: pair.question,
      answer: pair.answer || hit?.answer || "(no answer)",
      bestAnswer: hit?.bestAnswer?.trim() ?? "",
      ...(hit?.answerScore != null ? { answerScore: hit.answerScore } : {}),
      missed: hit?.missed ?? [],
    };
  });
}

function parseQaItems(raw: unknown): QaReviewItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item) => item && typeof item === "object")
    .map((item) => {
      const row = item as {
        question?: unknown;
        answer?: unknown;
        bestAnswer?: unknown;
        sampleBestAnswer?: unknown;
        improvedAnswer?: unknown;
        answerScore?: unknown;
        missed?: unknown;
      };
      const answerScore = coerceScore(row.answerScore, Number.NaN);
      return {
        question: String(row.question ?? ""),
        answer: String(row.answer ?? "(no answer)"),
        bestAnswer: String(row.bestAnswer || row.sampleBestAnswer || row.improvedAnswer || "").trim(),
        missed: Array.isArray(row.missed) ? row.missed.map((x) => String(x)).filter(Boolean) : [],
        ...(Number.isFinite(answerScore) ? { answerScore } : {}),
      };
    });
}

function parseScorecard(text: string, integrityFallback: number, includesCoding: boolean): Scorecard {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const json = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned) as Record<string, unknown>;
  return scorecardSchema.parse({
    technical: coerceScore(json.technical),
    communication: coerceScore(json.communication),
    codeQuality: includesCoding ? coerceScore(json.codeQuality) : undefined,
    integrity: coerceScore(json.integrity, integrityFallback),
    hireRecommendation: coerceHire(json.hireRecommendation),
    summary: String(json.summary ?? ""),
    strengths: Array.isArray(json.strengths) ? json.strengths.map((x) => String(x)) : [],
    concerns: Array.isArray(json.concerns) ? json.concerns.map((x) => String(x)) : [],
    qaReview: parseQaItems(json.qaReview),
  });
}

function codingBlock(input: {
  includesCoding: boolean;
  unsolved: boolean;
  taskTitle: string;
  taskPrompt: string;
  starter: string;
  submittedCode?: string;
}): string {
  if (!input.includesCoding) {
    return `This role has NO coding task. Omit codeQuality. Hire on voice evidence only.`;
  }
  return `Coding task: ${input.taskTitle}
Instructions:
${input.taskPrompt}

Starter:
\`\`\`
${input.starter}
\`\`\`

Submitted:
\`\`\`
${input.submittedCode || "(empty)"}
\`\`\`

Still on starter/TODOs: ${input.unsolved}
- codeQuality: unchanged starter = 0-2. Partial = 3-5. Working = 6-9. Excellent = 10.
- lean_yes/yes need both voice evidence AND a real coding attempt.`;
}

function buildOverallPrompt(input: {
  job: Job;
  turns: TranscriptTurn[];
  events: IntegrityEvent[];
  integrity: number;
  includesCoding: boolean;
  unsolved: boolean;
  taskTitle: string;
  taskPrompt: string;
  starter: string;
  submittedCode?: string;
}): string {
  return `Grade this IT interview. Evidence only. JSON only, no markdown.
{
  "technical": 0-10,
  "communication": 0-10,${input.includesCoding ? `\n  "codeQuality": 0-10,` : ""}
  "integrity": 0-10,
  "hireRecommendation": "yes" | "lean_yes" | "lean_no" | "no",
  "summary": "2-4 sentences",
  "strengths": ["..."],
  "concerns": ["..."]
}
Do not include qaReview. Grade Junior more gently than Staff. Integrity hint: ${input.integrity}.

Job: ${input.job.title} (${input.job.seniority ?? "mid"})
${input.job.description}

${codingBlock(input)}

Transcript:
${input.turns.map((t) => `${t.role}: ${t.text}`).join("\n") || "(none)"}

Integrity events:
${input.events.map((e) => `${e.at} ${e.type}`).join("\n") || "(none)"}`;
}

function buildQaPrompt(
  job: Job,
  pairs: { question: string; answer: string }[],
): string {
  const pairBlock = pairs
    .map((p, i) => `${i + 1}. Q: ${p.question}\n   A: ${p.answer}`)
    .join("\n\n");
  return `For EVERY numbered pair, write a measuring-stick answer a strong ${job.seniority ?? "mid"} hire would give. Grade CONTENT not wording. Do not rephrase the candidate.

Job: ${job.title} (${job.seniority ?? "mid"})
${job.description}

Return ONLY JSON:
{
  "qaReview": [
    {
      "question": "copy",
      "answer": "copy",
      "answerScore": 0-10,
      "missed": ["technical point omitted"],
      "bestAnswer": "2-4 sentences: approach, steps, tradeoffs, how you'd know it worked"
    }
  ]
}

qaReview MUST have EXACTLY ${pairs.length} items in this order. Every bestAnswer must be non-empty. Keep bestAnswer compact.

Pairs:
${pairBlock}`;
}

async function invokeBedrock(prompt: string, maxTokens: number): Promise<string> {
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
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    }),
  );
  const raw = JSON.parse(new TextDecoder().decode(res.body)) as {
    content?: { text?: string }[];
  };
  const text = raw.content?.[0]?.text;
  if (!text) throw new Error("bedrock_score_empty");
  return text;
}

async function invokeOpenAi(apiKey: string, prompt: string, maxTokens: number): Promise<string> {
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
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You grade technical interviews. JSON only. Be strict and evidence-based.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) throw new Error(`openai_score_failed: ${await res.text()}`);
  const data = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("openai_score_empty");
  return content;
}

async function gradeProvider(input: {
  overallPrompt: string;
  qaPrompt: string | null;
  integrity: number;
  includesCoding: boolean;
  pairs: { question: string; answer: string }[];
  provider: "bedrock" | "openai";
  openaiKey?: string;
}): Promise<Scorecard> {
  const invoke =
    input.provider === "bedrock"
      ? (prompt: string, max: number) => invokeBedrock(prompt, max)
      : (prompt: string, max: number) => invokeOpenAi(input.openaiKey!, prompt, max);

  const overallP = invoke(input.overallPrompt, 1200);
  const qaP = input.qaPrompt
    ? invoke(input.qaPrompt, 3500).catch((err) => {
        console.error(`${input.provider} qaReview failed`, err);
        return null;
      })
    : Promise.resolve(null);

  const [overallText, qaText] = await Promise.all([overallP, qaP]);
  const card = parseScorecard(overallText, input.integrity, input.includesCoding);
  const qaItems = qaText ? parseQaItems(parseLooseArray(qaText)) : card.qaReview;
  return {
    ...card,
    qaReview: mergeQaReview(input.pairs, qaItems),
  };
}

function parseLooseArray(text: string): unknown {
  try {
    const cleaned = text.replace(/```json|```/g, "").trim();
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const json = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned) as {
      qaReview?: unknown;
    };
    return json.qaReview;
  } catch (err) {
    console.error("qaReview JSON parse failed", err);
    return [];
  }
}

function applyStarterGuard(
  card: Scorecard,
  gradedBy: ScoreSource,
  includesCoding: boolean,
  unsolved: boolean,
): ScoredResult {
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
  if (!includesCoding) return { ...card, codeQuality: undefined, gradedBy };
  return { ...card, gradedBy };
}

function emergencyHeuristic(input: {
  answered: number;
  includesCoding: boolean;
  unsolved: boolean;
  integrity: number;
  pairs: { question: string; answer: string }[];
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
    qaReview: mergeQaReview(input.pairs, []),
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
  try {
    const includesCoding = jobIncludesCoding(input.job) || Boolean(input.interview.codingTask);
    const task = includesCoding
      ? getCodingTask({
          codingTask: input.interview.codingTask ?? input.job.codingTask,
          seniority: input.job.seniority,
        })
      : null;
    const integrity = integrityScore(input.events);
    const unsolved =
      includesCoding && task
        ? isUnsolvedStarter(input.interview.submittedCode, task.starter)
        : false;
    const answered = input.turns.filter((t) => t.role === "user" && t.text.trim().length >= 40).length;
    const turns = orderTranscriptTurns(input.turns);
    const pairs = extractQaPairs(turns);
    const coding = {
      includesCoding,
      unsolved,
      taskTitle: task?.title ?? "",
      taskPrompt: task?.prompt ?? "",
      starter: task?.starter ?? "",
      submittedCode: input.interview.submittedCode,
    };
    const overallPrompt = buildOverallPrompt({
      job: input.job,
      turns,
      events: input.events,
      integrity,
      ...coding,
    });
    const qaPrompt = pairs.length ? buildQaPrompt(input.job, pairs) : null;
    const openaiKey = input.openaiKey || process.env.OPENAI_API_KEY;

    try {
      const card = await gradeProvider({
        overallPrompt,
        qaPrompt,
        integrity,
        includesCoding,
        pairs,
        provider: "bedrock",
        openaiKey,
      });
      return applyStarterGuard(card, "bedrock", includesCoding, unsolved);
    } catch (err) {
      console.error("Bedrock grading failed", err);
    }

    if (openaiKey) {
      try {
        const card = await gradeProvider({
          overallPrompt,
          qaPrompt,
          integrity,
          includesCoding,
          pairs,
          provider: "openai",
          openaiKey,
        });
        return applyStarterGuard(card, "openai", includesCoding, unsolved);
      } catch (err) {
        console.error("OpenAI grading failed", err);
      }
    }

    return emergencyHeuristic({ answered, includesCoding, unsolved, integrity, pairs });
  } catch (err) {
    console.error("scoreInterview crashed", err);
    return emergencyHeuristic({
      answered: 0,
      includesCoding: jobIncludesCoding(input.job) || Boolean(input.interview.codingTask),
      unsolved: true,
      integrity: integrityScore(input.events),
      pairs: extractQaPairs(orderTranscriptTurns(input.turns)),
    });
  }
}
