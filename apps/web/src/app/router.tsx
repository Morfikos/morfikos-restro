import { lazy, Suspense } from "react";
import { BrowserRouter, Navigate, Route, Routes } from "react-router-dom";

const PosPage = lazy(() => import("../features/pos/pos-page"));
const KdsPage = lazy(() => import("../features/kds/kds-page"));
const AdminPage = lazy(() => import("../features/admin/admin-page"));

export function Router() {
  return (
    <BrowserRouter>
      <Suspense fallback={<p>Loading...</p>}>
        <Routes>
          <Route path="/" element={<Navigate to="/pos" replace />} />
          <Route path="/pos" element={<PosPage />} />
          <Route path="/kds" element={<KdsPage />} />
          <Route path="/admin" element={<AdminPage />} />
        </Routes>
      </Suspense>
    </BrowserRouter>
  );
}
