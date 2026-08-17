export function startProctoring(
  video: HTMLVideoElement | null,
  emit: (type: string, detail?: string) => void,
): () => void {
  const onVis = () => emit(document.hidden ? "tab_hidden" : "tab_visible");
  const onFs = () => emit(document.fullscreenElement ? "fullscreen_enter" : "fullscreen_exit");
  document.addEventListener("visibilitychange", onVis);
  document.addEventListener("fullscreenchange", onFs);

  let cancelled = false;
  let lastFace = "unknown";

  void (async () => {
    if (!video) return;
    try {
      const vision = await import("@mediapipe/tasks-vision");
      const fileset = await vision.FilesetResolver.forVisionTasks(
        "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.21/wasm",
      );
      const detector = await vision.FaceDetector.createFromOptions(fileset, {
        runningMode: "VIDEO",
        minDetectionConfidence: 0.5,
      });
      const loop = () => {
        if (cancelled || video.readyState < 2) {
          if (!cancelled) requestAnimationFrame(loop);
          return;
        }
        const faces = detector.detectForVideo(video, performance.now()).detections.length;
        const state = faces === 0 ? "no_face" : faces > 1 ? "multi_face" : "face_ok";
        if (state !== lastFace) {
          lastFace = state;
          emit(state, String(faces));
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    } catch {
      // Face model optional in local/offline POC
    }
  })();

  return () => {
    cancelled = true;
    document.removeEventListener("visibilitychange", onVis);
    document.removeEventListener("fullscreenchange", onFs);
  };
}
