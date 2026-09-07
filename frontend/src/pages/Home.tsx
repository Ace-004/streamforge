import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api } from "../lib/api";

type Video = {
  id: string;
  title: string;
  status: string;
  createdAt: string;
};

export function Home() {
  const [videos, setVideos] = useState<Video[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState("");
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState("");

  async function loadVideos() {
    const res = await api.listVideos();
    setVideos(res.videos);
  }

  useEffect(() => {
  // Fetching on mount: setState happens after an await, not synchronously,
  // so this doesn't cause the cascading re-render the rule guards against.
// eslint-disable-next-line react-hooks/set-state-in-effect
  loadVideos();
}, []);

  async function handleUpload(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setError("");
    setUploading(true);
    try {
      const { uploadUrl, videoId } = await api.getPresignedUrl(title, file.type);
      await fetch(uploadUrl, { method: "PUT", body: file });
      await api.completeUpload(videoId);
      setFile(null);
      setTitle("");
      await loadVideos();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <h1>My Videos</h1>

      <form onSubmit={handleUpload}>
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
          {uploading ? "Uploading..." : "Upload"}
        </button>
      </form>
      {error && <p style={{ color: "red" }}>{error}</p>}

      <ul>
        {videos.map((v) => (
          <li key={v.id}>
            <Link to={`/videos/${v.id}`}>{v.title}</Link> — {v.status}
          </li>
        ))}
      </ul>
    </div>
  );
}