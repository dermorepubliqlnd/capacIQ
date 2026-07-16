import { BrowserRouter, Routes, Route } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import Tasks from "./pages/Tasks";
import ExtensionRequests from "./pages/ExtensionRequests";
import Capacity from "./pages/Capacity";
import Login from "./pages/Login";

// Real client-side routes (React Router) — each screen has its own URL,
// so the browser's native Back/Forward buttons work without any custom
// handling. Unsaved-changes prompts on forms are added per-page via the
// useUnsavedChangesGuard hook (see src/lib/useUnsavedChangesGuard.ts).
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route element={<AppLayout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<Projects />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/tasks/:taskId" element={<Tasks />} />
          <Route path="/extension-requests" element={<ExtensionRequests />} />
          <Route path="/capacity" element={<Capacity />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
