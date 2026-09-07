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
    <div>
      <h1>Notifications</h1>
      <ul>
        {notifications.map((n) => (
          <li key={n.id}>
            [{n.type}] {JSON.stringify(n.payload)} — {new Date(n.createdAt).toLocaleString()}
          </li>
        ))}
      </ul>
    </div>
  );
}