"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import {
  SENIORITY_LABELS,
  extractQaPairs,
  jobIncludesCoding,
  orderTranscriptTurns,
  type IntegrityEvent,
  type Interview,
  type Job,
  type TranscriptTurn,
} from "@ai-interviewer/shared";
import { AppHeader } from "@/components/ui/AppHeader";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { AI_NAME } from "@/lib/brand";

export default function ScorecardPage() {
  const params = useParams<{ interviewId: string }>();
  const toast = useToast();
  const [data, setData] = useState<{
    interview: Interview;
    job: Job | null;
    turns: TranscriptTurn[];
    events: IntegrityEvent[];
  } | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    const res = await api<typeof data>(`/interviews/${params.interviewId}`);
    setData(res);
  }

  useEffect(() => {
    void load();
  }, [params.interviewId]);

  async function score() {
    setBusy(true);
    try {
      await api(`/interviews/${params.interviewId}/score`, { method: "POST" });
      await load();
      toast.success("Scorecard ready", "Riley’s report is updated.");
    } catch (err) {
      toast.error("Scoring failed", err instanceof Error ? err.message : "Try again");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return <main className="p-10 text-[var(--studio-muted)]">Loading…</main>;
  }
  const { interview, job, events } = data;
  const turns = orderTranscriptTurns(data.turns);
  const s = interview.scorecard;
  const includesCoding = job ? jobIncludesCoding(job) : Boolean(interview.codingTask);
  const qaPairs = extractQaPairs(turns);
  const qaReview =
    qaPairs.length > 0
      ? qaPairs.map((pair, i) => {
          const hit = s?.qaReview?.[i];
          return {
            question: pair.question,
            answer: pair.answer || hit?.answer || "(no answer)",
            bestAnswer: hit?.bestAnswer ?? "",
            answerScore: hit?.answerScore,
            missed: hit?.missed ?? [],
          };
        })
      : (s?.qaReview ?? []);
  const recLabel: Record<string, string> = {
    yes: "Hire",
    lean_yes: "Lean hire",
    lean_no: "Lean no",
    no: "No hire",
  };

  return (
    <main className="min-h-screen">
      <AppHeader
        right={
          <Link href="/app" className="text-sm font-medium text-[var(--studio-muted)]">
            ← Dashboard
          </Link>
        }
      />
      <div className="mx-auto max-w-5xl px-6 pb-16">
      <p className="mono text-xs text-[var(--studio-muted)]">{interview.interviewId}</p>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-center gap-4">
          <Avatar name={interview.candidate.name} size="lg" />
          <div>
            <h1 className="text-3xl font-semibold tracking-tight">{interview.candidate.name}</h1>
            <p className="mt-1 text-[var(--studio-muted)]">
              {job?.title ?? "Unknown role"} · {job ? SENIORITY_LABELS[job.seniority ?? "mid"] : ""}
            </p>
          </div>
        </div>
        <button className="btn-primary px-5 py-2.5 text-sm" onClick={() => void score()} disabled={busy}>
          {busy ? "Scoring…" : s ? "Re-run scorecard" : "Run scorecard"}
        </button>
      </div>

      {s ? (
        <section className={`mt-8 grid gap-4 ${includesCoding && s.codeQuality != null ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
          {([
            ["Technical", s.technical],
            ["Communication", s.communication],
            ...(includesCoding && s.codeQuality != null
              ? ([["Code", s.codeQuality]] as [string, number][])
              : []),
            ["Integrity", s.integrity],
          ] as [string, number][]).map(([label, value]) => (
            <div key={String(label)} className="card p-5">
              <p className="text-sm text-[var(--studio-muted)]">{label}</p>
              <p className="mt-1 text-3xl font-semibold tracking-tight">{value}/10</p>
            </div>
          ))}
          <div className={`card p-6 ${includesCoding && s.codeQuality != null ? "md:col-span-4" : "md:col-span-3"}`}>
            <div className="flex flex-wrap items-center gap-3">
              <span className="badge">{recLabel[s.hireRecommendation] ?? s.hireRecommendation}</span>
              {s.gradedBy ? (
                <span className="text-xs font-medium text-[var(--studio-muted)]">Graded by {s.gradedBy}</span>
              ) : null}
            </div>
            <p className="mt-3 leading-relaxed text-[var(--studio-muted)]">{s.summary}</p>
            <div className="mt-4 grid gap-6 md:grid-cols-2">
              {s.strengths?.length ? (
                <div>
                  <p className="text-sm font-semibold text-[var(--good)]">Strengths</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {s.strengths.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {s.concerns?.length ? (
                <div>
                  <p className="text-sm font-semibold text-[var(--bad)]">Concerns</p>
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm">
                    {s.concerns.map((x) => (
                      <li key={x}>{x}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          </div>
        </section>
      ) : (
        <div className="card mt-8 p-8 text-[var(--studio-muted)]">
          Run the scorecard after the candidate finishes. Riley grades voice answers against the JD
          {includesCoding ? " and the coding submission against the starter" : ""}.
        </div>
      )}

      {qaReview.length ? (
        <section className="mt-8">
          <h2 className="text-lg font-semibold">Questions & answers</h2>
          <p className="mt-1 text-sm text-[var(--studio-muted)]">
            {qaReview.length} question{qaReview.length === 1 ? "" : "s"} from the transcript, each scored against a strong hire — not nicer wording.
          </p>
          <div className="mt-4 space-y-4">
            {qaReview.map((item, i) => (
              <article key={`${item.question}-${i}`} className="card p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold uppercase tracking-wide text-[#9cb8ff]">
                      Question {i + 1}
                    </p>
                    <p className="mt-1 font-medium leading-relaxed">{item.question}</p>
                  </div>
                  {item.answerScore != null ? (
                    <span className="shrink-0 rounded-full bg-white/8 px-3 py-1 text-sm font-semibold">
                      {item.answerScore}/10
                    </span>
                  ) : null}
                </div>
                <div className="mt-4 space-y-3">
                  <div className="rounded-2xl bg-black/20 px-4 py-3">
                    <p className="text-xs font-semibold text-[var(--studio-muted)]">Candidate answer</p>
                    <p className="mt-1.5 text-sm leading-relaxed">{item.answer || "(no answer)"}</p>
                  </div>
                  {item.missed?.length ? (
                    <div className="rounded-2xl bg-black/20 px-4 py-3">
                      <p className="text-xs font-semibold text-[var(--bad)]">What a strong answer includes that they missed</p>
                      <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed">
                        {item.missed.map((gap) => (
                          <li key={gap}>{gap}</li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                  <div className="rounded-2xl border border-[#143d2e] bg-[#0d1f18] px-4 py-3">
                    <p className="text-xs font-semibold text-[var(--good)]">
                      Strong answer (measuring stick)
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--studio-muted)]">
                      What a strong hire would actually say — used to score the answer above.
                    </p>
                    <p className="mt-1.5 text-sm leading-relaxed">
                      {item.bestAnswer || "Re-run the scorecard to generate a strong answer for this question."}
                    </p>
                  </div>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-8 grid gap-6 md:grid-cols-2">
        <div className="card p-5">
          <h2 className="font-semibold">Transcript</h2>
          <div className="mt-4 max-h-80 space-y-3 overflow-auto">
            {turns.length === 0 ? (
              <p className="text-sm text-[var(--studio-muted)]">No transcript yet.</p>
            ) : (
              turns.map((t, i) => (
                <div key={i} className="flex items-start gap-3 rounded-2xl bg-black/20 px-3 py-2 text-sm">
                  <Avatar
                    name={t.role === "assistant" ? AI_NAME : interview.candidate.name}
                    size="sm"
                    accent={t.role === "assistant"}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-semibold text-[#9cb8ff]">
                      {t.role === "assistant" ? AI_NAME : "Candidate"}
                    </p>
                    <p className="mt-1 leading-relaxed">{t.text}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
        <div className="card p-5">
          <h2 className="font-semibold">Integrity events</h2>
          <div className="mt-4 max-h-80 space-y-2 overflow-auto">
            {events.length === 0 ? (
              <p className="text-sm text-[var(--studio-muted)]">No flags recorded.</p>
            ) : (
              events.map((e, i) => (
                <p key={i} className="mono text-xs text-[var(--studio-muted)]">
                  {e.type} · {new Date(e.at).toLocaleTimeString()}
                </p>
              ))
            )}
          </div>
        </div>
      </section>

      {includesCoding && interview.submittedCode ? (
        <pre className="mono mt-8 overflow-auto rounded-3xl border border-[var(--studio-line)] bg-[#0c0f14] p-5 text-sm">
          {interview.submittedCode}
        </pre>
      ) : null}
      </div>
    </main>
  );
}
