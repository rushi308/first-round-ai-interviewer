"use client";

import { CODING_DURATION_MS, SENIORITY_LABELS, VOICE_DURATION_MS, VOICE_MAX_MS, VOICE_WRAP_GRACE_MS, jobIncludesCoding, looksLikeVoiceHandoff, wrapUpLine, type Seniority } from "@ai-interviewer/shared";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar } from "@/components/ui/Avatar";
import { Logo } from "@/components/ui/Logo";
import { api } from "@/lib/api";
import { AI_NAME, APP_NAME } from "@/lib/brand";
import { startProctoring } from "./proctor";
import { recordTracks } from "./recorder";
import { connectOpenAiRealtime, type RealtimeHandle } from "./realtime";
import { watchMicActivity } from "./vad";

const MonacoEditor = dynamic(() => import("@monaco-editor/react"), { ssr: false });

type Phase = "gate" | "voice" | "coding" | "done";

type Session = {
  interview: { interviewId: string; candidate: { name: string }; status: string };
  job: { title: string; description: string; seniority?: string; codingRequired?: boolean };
  task: { title: string; prompt: string; starter: string; language: string } | null;
};

function seniorityLabel(value?: string) {
  return SENIORITY_LABELS[(value as Seniority) ?? "mid"] ?? "Mid-level";
}

function collapseRepeatedGreeting(text: string): string {
  const parts = text
    .split(/(?=Hi[,.]?\s+I['’]m Riley)/i)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length < 2) return text.trim();
  return parts.reduce((best, part) => (part.length > best.length ? part : best));
}

function mergeAssistantText(previous: string, incoming: string): string | "skip" | "replace" {
  const a = previous.trim();
  const b = collapseRepeatedGreeting(incoming.trim());
  if (!b || a === b) return "skip";
  if (b.startsWith(a) || b.includes(a)) return b;
  if (a.startsWith(b)) return "skip";
  return "replace";
}

function upsertLiveTurn(
  prev: { role: "assistant" | "user"; text: string; seq: number }[],
  next: { role: "assistant" | "user"; text: string; seq: number },
): { role: "assistant" | "user"; text: string; seq: number }[] {
  const idx = prev.findIndex((turn) => turn.seq === next.seq);
  const updated =
    idx >= 0 ? prev.map((turn, i) => (i === idx ? { ...turn, ...next } : turn)) : [...prev, next];
  return updated.sort((a, b) => a.seq - b.seq);
}

function Equalizer({ active }: { active: boolean }) {
  return (
    <span className={`eq ${active ? "opacity-100" : "opacity-30"}`} aria-hidden>
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

export function InterviewRoom({ token }: { token: string }) {
  const [session, setSession] = useState<Session | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("gate");
  const [remaining, setRemaining] = useState(CODING_DURATION_MS);
  const [lastAi, setLastAi] = useState("");
  const [turns, setTurns] = useState<{ role: "assistant" | "user"; text: string; seq: number }[]>([]);
  const [speaking, setSpeaking] = useState(false);
  const [waitingOnRiley, setWaitingOnRiley] = useState(false);
  const [code, setCode] = useState("");
  const [starting, setStarting] = useState(false);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [ready, setReady] = useState({ cam: false, mic: false, screen: false, full: false });
  const [voiceWrap, setVoiceWrap] = useState<"open" | "warned" | "closing" | "handoff" | "leaving">("open");
  const [rileyTalking, setRileyTalking] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const camStream = useRef<MediaStream | null>(null);
  const screenStream = useRef<MediaStream | null>(null);
  const stopRec = useRef<(() => void) | null>(null);
  const stopProctor = useRef<(() => void) | null>(null);
  const stopVad = useRef<(() => void) | null>(null);
  const realtime = useRef<RealtimeHandle | null>(null);
  const mockTimer = useRef<number | null>(null);
  const transcriptEnd = useRef<HTMLDivElement>(null);
  const transcriptScroll = useRef<HTMLDivElement>(null);
  const connectedRef = useRef(false);
  const lastTurnRef = useRef<{ role: "assistant" | "user"; text: string; seq: number } | null>(null);
  const seqRef = useRef(0);
  const assistantSeqRef = useRef<number | null>(null);
  const openUserSeqRef = useRef<number | null>(null);
  const userSeqQueue = useRef<number[]>([]);
  const assistantStreamingRef = useRef(false);
  const turnsRef = useRef<{ role: "assistant" | "user"; text: string; seq: number }[]>([]);
  const timerStop = useRef<(() => void) | null>(null);
  const speakingRef = useRef(false);
  const phaseRef = useRef<Phase>("gate");
  const wrapStateRef = useRef<"open" | "warned" | "closing" | "handoff" | "leaving">("open");
  const pendingHandoffRef = useRef(false);
  const wrapRequestedRef = useRef(false);
  const forceAfterSilenceRef = useRef(false);
  const rileySpeakingRef = useRef(false);
  const handoffTextRef = useRef("");
  const leaveTimer = useRef<number | null>(null);
  const graceTimer = useRef<number | null>(null);
  const beginCodingRef = useRef<() => Promise<void>>(async () => {});
  const leaveVoiceRef = useRef<() => Promise<void>>(async () => {});
  const includesCoding = session ? jobIncludesCoding(session.job) || Boolean(session.task) : true;

  phaseRef.current = phase;

  const bindVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    if (el && camStream.current && el.srcObject !== camStream.current) {
      el.srcObject = camStream.current;
    }
  }, []);

  useEffect(() => {
    const box = transcriptScroll.current;
    if (box) box.scrollTop = box.scrollHeight;
  }, [turns]);

  useEffect(() => {
    api<Session>(`/session/${token}`)
      .then((s) => {
        setSession(s);
        if (s.task?.starter) setCode(s.task.starter);
      })
      .catch((e) => setError(e instanceof Error ? e.message : "Invalid link"));
  }, [token]);

  const emitEvent = useCallback(
    (type: string, detail?: string) => {
      void api(`/session/${token}/events`, {
        method: "POST",
        body: JSON.stringify({ type, at: new Date().toISOString(), detail }),
      });
    },
    [token],
  );

  async function enableCamera() {
    camStream.current = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (videoRef.current) videoRef.current.srcObject = camStream.current;
    setReady((r) => ({ ...r, cam: true, mic: true }));
  }

  async function enableScreen() {
    screenStream.current = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    setReady((r) => ({ ...r, screen: true }));
  }

  async function enableFullscreen() {
    await document.documentElement.requestFullscreen();
    setReady((r) => ({ ...r, full: true }));
  }

  function startVoiceClock() {
    timerStop.current?.();
    const started = Date.now();
    const id = window.setInterval(() => {
      if (phaseRef.current !== "voice") return;
      const elapsed = Date.now() - started;
      if (elapsed >= VOICE_DURATION_MS && wrapStateRef.current === "open") {
        wrapStateRef.current = "warned";
        setVoiceWrap("warned");
        realtime.current?.warnTimeLow();
      }
      if (elapsed >= VOICE_MAX_MS && wrapStateRef.current !== "closing" && wrapStateRef.current !== "handoff") {
        onVoiceBudgetElapsed();
      }
    }, 1000);
    timerStop.current = () => window.clearInterval(id);
  }

  function startTimer(ms: number, onDone: () => void) {
    timerStop.current?.();
    const end = Date.now() + ms;
    setRemaining(ms);
    const id = window.setInterval(() => {
      const left = Math.max(0, end - Date.now());
      setRemaining(left);
      if (left <= 0) {
        window.clearInterval(id);
        onDone();
      }
    }, 250);
    timerStop.current = () => window.clearInterval(id);
  }

  function attachVad() {
    if (!camStream.current) return;
    stopVad.current?.();
    stopVad.current = watchMicActivity(camStream.current, {
      onSpeaking: (isSpeaking) => {
        speakingRef.current = isSpeaking;
        setSpeaking(isSpeaking);
        if (isSpeaking) {
          setWaitingOnRiley(false);
          clearLeaveTimer();
          if (!rileySpeakingRef.current && openUserSeqRef.current == null) {
            seqRef.current += 1;
            openUserSeqRef.current = seqRef.current;
            userSeqQueue.current.push(seqRef.current);
          }
        } else {
          openUserSeqRef.current = null;
          tryLeaveVoice();
        }
      },
      onSilenceCommit: () => {
        setWaitingOnRiley(true);
        if (phaseRef.current !== "voice") return;
        if (wrapStateRef.current === "closing") requestVoiceWrapUp(true);
        if (forceAfterSilenceRef.current && !pendingHandoffRef.current) {
          requestVoiceWrapUp(true);
          return;
        }
        tryLeaveVoice();
      },
    });
  }

  function nextSeq() {
    seqRef.current += 1;
    return seqRef.current;
  }

  function ensureAssistantSeq() {
    if (assistantSeqRef.current == null) assistantSeqRef.current = nextSeq();
    return assistantSeqRef.current;
  }

  function takeUserSeq() {
    const queued = userSeqQueue.current.shift();
    if (queued != null) return queued;
    return nextSeq();
  }

  function persistTurn(role: "assistant" | "user", text: string, seq: number) {
    void api(`/session/${token}/turns`, {
      method: "POST",
      body: JSON.stringify({ role, text, seq, at: new Date().toISOString() }),
    });
  }

  function clearLeaveTimer() {
    if (leaveTimer.current) {
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = null;
    }
  }

  function playbackMs(text: string) {
    return Math.max(4000, Math.min(12_000, text.trim().length * 60));
  }

  function tryLeaveVoice() {
    if (!pendingHandoffRef.current || phaseRef.current !== "voice") return;
    if (speakingRef.current || rileySpeakingRef.current) {
      clearLeaveTimer();
      return;
    }
    if (leaveTimer.current) return;
    leaveTimer.current = window.setTimeout(() => {
      leaveTimer.current = null;
      if (phaseRef.current !== "voice") return;
      if (speakingRef.current || rileySpeakingRef.current) {
        tryLeaveVoice();
        return;
      }
      wrapStateRef.current = "leaving";
      setVoiceWrap("leaving");
      leaveTimer.current = window.setTimeout(() => {
        leaveTimer.current = null;
        void leaveVoiceRef.current();
      }, 2000);
    }, playbackMs(handoffTextRef.current));
  }

  function requestVoiceWrapUp(speakNow = !speakingRef.current && !rileySpeakingRef.current) {
    if (phaseRef.current !== "voice") return;
    if (wrapStateRef.current !== "handoff" && wrapStateRef.current !== "leaving") {
      wrapStateRef.current = "closing";
      setVoiceWrap("closing");
    }
    realtime.current?.requestWrapUp({ speakNow });
    if (speakNow) wrapRequestedRef.current = true;
  }

  function noteAssistantHandoff(text: string, partial = false) {
    if (phaseRef.current !== "voice" || !looksLikeVoiceHandoff(text)) return;
    pendingHandoffRef.current = true;
    wrapStateRef.current = "handoff";
    setVoiceWrap("handoff");
    handoffTextRef.current = text;
    if (!partial) tryLeaveVoice();
  }

  function onVoiceBudgetElapsed() {
    if (phaseRef.current !== "voice") return;
    if (wrapStateRef.current === "handoff" || wrapStateRef.current === "leaving") return;
    wrapStateRef.current = "closing";
    setVoiceWrap("closing");
    requestVoiceWrapUp(!speakingRef.current && !rileySpeakingRef.current);
    if (graceTimer.current) window.clearTimeout(graceTimer.current);
    graceTimer.current = window.setTimeout(() => {
      if (phaseRef.current !== "voice") return;
      if (speakingRef.current) {
        forceAfterSilenceRef.current = true;
        return;
      }
      if (pendingHandoffRef.current) {
        tryLeaveVoice();
        return;
      }
      if (rileySpeakingRef.current) {
        forceAfterSilenceRef.current = true;
        return;
      }
      requestVoiceWrapUp(true);
      graceTimer.current = window.setTimeout(() => {
        if (phaseRef.current !== "voice") return;
        if (pendingHandoffRef.current) {
          tryLeaveVoice();
          return;
        }
        if (speakingRef.current || rileySpeakingRef.current) {
          forceAfterSilenceRef.current = true;
          return;
        }
        void leaveVoiceRef.current();
      }, VOICE_WRAP_GRACE_MS);
    }, VOICE_WRAP_GRACE_MS);
  }

  function requestStart() {
    if (!session || starting || countdown !== null) return;
    setStarting(true);
    setCountdown(10);
  }

  const connectLive = useCallback(async () => {
    if (connectedRef.current || !session) return;
    connectedRef.current = true;
    try {
      await api(`/session/${token}/start`, { method: "POST" });
      stopRec.current = recordTracks(token, camStream.current, screenStream.current);
      stopProctor.current = startProctoring(videoRef.current, emitEvent);
      setPhase("voice");
      const rt = await api<{
        provider: string;
        clientSecret: string | null;
        model: string;
        instructions: string;
      }>(`/session/${token}/realtime`, { method: "POST" });

      const onTranscript = (role: "assistant" | "user", text: string, meta?: { partial?: boolean }) => {
        const cleaned = collapseRepeatedGreeting(text);
        if (!cleaned) return;
        const partial = Boolean(meta?.partial);

        if (role === "assistant") {
          assistantStreamingRef.current = partial;
          const seq = ensureAssistantSeq();
          const existing = turnsRef.current.find((turn) => turn.seq === seq);
          let next = cleaned;
          if (existing) {
            const merged = mergeAssistantText(existing.text, cleaned);
            if (merged === "skip") {
              if (!partial) {
                persistTurn("assistant", existing.text, seq);
                assistantSeqRef.current = null;
                noteAssistantHandoff(existing.text);
              }
              return;
            }
            if (merged !== "replace") next = merged;
          }
          lastTurnRef.current = { role, text: next, seq };
          setLastAi(next);
          setWaitingOnRiley(false);
          const nextTurns = upsertLiveTurn(turnsRef.current, { role, text: next, seq });
          turnsRef.current = nextTurns;
          setTurns(nextTurns);
          if (!partial) {
            persistTurn("assistant", next, seq);
            assistantSeqRef.current = null;
          }
          noteAssistantHandoff(next, partial);
          return;
        }

        const seq = takeUserSeq();
        const last = lastTurnRef.current;
        if (last && last.role === role && last.text === cleaned && last.seq === seq) return;
        lastTurnRef.current = { role, text: cleaned, seq };
        const nextTurns = upsertLiveTurn(turnsRef.current, { role, text: cleaned, seq });
        turnsRef.current = nextTurns;
        setTurns(nextTurns);
        persistTurn(role, cleaned, seq);
      };

      if (rt.clientSecret && camStream.current) {
        const audio = camStream.current.getAudioTracks()[0];
        const rtcMic = audio ? new MediaStream([audio.clone()]) : camStream.current;
        realtime.current = await connectOpenAiRealtime({
          clientSecret: rt.clientSecret,
          model: rt.model,
          mic: rtcMic,
          remoteAudio: remoteAudioRef.current,
          includesCoding: jobIncludesCoding(session.job) || Boolean(session.task),
          onTranscript,
          onAssistantSpeaking: (isSpeaking) => {
            rileySpeakingRef.current = isSpeaking;
            setRileyTalking(isSpeaking);
            if (isSpeaking) {
              setWaitingOnRiley(false);
              ensureAssistantSeq();
            } else tryLeaveVoice();
          },
          onResponseDone: () => {
            rileySpeakingRef.current = false;
            setRileyTalking(false);
            tryLeaveVoice();
          },
        });
      } else {
        runMockInterviewer(onTranscript);
      }
      attachVad();
      wrapStateRef.current = "open";
      wrapRequestedRef.current = false;
      pendingHandoffRef.current = false;
      forceAfterSilenceRef.current = false;
      rileySpeakingRef.current = false;
      setRileyTalking(false);
      setVoiceWrap("open");
      startVoiceClock();
    } catch (err) {
      connectedRef.current = false;
      setError(err instanceof Error ? err.message : "Couldn’t start the interview");
      setPhase("gate");
    } finally {
      setStarting(false);
      setCountdown(null);
    }
  }, [emitEvent, session, token]);

  const connectLiveRef = useRef(connectLive);
  connectLiveRef.current = connectLive;

  useEffect(() => {
    if (countdown === null) return;
    if (countdown <= 0) {
      void connectLiveRef.current();
      return;
    }
    const id = window.setTimeout(() => setCountdown((n) => (n == null ? null : n - 1)), 1000);
    return () => window.clearTimeout(id);
  }, [countdown]);

  function runMockInterviewer(onTranscript: (role: "assistant" | "user", text: string) => void) {
    const coding = jobIncludesCoding(session?.job ?? {}) || Boolean(session?.task);
    const questions = [
      `Hi ${session?.interview.candidate.name || "there"}, I'm ${AI_NAME} from ${APP_NAME}. This is a ${session?.job.seniority ?? "mid"} ${session?.job.title} screen: about 15 to 20 minutes of conversation${coding ? ", then a coding task based on the job description" : ""}.`,
      "Tell me more about you — your background, recent work, and what you enjoy building.",
      "Thanks. Let's start with a fundamentals question from the job description. How would you explain the core work this role owns?",
      "Got it. Walk me through how you would debug a production issue in this role.",
      "What tradeoffs would you make when designing this for scale?",
      "Last one: what would you watch in production after a change like that?",
      wrapUpLine(coding),
    ];
    let i = 0;
    const speak = () => {
      if (i >= questions.length) return;
      const q = questions[i++];
      onTranscript("assistant", q);
      window.speechSynthesis?.cancel();
      window.speechSynthesis?.speak(new SpeechSynthesisUtterance(q));
    };
    speak();
    mockTimer.current = window.setInterval(speak, 150_000);
  }

  async function beginCoding() {
    if (phaseRef.current === "coding" || phaseRef.current === "done" || countdown !== null) return;
    phaseRef.current = "coding";
    timerStop.current?.();
    clearLeaveTimer();
    if (graceTimer.current) window.clearTimeout(graceTimer.current);
    realtime.current?.close();
    stopVad.current?.();
    if (mockTimer.current) window.clearInterval(mockTimer.current);
    await api(`/session/${token}/phase`, {
      method: "POST",
      body: JSON.stringify({ phase: "in_coding" }),
    });
    setPhase("coding");
    startTimer(CODING_DURATION_MS, () => void finish());
  }
  beginCodingRef.current = beginCoding;

  async function leaveVoice() {
    const coding = jobIncludesCoding(session?.job ?? {}) || Boolean(session?.task);
    if (coding) {
      await beginCoding();
      return;
    }
    await finish();
  }
  leaveVoiceRef.current = leaveVoice;

  async function finish() {
    if (phaseRef.current === "done") return;
    phaseRef.current = "done";
    timerStop.current?.();
    clearLeaveTimer();
    if (graceTimer.current) window.clearTimeout(graceTimer.current);
    realtime.current?.close();
    stopRec.current?.();
    stopProctor.current?.();
    stopVad.current?.();
    if (mockTimer.current) window.clearInterval(mockTimer.current);
    const coding = jobIncludesCoding(session?.job ?? {}) || Boolean(session?.task);
    if (coding) {
      await api(`/session/${token}/code`, {
        method: "POST",
        body: JSON.stringify({ code }),
      });
    } else {
      await api(`/session/${token}/phase`, {
        method: "POST",
        body: JSON.stringify({ phase: "completed" }),
      });
    }
    if (document.fullscreenElement) await document.exitFullscreen().catch(() => undefined);
    setPhase("done");
  }

  const mm = String(Math.floor(remaining / 60000)).padStart(2, "0");
  const ss = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
  const urgent = remaining < 60_000;
  const inCountdown = countdown !== null;
  const canStart =
    ready.cam && ready.mic && (includesCoding ? ready.screen : true) && ready.full && !starting && !inCountdown;
  const rileySpeaking = rileyTalking || (!speaking && Boolean(lastAi) && !waitingOnRiley && phase === "voice" && !inCountdown);
  const leavingLabel = includesCoding ? "Moving to coding…" : "Finishing…";
  const statusText = inCountdown
    ? "Get ready"
    : speaking
      ? voiceWrap === "closing" || voiceWrap === "handoff"
        ? "Finish your answer…"
        : "You’re speaking"
      : voiceWrap === "leaving"
        ? leavingLabel
        : voiceWrap === "handoff" || voiceWrap === "closing"
          ? `${AI_NAME} is wrapping up…`
          : waitingOnRiley
            ? `${AI_NAME} is thinking…`
            : lastAi
              ? `${AI_NAME} is speaking`
              : "Listening…";

  if (error) {
    return (
      <main className="flex min-h-screen items-center justify-center px-6">
        <div className="card max-w-md p-8 text-center">
          <p className="text-sm font-medium text-[var(--bad)]">Couldn’t open interview</p>
          <p className="mt-2 text-[var(--studio-muted)]">{error}</p>
        </div>
      </main>
    );
  }

  if (!session) {
    return (
      <main className="flex min-h-screen items-center justify-center text-[var(--studio-muted)]">
        Loading interview…
      </main>
    );
  }

  const checks = [
    { key: "cam", ok: ready.cam, label: "Camera + mic", action: enableCamera, cta: ready.cam ? "On" : "Enable" },
    ...(includesCoding
      ? [{ key: "screen" as const, ok: ready.screen, label: "Screen", action: enableScreen, cta: ready.screen ? "Sharing" : "Share" }]
      : []),
    { key: "full", ok: ready.full, label: "Fullscreen", action: enableFullscreen, cta: ready.full ? "On" : "Enter" },
  ];

  const live = phase === "voice" && !inCountdown;
  const youName = session.interview.candidate.name;

  const rileyTile = (
    <div className={`meet-tile flex h-36 shrink-0 flex-col items-center justify-center sm:h-40 ${rileySpeaking ? "speaking" : ""}`}>
      <Avatar name={AI_NAME} size="lg" accent speaking={rileySpeaking} />
      <p className="mt-2 text-sm font-semibold text-white">{AI_NAME}</p>
      <p className="text-[11px] text-[var(--studio-muted)]">Joined</p>
      <span className="absolute bottom-2 right-2 flex items-center gap-1 text-[11px] text-white/75">
        <Equalizer active={rileySpeaking} />
        {rileySpeaking ? "Speaking" : "In call"}
      </span>
    </div>
  );

  const youTile = (
    <div className={`meet-tile min-h-0 flex-1 aspect-[4/3] ${speaking ? "speaking" : ""}`}>
      <video
        ref={bindVideo}
        autoPlay
        muted
        playsInline
        className={`absolute inset-0 h-full w-full object-cover object-center ${ready.cam ? "opacity-100" : "opacity-0"}`}
      />
      {!ready.cam ? (
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <Avatar name={youName} size="lg" />
          <p className="mt-2 text-sm font-semibold text-white">{youName}</p>
        </div>
      ) : null}
      <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-1 text-[11px] text-white">
        <Avatar name={youName} size="sm" />
        You
      </div>
      <span className="absolute bottom-2 right-2 flex items-center gap-1 text-[11px] text-white/75">
        <Equalizer active={speaking} />
        {speaking ? "Mic on" : "Mic idle"}
      </span>
    </div>
  );

  return (
    <main className="studio flex h-dvh min-h-0 flex-col overflow-hidden">
      <audio ref={remoteAudioRef} autoPlay />

      {phase !== "done" ? (
        <header className="flex shrink-0 items-center justify-between px-5 py-4 lg:px-7">
          <div className="flex items-center gap-4">
            <Logo />
            <div className="hidden sm:block">
              <p className="text-sm font-semibold text-white">{session.job.title}</p>
              <p className="text-xs text-[var(--studio-muted)]">
                {youName} · {seniorityLabel(session.job.seniority)}
                {live || phase === "coding" ? " · 2 in call" : ""}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {live || phase === "coding" ? (
              <>
                <span className="rounded-full border border-[var(--studio-line)] px-3 py-1 text-xs font-medium text-[var(--studio-muted)]">
                  {phase === "coding"
                    ? "Coding · 2 of 2"
                    : voiceWrap === "leaving"
                      ? leavingLabel
                      : voiceWrap === "closing" || voiceWrap === "handoff"
                        ? includesCoding
                          ? "Wrapping up · 1 of 2"
                          : "Wrapping up"
                        : includesCoding
                          ? "Voice · 1 of 2"
                          : "Voice"}
                </span>
                {phase === "coding" ? (
                  <span
                    className={`mono rounded-full px-4 py-1.5 text-xl font-medium ${
                      urgent ? "bg-[#3a1515] text-[#ff7b72]" : "bg-white/10 text-white"
                    }`}
                  >
                    {mm}:{ss}
                  </span>
                ) : null}
              </>
            ) : inCountdown ? (
              <span className="rounded-full border border-[var(--studio-line)] px-3 py-1 text-xs font-medium text-white">
                Starting…
              </span>
            ) : (
              <span className="rounded-full border border-[var(--studio-line)] px-3 py-1 text-xs font-medium text-[var(--studio-muted)]">
                Waiting room
              </span>
            )}
          </div>
        </header>
      ) : null}

      {phase === "gate" || inCountdown ? (
        <section className="grid flex-1 gap-5 px-4 pb-5 lg:grid-cols-[minmax(340px,1.05fr)_0.95fr] lg:px-6">
          <div className={`meet-tile min-h-[52vh] lg:min-h-[calc(100vh-6.5rem)] ${speaking ? "speaking" : ""}`}>
            <video
              ref={bindVideo}
              autoPlay
              muted
              playsInline
              className={`absolute inset-0 h-full w-full object-cover object-center ${ready.cam ? "opacity-100" : "opacity-0"}`}
            />
            {!ready.cam ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Avatar name={youName} size="xl" />
                <p className="text-lg font-semibold text-white">{youName}</p>
                <p className="text-sm text-[var(--studio-muted)]">Enable camera to see your preview</p>
              </div>
            ) : null}
            <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent p-5">
              <p className="font-medium text-white">{youName}</p>
              <p className="text-sm text-white/70">Your camera preview</p>
            </div>
          </div>

          <div className="studio-panel flex min-h-[420px] flex-col p-7 lg:min-h-[calc(100vh-6.5rem)]">
            {inCountdown ? (
              <div className="flex flex-1 flex-col items-center justify-center text-center">
                <p className="text-sm font-medium uppercase tracking-[0.18em] text-[var(--studio-muted)]">
                  Get ready
                </p>
                <p className="mt-3 text-xl text-white">Interview starts in</p>
                <p key={countdown} className="count-pop mono mt-4 text-8xl font-semibold text-white">
                  {countdown === 0 ? "Go" : countdown}
                </p>
                <p className="mt-6 max-w-sm text-sm text-[var(--studio-muted)]">
                  Sit upright, check your lighting, and wait — {AI_NAME} joins when the timer ends.
                </p>
              </div>
            ) : (
              <>
                <p className="text-sm font-medium text-[#9cb8ff]">Welcome, {youName.split(" ")[0]}</p>
                <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white">Set up before you start</h2>
                <p className="mt-3 text-sm leading-relaxed text-[var(--studio-muted)]">
                  This is a 15–20 minute conversation for {session.job.title} ({seniorityLabel(session.job.seniority)})
                  {includesCoding ? ", then a 5-minute coding task" : ""}. {AI_NAME} wraps up when ready — you
                  won’t be cut off mid-answer.
                </p>
                <ul className="mt-7 space-y-3">
                  {checks.map((item) => (
                    <li
                      key={item.key}
                      className="flex items-center justify-between rounded-2xl border border-[var(--studio-line)] bg-white/3 px-4 py-3.5"
                    >
                      <div className="flex items-center gap-3">
                        <span
                          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
                            item.ok ? "bg-[#143d2e] text-[#3dd68c]" : "bg-white/8 text-[var(--studio-muted)]"
                          }`}
                        >
                          {item.ok ? "✓" : item.key === "cam" ? "1" : item.key === "screen" ? "2" : String(includesCoding ? 3 : 2)}
                        </span>
                        <div>
                          <p className="text-sm font-medium text-white">{item.label}</p>
                          <p className="text-xs text-[var(--studio-muted)]">
                            {item.key === "cam"
                              ? "We’ll show you in the preview on the left"
                              : item.key === "screen"
                                ? "Required while you code"
                                : "Stay in fullscreen during the interview"}
                          </p>
                        </div>
                      </div>
                      <button
                        className="rounded-full bg-white/10 px-3.5 py-1.5 text-xs font-semibold text-white"
                        onClick={() => void item.action()}
                      >
                        {item.cta}
                      </button>
                    </li>
                  ))}
                </ul>
                <button className="btn-primary mt-auto w-full py-3.5 text-sm" disabled={!canStart} onClick={requestStart}>
                  I’m ready — start interview
                </button>
              </>
            )}
          </div>
        </section>
      ) : null}

      {phase === "voice" && !inCountdown ? (
        <section className="grid min-h-0 flex-1 gap-4 overflow-hidden px-4 pb-4 lg:grid-cols-[minmax(260px,320px)_1fr] lg:px-6">
          <aside className="flex min-h-0 flex-col gap-3 overflow-hidden">
            {rileyTile}
            {youTile}
            <div className="flex items-center justify-between rounded-2xl border border-[var(--studio-line)] bg-[var(--studio-panel)] px-3 py-2.5">
              <div className="flex items-center gap-2 text-xs text-white/80">
                <Equalizer active={rileySpeaking || speaking} />
                {statusText}
              </div>
              <button className="text-xs font-medium text-[var(--studio-muted)] hover:text-white" onClick={() => void leaveVoice()}>
                Skip
              </button>
            </div>
          </aside>
          <div className="studio-panel flex min-h-0 flex-col overflow-hidden p-6">
            <p className="shrink-0 text-sm font-medium text-[#9cb8ff]">Live transcript</p>
            <h2 className="mt-1 shrink-0 text-xl font-semibold text-white">Conversation</h2>
            <div ref={transcriptScroll} className="mt-4 min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain pr-1">
              {turns.length === 0 ? (
                <p className="text-sm text-[var(--studio-muted)]">{AI_NAME} is getting ready…</p>
              ) : (
                turns.map((t) => (
                  <div key={t.seq} className="flex items-start gap-3">
                    <span className="mt-0.5 shrink-0">
                      <Avatar
                        name={t.role === "assistant" ? AI_NAME : youName}
                        size="sm"
                        accent={t.role === "assistant"}
                      />
                    </span>
                    <div className="min-w-0 flex-1 rounded-2xl bg-black/25 px-3 py-2">
                      <p className="text-[11px] font-semibold text-[#9cb8ff]">
                        {t.role === "assistant" ? AI_NAME : "You"}
                      </p>
                      <p className="mt-1 text-sm leading-relaxed text-white/90">{t.text}</p>
                    </div>
                  </div>
                ))
              )}
              <div ref={transcriptEnd} />
            </div>
          </div>
        </section>
      ) : null}

      {phase === "coding" && session.task ? (
        <section className="grid flex-1 gap-4 px-4 pb-4 lg:grid-cols-[240px_1fr] lg:px-6">
          <aside className="flex flex-col gap-3">
            <div className="meet-tile aspect-[3/4] min-h-0">
              <video
                ref={bindVideo}
                autoPlay
                muted
                playsInline
                className="absolute inset-0 h-full w-full object-cover object-center"
              />
              <div className="absolute left-2 top-2 flex items-center gap-1.5 rounded-full bg-black/50 px-2 py-1 text-[11px] text-white">
                <Avatar name={youName} size="sm" />
                You
              </div>
            </div>
            <div className="meet-tile flex min-h-[120px] flex-col items-center justify-center py-4">
              <Avatar name={AI_NAME} size="lg" accent />
              <p className="mt-2 text-sm font-medium text-white">{AI_NAME}</p>
              <p className="text-[11px] text-[var(--studio-muted)]">Joined</p>
            </div>
            <div className="studio-panel flex-1 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-[var(--studio-muted)]">Task</p>
              <h2 className="mt-2 text-base font-semibold text-white">{session.task.title}</h2>
              <p className="mt-2 text-sm leading-relaxed text-[var(--studio-muted)]">{session.task.prompt}</p>
            </div>
          </aside>
          <div className="flex min-h-[560px] flex-col overflow-hidden rounded-2xl border border-[var(--studio-line)] bg-[#0f131a]">
            <div className="flex items-center justify-between border-b border-[var(--studio-line)] px-4 py-3">
              <p className="text-sm font-medium text-white/80">{session.task.language}</p>
              <button className="btn-primary px-5 py-2 text-sm" onClick={() => void finish()}>
                Submit code
              </button>
            </div>
            <MonacoEditor
              height="calc(100vh - 10.5rem)"
              theme="vs-dark"
              language={
                session.task.language === "python"
                  ? "python"
                  : session.task.language === "java"
                    ? "java"
                    : "typescript"
              }
              value={code}
              onChange={(v) => setCode(v ?? "")}
              options={{ minimap: { enabled: false }, fontSize: 14, padding: { top: 16 } }}
              onMount={(editor) => {
                editor.onKeyDown((e) => {
                  const ev = e.browserEvent;
                  if ((ev.metaKey || ev.ctrlKey) && (ev.key === "v" || ev.key === "c")) {
                    e.preventDefault();
                    emitEvent(ev.key === "v" ? "paste_attempt" : "copy_attempt");
                  }
                });
              }}
            />
          </div>
        </section>
      ) : null}

      {phase === "done" ? (
        <section className="mx-auto flex min-h-screen max-w-lg flex-col items-center justify-center px-6 text-center">
          <Logo />
          <div className="card mt-8 p-10">
            <div className="mb-5 flex justify-center gap-3">
              <Avatar name={AI_NAME} size="lg" accent />
              <Avatar name={youName} size="lg" />
            </div>
            <p className="text-sm font-medium text-[#9cb8ff]">You’re done</p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight">Interview submitted</h2>
            <p className="mt-3 text-[var(--studio-muted)]">
              The recruiter will see your scorecard, transcript, and recordings shortly. You can close
              this tab.
            </p>
          </div>
        </section>
      ) : null}
    </main>
  );
}
