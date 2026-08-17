import Link from "next/link";
import { Avatar } from "@/components/ui/Avatar";
import { Logo } from "@/components/ui/Logo";
import { AI_NAME, APP_NAME, APP_TAGLINE } from "@/lib/brand";

export default function HomePage() {
  return (
    <main className="min-h-screen">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <Logo />
        <Link href="/login" className="btn-primary px-5 py-2.5 text-sm">
          Recruiter login
        </Link>
      </nav>

      <section className="mx-auto grid max-w-6xl items-center gap-12 px-6 pb-16 pt-6 lg:grid-cols-[1fr_1.05fr]">
        <div>
          <p className="badge">IT hiring · 10-minute screens</p>
          <h1 className="mt-5 max-w-xl text-5xl font-semibold leading-[1.08] tracking-tight md:text-6xl">
            {APP_TAGLINE}
          </h1>
          <p className="mt-5 max-w-lg text-lg leading-relaxed text-[var(--studio-muted)]">
            Paste a job description. {AI_NAME} joins a Meet-style room, counts down from 10, then runs
            a 5–6 minute voice interview (Riley wraps up — you won’t be cut off mid-answer) and a 5-minute coding task.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link href="/login" className="btn-primary px-6 py-3">
              Start as recruiter
            </Link>
            <Link href="/app" className="btn-secondary px-6 py-3">
              Open dashboard
            </Link>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div className="meet-tile flex aspect-[4/5] flex-col items-center justify-center">
            <Avatar name={AI_NAME} size="xl" accent speaking />
            <p className="mt-4 font-semibold text-white">{AI_NAME}</p>
            <p className="text-xs text-[var(--studio-muted)]">{APP_NAME} interviewer</p>
            <span className="absolute left-3 top-3 rounded-full bg-black/50 px-2 py-1 text-[11px] text-white">
              Joined
            </span>
          </div>
          <div className="meet-tile flex aspect-[4/5] flex-col items-center justify-center">
            <Avatar name="Alex Chen" size="xl" />
            <p className="mt-4 font-semibold text-white">Alex Chen</p>
            <p className="text-xs text-[var(--studio-muted)]">Candidate</p>
            <span className="absolute left-3 top-3 rounded-full bg-black/50 px-2 py-1 text-[11px] text-white">
              You
            </span>
          </div>
        </div>
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 pb-16 md:grid-cols-3">
        {[
          ["1. Create a role", "Paste the JD and pick seniority. Riley interviews from that, and the coding task is generated from it."],
          ["2. Send a link", "Copy an invite URL. Share it in Slack, WhatsApp, or your ATS — no email required."],
          ["3. Read the scorecard", "Technical, communication, code, and integrity scores, plus transcript and recordings."],
        ].map(([title, body]) => (
          <div key={title} className="card p-6">
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-2 text-sm leading-relaxed text-[var(--studio-muted)]">{body}</p>
          </div>
        ))}
      </section>

      <section className="mx-auto grid max-w-6xl gap-4 px-6 pb-16 md:grid-cols-2">
        <div className="card p-8">
          <p className="badge">For recruiters</p>
          <h2 className="mt-4 text-2xl font-semibold">Screen without a live panel</h2>
          <ul className="mt-4 space-y-2 text-[var(--studio-muted)]">
            <li>Any IT role — Riley follows the job description</li>
            <li>Copyable interview links</li>
            <li>Hire recommendation with evidence</li>
          </ul>
        </div>
        <div className="card p-8">
          <p className="badge">For candidates</p>
          <h2 className="mt-4 text-2xl font-semibold">Talk to {AI_NAME}, then code</h2>
          <ul className="mt-4 space-y-2 text-[var(--studio-muted)]">
            <li>Meet-style room with Riley already joined</li>
            <li>10-second countdown to prepare</li>
            <li>Camera, mic, screen share, and fullscreen required</li>
          </ul>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-6 pb-20">
        <div className="card p-8">
          <h2 className="text-xl font-semibold">What’s recorded</h2>
          <p className="mt-2 max-w-3xl text-[var(--studio-muted)]">
            Webcam and screen are stored for the recruiter. Tab switches, fullscreen exits, and
            face-presence flags are integrity signals — not a guarantee against cheating. Recordings
            expire after 30 days in the cloud POC.
          </p>
        </div>
      </section>
    </main>
  );
}
