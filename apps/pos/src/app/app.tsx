import { useAppStore } from "../stores/app-store";

export function App() {
  const ready = useAppStore((state) => state.ready);

  return (
    <main>
      <h1>Morfikos POS</h1>
      <p>{ready ? "Starter shell is running." : "Starting..."}</p>
    </main>
  );
}
