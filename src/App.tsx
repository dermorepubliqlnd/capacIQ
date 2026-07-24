import { HashRouter, Routes, Route, Navigate } from "react-router-dom";
import AppLayout from "./components/AppLayout";
import { TimeTrackingProvider } from "./lib/TimeTrackingContext";
import RequireAuth from "./components/RequireAuth";
import Dashboard from "./pages/Dashboard";
import Projects from "./pages/Projects";
import ExtensionRequests from "./pages/ExtensionRequests";
import TimeTracking from "./pages/TimeTracking";
import Utilization from "./pages/Utilization";
import Admin from "./pages/Admin";
import DayPlanner from "./pages/DayPlanner";
import HolidayCalendar from "./pages/HolidayCalendar";
import WbsPlanning from "./pages/WbsPlanning";
import BaselineReport from "./pages/BaselineReport";
import Login from "./pages/Login";
import SetPassword from "./pages/SetPassword";

// Real client-side routes (React Router) — each screen has its own URL,
// so the browser's native Back/Forward buttons work without any custom
// handling. Unsaved-changes prompts on forms are added per-page via the
// useUnsavedChangesGuard hook (see src/lib/useUnsavedChangesGuard.ts).
//
// Tasks now lives inside the Projects page (single combined view per
// Sandra's request); /tasks is kept as a redirect so old links/bookmarks
// still resolve.
export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          path="/set-password"
          element={
            <RequireAuth>
              <SetPassword />
            </RequireAuth>
          }
        />
        <Route
          element={
            <RequireAuth>
              <TimeTrackingProvider>
                <AppLayout />
              </TimeTrackingProvider>
            </RequireAuth>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects" element={<Projects />} />
          <Route path="/projects/:projectId" element={<Projects />} />
          <Route path="/projects/:projectId/wbs" element={<WbsPlanning />} />
          <Route path="/projects/:projectId/baseline" element={<BaselineReport />} />
          <Route path="/tasks" element={<Navigate to="/projects" replace />} />
          <Route path="/tasks/:taskId" element={<Navigate to="/projects" replace />} />
          <Route path="/extension-requests" element={<ExtensionRequests />} />
          <Route path="/time-tracking" element={<TimeTracking />} />
          <Route path="/utilization" element={<Utilization />} />
          <Route path="/day-planner" element={<DayPlanner />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="/admin/holidays" element={<HolidayCalendar />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
