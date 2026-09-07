import { useEffect, useState } from "react";
import { api } from "../lib/api";

type Notification = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  createdAt: string;
};

export function Notifications() {
  const [notifications, setNotifications] = useState<Notification[]>([]);

  useEffect(() => {
    api.listNotifications().then((res) => setNotifications(res.notifications));
  }, []);

  return (
  <div className="page">
    <h1>Notifications</h1>
    <ul className="notification-list">
      {notifications.map((n) => (
        <li key={n.id}>
          <span className="notification-type">{n.type}</span>
          <span className="notification-time">{new Date(n.createdAt).toLocaleString()}</span>
          <div>{JSON.stringify(n.payload)}</div>
        </li>
      ))}
    </ul>
  </div>
);
}