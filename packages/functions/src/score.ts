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

function buildGradingPrompt(input: {
  job: Job;
  interview: Interview;
  turns: TranscriptTurn[];
  pairs: { question: string; answer: string }[];
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

  const pairBlock =
    input.pairs.length === 0
      ? "(no question/answer pairs extracted)"
      : input.pairs
          .map(
            (p, i) =>
              `${i + 1}. Question: ${p.question}\n   Candidate answer: ${p.answer}`,
          )
          .join("\n\n");

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
    { "question": "...", "answer": "...", "answerScore": 0-10, "missed": ["..."], "bestAnswer": "..." },
    { "question": "...", "answer": "...", "answerScore": 0-10, "missed": ["..."], "bestAnswer": "..." }
  ]
}

Scoring guidance:
- technical: correctness/depth of spoken answers vs the JD and seniority. Thin or missing answers must score low. Grade a Junior more gently than Staff.
- communication: clarity, structure, relevance — not friendliness alone.
- integrity: start from the hint (${input.integrity}); lower for many tab_hidden, fullscreen_exit, no_face, multi_face, paste_attempt events.
- qaReview MUST contain EXACTLY ${input.pairs.length} items, one per numbered pair below, in the same order. Do not skip, merge, or stop after the first. Copy question and answer from each pair.
- qaReview.answerScore: grade CONTENT only vs a strong ${input.job.seniority ?? "mid"} hire for this JD. Fluency/wording does not raise the score. Vague, incomplete, or wrong answers score low even if they "sound fine".
- qaReview.missed: 2-4 short bullets of technical substance a strong answer includes that they did not cover. Empty only if the answer was already complete.
- qaReview.bestAnswer: the measuring-stick answer for THAT pair — what a strong ${input.job.seniority ?? "mid"} hire would actually say (approach, key steps, tradeoffs, failure modes). Do NOT rephrase the candidate. 3-6 sentences. Keep each bestAnswer compact so every pair is graded.
${codingBlock}

Job title: ${input.job.title}
Seniority: ${input.job.seniority ?? "mid"}
Job description:
${input.job.description}

Required question/answer pairs (${input.pairs.length} — grade ALL of them):
${pairBlock}

Full transcript (assistant = AI interviewer, user = candidate):
${input.turns.map((t) => `${t.role}: ${t.text}`).join("\n") || "(no transcript captured)"}

Integrity events:
${input.events.map((e) => `${e.at} ${e.type}${e.detail ? ` ${e.detail}` : ""}`).join("\n") || "(none)"}
`;
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
      bestAnswer: hit?.bestAnswer ?? "",
      ...(hit?.answerScore != null ? { answerScore: hit.answerScore } : {}),
      missed: hit?.missed ?? [],
    };
  });
}

function buildQaChunkPrompt(
  job: Job,
  pairs: { question: string; answer: string }[],
): string {
  const pairBlock = pairs
    .map((p, i) => `${i + 1}. Question: ${p.question}\n   Candidate answer: ${p.answer}`)
    .join("\n\n");
  return `You are an expert technical hiring interviewer.
For EACH numbered pair, write a real measuring-stick answer a strong ${job.seniority ?? "mid"} hire would give for this role. Do not rephrase the candidate. Grade content, not wording.

Job title: ${job.title}
Seniority: ${job.seniority ?? "mid"}
Job description:
${job.description}

Return ONLY JSON:
{
  "qaReview": [
    {
      "question": "copy from pair",
      "answer": "copy from pair",
      "answerScore": 0-10,
      "missed": ["key technical point they omitted"],
      "bestAnswer": "3-6 sentence spoken answer with approach, steps, tradeoffs, failure modes"
    }
  ]
}

qaReview MUST have EXACTLY ${pairs.length} items, in the same order. Every item MUST include a non-empty bestAnswer.

Pairs:
${pairBlock}`;
}

async function gradeQaChunk(
  job: Job,
  pairs: { question: string; answer: string }[],
  openaiKey?: string,
): Promise<QaReviewItem[]> {
  if (!pairs.length) return [];
  const prompt = buildQaChunkPrompt(job, pairs);
  try {
    const card = await gradeWithBedrock(prompt, 0, false);
    if (card.qaReview?.length) return card.qaReview;
  } catch (err) {
    console.error("Bedrock Q&A chunk failed", err);
  }
  if (openaiKey) {
    try {
      const card = await gradeWithOpenAi(openaiKey, prompt, 0, false);
      if (card.qaReview?.length) return card.qaReview;
    } catch (err) {
      console.error("OpenAI Q&A chunk failed", err);
    }
  }
  return [];
}

async function ensureStrongAnswers(
  job: Job,
  pairs: { question: string; answer: string }[],
  reviews: QaReviewItem[] | undefined,
  openaiKey?: string,
): Promise<QaReviewItem[]> {
  let merged = mergeQaReview(pairs, reviews);
  const chunkSize = 2;
  for (let pass = 0; pass < 12; pass++) {
    const missing = merged
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => !item.bestAnswer.trim());
    if (!missing.length) break;
    const chunk = missing.slice(0, chunkSize);
    const filled = await gradeQaChunk(
      job,
      chunk.map(({ index }) => pairs[index]),
      openaiKey,
    );
    let wrote = false;
    chunk.forEach(({ index }, j) => {
      const hit = filled[j];
      if (!hit?.bestAnswer?.trim()) return;
      wrote = true;
      merged[index] = {
        ...merged[index],
        bestAnswer: hit.bestAnswer.trim(),
        answerScore: hit.answerScore ?? merged[index].answerScore,
        missed: hit.missed?.length ? hit.missed : merged[index].missed,
      };
    });
    if (!wrote) break;
  }
  return merged;
}

function parseScorecard(text: string, integrityFallback: number, includesCoding: boolean): Scorecard {
  const cleaned = text.replace(/```json|```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  const json = JSON.parse(start >= 0 ? cleaned.slice(start, end + 1) : cleaned);
  return scorecardSchema.parse({
    technical: 0,
    communication: 0,
    hireRecommendation: "no",
    summary: "",
    strengths: [],
    concerns: [],
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
            answerScore?: unknown;
            missed?: unknown;
          }) => ({
            question: String(item.question ?? ""),
            answer: String(item.answer ?? "(no answer)"),
            bestAnswer: String(
              item.bestAnswer || item.sampleBestAnswer || item.improvedAnswer || "",
            ),
            answerScore:
              typeof item.answerScore === "number" && Number.isFinite(item.answerScore)
                ? Math.max(0, Math.min(10, item.answerScore))
                : undefined,
            missed: Array.isArray(item.missed)
              ? item.missed.map((x) => String(x)).filter(Boolean)
              : [],
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
      max_tokens: 8000,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You grade technical interviews. Be evidence-based and strict. Output JSON only. qaReview must include every numbered question/answer pair — never only the first.",
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
        max_tokens: 8000,
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
  const pairs = extractQaPairs(turns);

  const prompt = buildGradingPrompt({
    job: input.job,
    interview: input.interview,
    turns,
    pairs,
    events: input.events,
    integrity,
    includesCoding,
    unsolved,
    taskTitle: task?.title ?? "",
    taskPrompt: task?.prompt ?? "",
    starter: task?.starter ?? "",
  });

  const openaiKey = input.openaiKey || process.env.OPENAI_API_KEY;

  const withStarterGuard = async (
    card: Scorecard,
    gradedBy: ScoreSource,
  ): Promise<ScoredResult> => {
    const qaReview = await ensureStrongAnswers(input.job, pairs, card.qaReview, openaiKey);
    if (includesCoding && unsolved && (card.codeQuality ?? 0) > 3) {
      return {
        ...card,
        qaReview,
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
      return { ...card, codeQuality: undefined, qaReview, gradedBy };
    }
    return { ...card, qaReview, gradedBy };
  };

  // Primary: Bedrock Claude (AWS-native)
  try {
    const card = await gradeWithBedrock(prompt, integrity, includesCoding);
    return await withStarterGuard(card, "bedrock");
  } catch (err) {
    console.error("Bedrock grading failed", err);
  }

  // Backup: OpenAI
  if (openaiKey) {
    try {
      const card = await gradeWithOpenAi(openaiKey, prompt, integrity, includesCoding);
      return await withStarterGuard(card, "openai");
    } catch (err) {
      console.error("OpenAI grading failed", err);
    }
  }

  const fallback = emergencyHeuristic({ answered, includesCoding, unsolved, integrity, pairs });
  return {
    ...fallback,
    qaReview: await ensureStrongAnswers(input.job, pairs, fallback.qaReview, openaiKey),
  };
}
