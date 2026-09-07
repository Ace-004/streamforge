import { createContext, useContext, useState, type ReactNode } from "react";

type AuthContextType = {
  userId: string | null;
  setUserId: (id: string | null) => void;
};

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [userId, setUserId] = useState<string | null>(
    localStorage.getItem("userId"),
  );

  const set = (id: string | null) => {
    setUserId(id);
    if (id) localStorage.setItem("userId", id);
    else localStorage.removeItem("userId");
  };

  return (
    <AuthContext.Provider value={{ userId, setUserId: set }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}