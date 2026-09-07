import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import Hls, { type Level } from "hls.js";
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
  const hlsRef = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<Level[]>([]);
  const [currentLevel, setCurrentLevel] = useState(-1); // -1 = Auto (ABR)

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
      hlsRef.current = hls;
      hls.loadSource(playbackUrl);
      hls.attachMedia(videoEl);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setLevels(hls.levels);
      });
      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }
  }, [playbackUrl]);

  function handleQualityChange(levelIndex: number) {
    if (!hlsRef.current) return;
    hlsRef.current.currentLevel = levelIndex; // -1 tells hls.js to resume ABR
    setCurrentLevel(levelIndex);
  }

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
    <div className="page">
      <h1>{video.title}</h1>
      <span className={`badge badge-${video.status}`}>{video.status}</span>
      {error && <p className="error">{error}</p>}

      {playbackUrl && <video ref={videoRef} controls />}

      {levels.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <label>
            Quality:{" "}
            <select
              value={currentLevel}
              onChange={(e) => handleQualityChange(Number(e.target.value))}
            >
              <option value={-1}>Auto</option>
              {levels.map((level, index) => (
                <option key={index} value={index}>
                  {level.height}p
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      <h2>Renditions</h2>
      <ul className="rendition-list">
        {video.renditions.map((r) => {
          const live = progress[r.id];
          return (
            <li key={r.id}>
              <div className="rendition-row">
                <span>{r.resolution}p</span>
                <span className={`badge badge-${r.status}`}>{r.status}</span>
              </div>
              {live && (
                <>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${live.percent ?? (live.stage === "uploading" ? 100 : 0)}%`,
                      }}
                    />
                  </div>
                  <span className="progress-label">
                    {live.stage}
                    {live.percent !== undefined ? ` — ${live.percent}%` : ""}
                  </span>
                </>
              )}
              {r.status === "FAILED" && (
                <button className="secondary" onClick={() => handleRetry(r.id)}>
                  Retry
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
