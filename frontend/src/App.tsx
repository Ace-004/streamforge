import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/AuthContext";
import { ProtectedRoute } from "./lib/ProtectedRoute";
import { Login } from "./pages/Login";
import { Register } from "./pages/Register";
import { Home } from "./pages/Home";
import { VideoDetail } from "./pages/VideoDetail";
import { Notifications } from "./pages/Notifications";
import { api } from "./lib/api";

function NavBar() {
  const { userId, setUserId } = useAuth();
  if (!userId) return null;

  async function handleLogout() {
    await api.logout();
    setUserId(null);
  }

  return (
    <nav>
      <Link to="/">My Videos</Link> | <Link to="/notifications">Notifications</Link> |{" "}
      <button onClick={handleLogout}>Logout</button>
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <NavBar />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/" element={<Home />} />
            <Route path="/videos/:id" element={<VideoDetail />} />
            <Route path="/notifications" element={<Notifications />} />
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}