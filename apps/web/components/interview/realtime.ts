export type RealtimeHandle = {
  close: () => void;
  setMicMuted: (muted: boolean) => void;
  warnTimeLow: () => void;
  requestWrapUp: (opts?: { speakNow?: boolean }) => void;
};

export async function connectOpenAiRealtime(opts: {
  clientSecret: string;
  model: string;
  mic: MediaStream;
  remoteAudio: HTMLAudioElement | null;
  onTranscript: (role: "assistant" | "user", text: string, meta?: { partial?: boolean }) => void;
  onResponseDone?: () => void;
  onAssistantSpeaking?: (speaking: boolean) => void;
}): Promise<RealtimeHandle> {
  const pc = new RTCPeerConnection();
  pc.ontrack = (e) => {
    if (opts.remoteAudio) opts.remoteAudio.srcObject = e.streams[0];
  };
  const audio = opts.mic.getAudioTracks()[0];
  if (audio) audio.enabled = false;
  const sender = audio ? pc.addTrack(audio, opts.mic) : null;

  const dc = pc.createDataChannel("oai-events");
  let greetingSent = false;
  let openingDone = false;
  let assistantSpeaking = false;
  let assistantBuf = "";
  let wrapNoteSent = false;
  let wrapResponseSent = false;
  const pendingUser: string[] = [];
  const openingTimeout = window.setTimeout(() => {
    openingDone = true;
    applyMicMute(false);
  }, 8000);

  function applyMicMute(muted: boolean) {
    const track = sender?.track;
    if (!track) return;
    if (!muted && !openingDone) return;
    track.enabled = !muted;
  }

  function setAssistantSpeaking(next: boolean) {
    if (assistantSpeaking === next) return;
    assistantSpeaking = next;
    applyMicMute(next);
    opts.onAssistantSpeaking?.(next);
  }

  dc.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data as string) as {
        type?: string;
        delta?: string;
        transcript?: string;
      };
      if (msg.type === "response.created") {
        assistantBuf = "";
        setAssistantSpeaking(true);
      }
      if (msg.type === "response.output_audio.delta") {
        setAssistantSpeaking(true);
      }
      if (msg.type === "response.output_audio_transcript.delta") {
        setAssistantSpeaking(true);
        assistantBuf += msg.delta ?? msg.transcript ?? "";
        if (assistantBuf.trim()) opts.onTranscript("assistant", assistantBuf, { partial: true });
      }
      if (msg.type === "response.output_audio_transcript.done") {
        const item = (msg.transcript || "").trim();
        if (item && !assistantBuf.includes(item)) {
          assistantBuf = assistantBuf ? `${assistantBuf} ${item}`.trim() : item;
        } else if (item.length > assistantBuf.trim().length) {
          assistantBuf = item;
        }
        if (assistantBuf.trim()) opts.onTranscript("assistant", assistantBuf, { partial: true });
      }
      if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
        const spoken = msg.transcript.trim();
        if (!spoken) return;
        if (assistantSpeaking) pendingUser.push(spoken);
        else opts.onTranscript("user", spoken);
      }
      if (msg.type === "response.done") {
        openingDone = true;
        window.clearTimeout(openingTimeout);
        const finalText = assistantBuf.trim();
        assistantBuf = "";
        if (finalText) opts.onTranscript("assistant", finalText);
        setAssistantSpeaking(false);
        applyMicMute(false);
        for (const spoken of pendingUser.splice(0)) opts.onTranscript("user", spoken);
        opts.onResponseDone?.();
      }
    } catch {
      // ignore non-json
    }
  };
  dc.onopen = () => {
    if (greetingSent || dc.readyState !== "open") return;
    greetingSent = true;
    dc.send(JSON.stringify({ type: "response.create" }));
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  const sdpRes = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    body: offer.sdp,
    headers: {
      Authorization: `Bearer ${opts.clientSecret}`,
      "Content-Type": "application/sdp",
    },
  });
  if (!sdpRes.ok) {
    const detail = await sdpRes.text();
    pc.close();
    throw new Error(detail || "OpenAI Realtime WebRTC handshake failed");
  }
  const answer = await sdpRes.text();
  await pc.setRemoteDescription({ type: "answer", sdp: answer });

  function send(event: Record<string, unknown>) {
    if (dc.readyState !== "open") return;
    dc.send(JSON.stringify(event));
  }

  function sendSystemNote(text: string) {
    send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "system",
        content: [{ type: "input_text", text }],
      },
    });
  }

  return {
    close: () => {
      window.clearTimeout(openingTimeout);
      dc.close();
      pc.close();
    },
    setMicMuted: (muted) => {
      applyMicMute(muted);
    },
    warnTimeLow: () => {
      sendSystemNote(
        "You have reached about 5 minutes. You may wrap up after the candidate finishes their current answer if you have enough signal. You can also ask one last short question. Do not rush or cut them off. Stay in the 5–6 minute range.",
      );
    },
    requestWrapUp: (optsIn) => {
      if (!wrapNoteSent) {
        wrapNoteSent = true;
        sendSystemNote(
          "You are at about 6 minutes. After the candidate finishes speaking, thank them and say exactly: \"Thank you. We'll move to the coding task next.\" Do not ask another question. Then stop.",
        );
      }
      if (optsIn?.speakNow === false) return;
      if (wrapResponseSent) return;
      wrapResponseSent = true;
      send({ type: "response.create" });
    },
  };
}
