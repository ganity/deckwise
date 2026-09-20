import { ErrorBoundary } from "./features/app/chrome";
import { AppShell } from "./features/app/AppShell";
import { AuthGate } from "./features/auth/AuthGate";

export default function App() {
  return (
    <ErrorBoundary>
      <AuthGate>
        <AppShell />
      </AuthGate>
    </ErrorBoundary>
  );
}
