import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Hls from "hls.js";
import { api } from "../lib/api";

type Rendition = {
  id: string;
  resolution: string;
  status: string;
};

type VideoData = {
  id: string;
  title: string;
  status: string;
  renditions: Rendition[];
};

type ProgressMap = Record<string, { stage: string; percent?: number }>;

export function VideoDetail() {
  const { id } = useParams<{ id: string }>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [video, setVideo] = useState<VideoData | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [progress, setProgress] = useState<ProgressMap>({});
  const [error, setError] = useState("");

  async function loadVideo() {
    if (!id) return;
    const res = await api.getVideo(id);
    setVideo(res.video);
    setPlaybackUrl(res.playbackUrl);
  }

  useEffect(() => {
  // eslint-disable-next-line react-hooks/set-state-in-effect
  loadVideo();
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [id]);

  // Attach hls.js (or native HLS for Safari) once we have a playback URL
  useEffect(() => {
    if (!playbackUrl || !videoRef.current) return;
    const videoEl = videoRef.current;

    if (videoEl.canPlayType("application/vnd.apple.mpegurl")) {
      videoEl.src = playbackUrl;
    } else if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(playbackUrl);
      hls.attachMedia(videoEl);
      return () => hls.destroy();
    }
  }, [playbackUrl]);

  // Live progress via WebSocket
  useEffect(() => {
    if (!id) return;
    const ws = new WebSocket(import.meta.env.VITE_WS_URL);

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", videoId: id }));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "progress") {
        setProgress((prev) => ({
          ...prev,
          [msg.renditionId]: { stage: msg.stage, percent: msg.percent },
        }));
      }

      if (msg.type === "terminal") {
        setProgress((prev) => ({
          ...prev,
          [msg.renditionId]: { stage: msg.status },
        }));
        loadVideo(); // refresh rendition list/status once something finishes
      }

      if (msg.type === "error") {
        setError(msg.message);
      }
    };

    return () => ws.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  async function handleRetry(renditionId: string) {
    try {
      await api.retryRendition(renditionId);
      await loadVideo();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    }
  }

  if (!video) return <p>Loading...</p>;

  return (
    <div>
      <h1>{video.title}</h1>
      <p>Status: {video.status}</p>
      {error && <p style={{ color: "red" }}>{error}</p>}

      {playbackUrl && (
        <video ref={videoRef} controls style={{ width: "100%", maxWidth: 640 }} />
      )}

      <h2>Renditions</h2>
      <ul>
        {video.renditions.map((r) => {
          const live = progress[r.id];
          return (
            <li key={r.id}>
              {r.resolution}p — {r.status}
              {live && (
                <> — live: {live.stage}{live.percent !== undefined ? ` ${live.percent}%` : ""}</>
              )}
              {r.status === "FAILED" && (
                <button onClick={() => handleRetry(r.id)}>Retry</button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}