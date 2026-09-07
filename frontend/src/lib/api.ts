import axios from "axios";

const client = axios.create({ baseURL: import.meta.env.VITE_API_URL,
  withCredentials:true,
 });

export const api = {
  register: (email: string, password: string) =>
    client.post("/auth/register", { email, password }).then((r) => r.data),

  login: (email: string, password: string) =>
    client.post("/auth/login", { email, password }).then((r) => r.data),

  logout: () => client.post("/auth/logout").then((r) => r.data),

  getPresignedUrl: (title: string, contentType: string) =>
    client.post("/videos/presign", { title, contentType }).then((r) => r.data),

  completeUpload: (videoId: string) =>
    client.post(`/videos/${videoId}/complete`).then((r) => r.data),

  listVideos: () => client.get("/videos").then((r) => r.data),

  getVideo: (videoId: string) =>
    client.get(`/videos/${videoId}`).then((r) => r.data),

  retryRendition: (renditionId: string) =>
    client.post(`/videos/renditions/${renditionId}/retry`).then((r) => r.data),

  listNotifications: () => client.get("/notifications").then((r) => r.data),
};
