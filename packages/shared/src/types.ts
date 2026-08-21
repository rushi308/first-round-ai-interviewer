import { z } from "zod";

export const SENIORITY_LEVELS = ["junior", "mid", "senior", "staff"] as const;
export type Seniority = (typeof SENIORITY_LEVELS)[number];

export const interviewStatuses = [
  "created",
  "in_voice",
  "in_coding",
  "completed",
  "scoring",
  "scored",
] as const;
export type InterviewStatus = (typeof interviewStatuses)[number];

export const codingTaskSchema = z.object({
  title: z.string(),
  prompt: z.string(),
  starter: z.string(),
  language: z.string(),
});
export type CodingTask = z.infer<typeof codingTaskSchema>;

export const jobSchema = z.object({
  jobId: z.string(),
  title: z.string().min(2),
  description: z.string().min(10),
  seniority: z.enum(SENIORITY_LEVELS).default("mid"),
  codingRequired: z.boolean().default(true),
  codingTask: codingTaskSchema.optional(),
  createdAt: z.string(),
});
export type Job = z.infer<typeof jobSchema>;

export const candidateSchema = z.object({
  candidateId: z.string(),
  name: z.string().min(1),
  email: z.string().email().optional(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const createJobInput = z.object({
  title: z.string().min(2),
  description: z.string().min(10),
  seniority: z.enum(SENIORITY_LEVELS).default("mid"),
  codingRequired: z.boolean().default(true),
});

export const createInterviewInput = z.object({
  jobId: z.string(),
  candidateName: z.string().min(1),
  candidateEmail: z.string().email().optional(),
});

export const integrityEventTypes = [
  "tab_hidden",
  "tab_visible",
  "fullscreen_exit",
  "fullscreen_enter",
  "no_face",
  "multi_face",
  "face_ok",
  "paste_attempt",
  "copy_attempt",
] as const;
export type IntegrityEventType = (typeof integrityEventTypes)[number];

export const integrityEventSchema = z.object({
  type: z.enum(integrityEventTypes),
  at: z.string(),
  detail: z.string().optional(),
});
export type IntegrityEvent = z.infer<typeof integrityEventSchema>;

export const transcriptTurnSchema = z.object({
  role: z.enum(["assistant", "user"]),
  text: z.string(),
  at: z.string(),
});
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

export const qaReviewItemSchema = z.object({
  question: z.string(),
  answer: z.string(),
  bestAnswer: z.string(),
});
export type QaReviewItem = z.infer<typeof qaReviewItemSchema>;

export const scorecardSchema = z.object({
  technical: z.number().min(0).max(10),
  communication: z.number().min(0).max(10),
  codeQuality: z.number().min(0).max(10).optional(),
  integrity: z.number().min(0).max(10),
  hireRecommendation: z.enum(["yes", "lean_yes", "lean_no", "no"]),
  summary: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  qaReview: z.array(qaReviewItemSchema).optional(),
  gradedBy: z.enum(["openai", "bedrock", "heuristic"]).optional(),
});
export type Scorecard = z.infer<typeof scorecardSchema>;

export const interviewSchema = z.object({
  interviewId: z.string(),
  jobId: z.string(),
  candidate: candidateSchema,
  token: z.string(),
  status: z.enum(interviewStatuses),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  submittedCode: z.string().optional(),
  codingTask: codingTaskSchema.optional(),
  scorecard: scorecardSchema.optional(),
  webcamKey: z.string().optional(),
  screenKey: z.string().optional(),
});
export type Interview = z.infer<typeof interviewSchema>;

export const VOICE_DURATION_MS = 15 * 60 * 1000;
export const VOICE_MAX_MS = 20 * 60 * 1000;
export const VOICE_WRAP_GRACE_MS = 90 * 1000;
export const CODING_DURATION_MS = 5 * 60 * 1000;

export function jobIncludesCoding(job: { codingRequired?: boolean; codingTask?: CodingTask }): boolean {
  if (job.codingRequired === false) return false;
  if (job.codingRequired === true) return true;
  return Boolean(job.codingTask);
}

export const SENIORITY_LABELS: Record<Seniority, string> = {
  junior: "Junior",
  mid: "Mid-level",
  senior: "Senior",
  staff: "Staff / Principal",
};
