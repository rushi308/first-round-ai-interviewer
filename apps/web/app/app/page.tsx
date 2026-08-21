"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
  SENIORITY_LABELS,
  jobIncludesCoding,
  type Interview,
  type Job,
  type Seniority,
} from "@ai-interviewer/shared";
import { AppHeader } from "@/components/ui/AppHeader";
import { Avatar } from "@/components/ui/Avatar";
import { useToast } from "@/components/ui/Toast";
import { api } from "@/lib/api";
import { currentRecruiter, logout } from "@/lib/auth";

export default function DashboardPage() {
  const router = useRouter();
  const toast = useToast();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [interviews, setInterviews] = useState<Interview[]>([]);
  const [title, setTitle] = useState("Senior Frontend Engineer");
  const [description, setDescription] = useState(
    "Build React + TypeScript product UI. Strong hooks, performance, and testing.",
  );
  const [seniority, setSeniority] = useState<Seniority>("mid");
  const [codingRequired, setCodingRequired] = useState(true);
  const [creating, setCreating] = useState(false);
  const [candidateName, setCandidateName] = useState("");
  const [jobId, setJobId] = useState("");
  const [link, setLink] = useState<string | null>(null);

  useEffect(() => {
    if (!currentRecruiter()) router.replace("/login");
    void refresh();
  }, [router]);

  async function refresh() {
    const [j, i] = await Promise.all([api<Job[]>("/jobs"), api<Interview[]>("/interviews")]);
    setJobs(j);
    setInterviews(i);
    if (!jobId && j[0]) setJobId(j[0].jobId);
  }

  async function createJob(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      const job = await api<Job>("/jobs", {
        method: "POST",
        body: JSON.stringify({ title, description, seniority, codingRequired }),
      });
      setJobId(job.jobId);
      toast.success(
        "Role created",
        codingRequired ? "Riley and the coding task will follow this JD." : "Riley will run a voice-only interview from this JD.",
      );
      await refresh();
    } catch (err) {
      toast.error("Couldn’t create role", err instanceof Error ? err.message : "Try again");
    } finally {
      setCreating(false);
    }
  }

  async function createInterview(e: React.FormEvent) {
    e.preventDefault();
    try {
      const created = await api<Interview & { url: string }>("/interviews", {
        method: "POST",
        body: JSON.stringify({ jobId, candidateName }),
      });
      setLink(created.url);
      setCandidateName("");
      toast.success("Invite ready", "Copy the link and share it with the candidate.");
      await refresh();
    } catch (err) {
      toast.error("Couldn’t create invite", err instanceof Error ? err.message : "Try again");
    }
  }

  async function copyLink() {
    if (!link) return;
    await navigator.clipboard.writeText(link);
    toast.success("Link copied", "Share it in Slack, WhatsApp, or your portal.");
  }

  const jobsById = new Map(jobs.map((j) => [j.jobId, j]));

  const statusLabel: Record<string, string> = {
    created: "Invited",
    in_voice: "Voice",
    in_coding: "Coding",
    completed: "Submitted",
    scoring: "Scoring",
    scored: "Scored",
  };

  return (
    <main className="min-h-screen">
      <AppHeader
        subtitle="Create a role, send a link, review the scorecard."
        right={
          <button
            className="btn-secondary px-4 py-2 text-sm"
            onClick={() => {
              logout();
              router.push("/login");
            }}
          >
            Log out
          </button>
        }
      />
      <div className="mx-auto max-w-6xl px-6 pb-16">
        <h1 className="text-3xl font-semibold tracking-tight">Recruiter dashboard</h1>
        <p className="mt-1 text-sm text-[var(--studio-muted)]">Riley joins the room with every candidate.</p>

      <section className="mt-8 grid gap-6 md:grid-cols-2">
        <form onSubmit={createJob} className="card p-7">
          <h2 className="text-lg font-semibold">New role</h2>
          <p className="mt-1 text-sm text-[var(--studio-muted)]">Riley interviews from the JD you paste.</p>
          <div className="mt-5">
            <label className="label">Job title</label>
            <input
              className="input"
              placeholder="Job title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>
          <div className="mt-3">
            <label className="label">Job description</label>
            <textarea
              className="input h-28 resize-none"
              placeholder="Paste the job description. Riley interviews from this."
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div className="mt-3">
            <label className="label">Seniority</label>
            <select
              className="input"
              value={seniority}
              onChange={(e) => setSeniority(e.target.value as Seniority)}
            >
              {Object.entries(SENIORITY_LABELS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <label className="mt-4 flex cursor-pointer items-start gap-3 rounded-2xl border border-[var(--studio-line)] bg-black/20 px-4 py-3">
            <input
              type="checkbox"
              className="mt-1"
              checked={codingRequired}
              onChange={(e) => setCodingRequired(e.target.checked)}
            />
            <span>
              <span className="block text-sm font-medium">Include a coding task</span>
              <span className="mt-0.5 block text-xs text-[var(--studio-muted)]">
                Uncheck for a 15–20 minute voice-only interview. No coding score or task will be generated.
              </span>
            </span>
          </label>
          <button className="btn-primary mt-5 px-5 py-2.5 text-sm" disabled={creating}>
            {creating ? "Creating…" : "Create role"}
          </button>
        </form>

        <form onSubmit={createInterview} className="card p-7">
          <h2 className="text-lg font-semibold">Invite candidate</h2>
          <p className="mt-1 text-sm text-[var(--studio-muted)]">No email is sent. Copy the link and share it.</p>
          <div className="mt-5">
            <label className="label">Role</label>
            <select className="input" value={jobId} onChange={(e) => setJobId(e.target.value)}>
              <option value="">Select role</option>
              {jobs.map((j) => (
                <option key={j.jobId} value={j.jobId}>
                  {j.title} · {SENIORITY_LABELS[j.seniority ?? "mid"]}
                </option>
              ))}
            </select>
          </div>
          <div className="mt-3">
            <label className="label">Candidate name</label>
            <input
              className="input"
              placeholder="Candidate name"
              value={candidateName}
              onChange={(e) => setCandidateName(e.target.value)}
              required
            />
          </div>
          <button className="btn-secondary mt-5 px-5 py-2.5 text-sm" type="submit">
            Generate interview link
          </button>
          {link ? (
            <div className="mt-5 rounded-2xl bg-black/25 p-4 text-sm">
              <p className="text-[var(--studio-muted)]">Share this URL</p>
              <p className="mono mt-2 break-all text-xs">{link}</p>
              <button type="button" className="mt-3 font-semibold text-[var(--accent)]" onClick={() => void copyLink()}>
                Copy link
              </button>
            </div>
          ) : null}
        </form>
      </section>

      <section className="mt-10">
        <div className="flex items-end justify-between">
          <h2 className="text-lg font-semibold">Candidates</h2>
          <p className="text-sm text-[var(--studio-muted)]">{interviews.length} interviews</p>
        </div>
        <div className="card mt-4 overflow-hidden">
          <table className="w-full text-left text-sm">
            <thead className="bg-black/20 text-[var(--studio-muted)]">
              <tr>
                <th className="px-5 py-3 font-medium">Candidate</th>
                <th className="font-medium">Role</th>
                <th className="font-medium">Status</th>
                <th className="font-medium">Created</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {interviews.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-5 py-10 text-center text-[var(--studio-muted)]">
                    No candidates yet. Create a role and generate a link.
                  </td>
                </tr>
              ) : null}
              {interviews.map((iv) => {
                const job = jobsById.get(iv.jobId);
                return (
                  <tr key={iv.interviewId} className="border-t border-[var(--studio-line)]">
                    <td className="px-5 py-3.5">
                      <span className="inline-flex items-center gap-3 font-medium">
                        <Avatar name={iv.candidate.name} size="sm" />
                        {iv.candidate.name}
                      </span>
                    </td>
                    <td>
                      <p>{job?.title ?? "Unknown role"}</p>
                      {job ? (
                        <p className="text-xs text-[var(--studio-muted)]">
                          {SENIORITY_LABELS[job.seniority ?? "mid"]}
                          {jobIncludesCoding(job) ? "" : " · Voice only"}
                        </p>
                      ) : null}
                    </td>
                    <td>
                      <span className="badge">{statusLabel[iv.status] ?? iv.status}</span>
                    </td>
                    <td className="text-[var(--studio-muted)]">{new Date(iv.createdAt).toLocaleString()}</td>
                    <td className="px-5">
                      <Link className="font-semibold text-[#9cb8ff]" href={`/app/interviews/${iv.interviewId}`}>
                        Scorecard
                      </Link>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      </div>
    </main>
  );
}
