import type {
  Candidate,
  IntegrityEvent,
  Interview,
  Job,
  Scorecard,
  TranscriptTurn,
} from "@ai-interviewer/shared";

export interface Store {
  putJob(job: Job): Promise<void>;
  getJob(jobId: string): Promise<Job | null>;
  listJobs(): Promise<Job[]>;
  putInterview(interview: Interview): Promise<void>;
  getInterview(interviewId: string): Promise<Interview | null>;
  getInterviewByToken(token: string): Promise<Interview | null>;
  listInterviews(): Promise<Interview[]>;
  appendTurn(interviewId: string, turn: TranscriptTurn): Promise<void>;
  listTurns(interviewId: string): Promise<TranscriptTurn[]>;
  appendEvent(interviewId: string, event: IntegrityEvent): Promise<void>;
  listEvents(interviewId: string): Promise<IntegrityEvent[]>;
}

export type { Candidate };
