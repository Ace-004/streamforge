import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import axios from "axios";
import { api } from "../lib/api";

type Video = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
};

const ENABLE_WS = import.meta.env.VITE_ENABLE_WS !== "false";

export function Home() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState("");
  const wsRef = useRef<WebSocket | null>(null);

  async function loadVideos() {
    const res = await api.listVideos();
    setVideos(res.videos);
    return res.videos as Video[];
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadVideos();
  }, []);

  // Keep the list live: while any video is still processing, subscribe to
  // its WebSocket updates and refresh the list once it reaches a terminal state.
  useEffect(() => {
    if (!ENABLE_WS) return;
    const pending = videos.filter(
      (v) => v.status === "PENDING" || v.status === "PROCESSING",
    );
    if (pending.length === 0) {
      wsRef.current?.close();
      return;
    }

    if (!wsRef.current || wsRef.current.readyState === WebSocket.CLOSED) {
      wsRef.current = new WebSocket(import.meta.env.VITE_WS_URL);
    }
    const ws = wsRef.current;

    const handleOpen = () => {
      pending.forEach((v) => {
        ws.send(JSON.stringify({ type: "subscribe", videoId: v.id }));
      });
    };

    const handleMessage = (event: MessageEvent) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "terminal") {
        loadVideos();
      }
    };

    if (ws.readyState === WebSocket.OPEN) handleOpen();
    else ws.addEventListener("open", handleOpen);
    ws.addEventListener("message", handleMessage);

    return () => {
      ws.removeEventListener("open", handleOpen);
      ws.removeEventListener("message", handleMessage);
    };
  }, [videos]);

  // Fallback for deployments without WS support: poll the list while
  // anything is still processing.
  useEffect(() => {
    if (ENABLE_WS) return;
    const pending = videos.filter(
      (v) => v.status === "PENDING" || v.status === "PROCESSING",
    );
    if (pending.length === 0) return;

    const interval = setInterval(() => {
      loadVideos();
    }, 4000);

    return () => clearInterval(interval);
  }, [videos]);

  useEffect(() => {
    return () => wsRef.current?.close();
  }, []);

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError("");
    setUploading(true);
    setUploadPercent(0);
    try {
      const { uploadUrl, videoId } = await api.getPresignedUrl(
        title,
        file.type,
      );

      await axios.put(uploadUrl, file, {
        headers: { "Content-Type": file.type },
        onUploadProgress: (evt) => {
          if (evt.total) {
            setUploadPercent(Math.round((evt.loaded / evt.total) * 100));
          }
        },
      });

      await api.completeUpload(videoId);
      setFile(null);
      setTitle("");
      await loadVideos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
      setUploadPercent(0);
    }
  }

  return (
    <div className="page">
      <h1>My Videos</h1>

      <form onSubmit={handleUpload} className="card">
        <input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          required
        />
        <input
          type="file"
          accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        <button type="submit" disabled={uploading}>
          {uploading ? `Uploading... ${uploadPercent}%` : "Upload"}
        </button>
      </form>
      {error && <p className="error">{error}</p>}

      <ul className="video-list">
        {videos.map((v) => (
          <li key={v.id}>
            <Link to={`/videos/${v.id}`}>{v.title}</Link>
            <span className={`badge badge-${v.status}`}>{v.status}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
