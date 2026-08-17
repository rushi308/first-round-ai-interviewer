import { api } from "@/lib/api";

export function recordTracks(
  token: string,
  cam: MediaStream | null,
  screen: MediaStream | null,
): () => void {
  const recorders: MediaRecorder[] = [];

  async function pump(kind: "webcam" | "screen", stream: MediaStream) {
    const rec = new MediaRecorder(
      stream,
      MediaRecorder.isTypeSupported("video/webm;codecs=vp8,opus")
        ? { mimeType: "video/webm;codecs=vp8,opus" }
        : {},
    );
    recorders.push(rec);
    rec.ondataavailable = async (ev) => {
      if (!ev.data.size) return;
      try {
        const { uploadUrl } = await api<{ uploadUrl: string | null }>(`/session/${token}/uploads`, {
          method: "POST",
          body: JSON.stringify({ kind, contentType: "video/webm" }),
        });
        if (uploadUrl) {
          await fetch(uploadUrl, {
            method: "PUT",
            body: ev.data,
            headers: { "Content-Type": "video/webm" },
          });
        }
      } catch {
        // local mode or network blip — keep going
      }
    };
    rec.start(8000);
  }

  if (cam) void pump("webcam", cam);
  if (screen) void pump("screen", screen);

  return () => {
    for (const rec of recorders) {
      if (rec.state !== "inactive") rec.stop();
    }
  };
}
