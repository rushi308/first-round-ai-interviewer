import type { IntegrityEvent, Interview, Job, TranscriptTurn } from "@ai-interviewer/shared";
import type { Store } from "./store.js";

export class MemoryStore implements Store {
  jobs = new Map<string, Job>();
  interviews = new Map<string, Interview>();
  tokens = new Map<string, string>();
  turns = new Map<string, TranscriptTurn[]>();
  events = new Map<string, IntegrityEvent[]>();

  async putJob(job: Job) {
    this.jobs.set(job.jobId, job);
  }
  async getJob(jobId: string) {
    return this.jobs.get(jobId) ?? null;
  }
  async listJobs() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async putInterview(interview: Interview) {
    this.interviews.set(interview.interviewId, interview);
    this.tokens.set(interview.token, interview.interviewId);
  }
  async getInterview(interviewId: string) {
    return this.interviews.get(interviewId) ?? null;
  }
  async getInterviewByToken(token: string) {
    const id = this.tokens.get(token);
    return id ? this.getInterview(id) : null;
  }
  async listInterviews() {
    return [...this.interviews.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async appendTurn(interviewId: string, turn: TranscriptTurn) {
    const list = this.turns.get(interviewId) ?? [];
    list.push(turn);
    this.turns.set(interviewId, list);
  }
  async listTurns(interviewId: string) {
    return this.turns.get(interviewId) ?? [];
  }
  async appendEvent(interviewId: string, event: IntegrityEvent) {
    const list = this.events.get(interviewId) ?? [];
    list.push(event);
    this.events.set(interviewId, list);
  }
  async listEvents(interviewId: string) {
    return this.events.get(interviewId) ?? [];
  }
}

export const memoryStore = new MemoryStore();
