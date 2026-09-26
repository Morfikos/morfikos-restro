import { useAppStore } from "../../stores/app-store";

export default function KdsPage() {
  const ready = useAppStore((state) => state.ready);

  return (
    <main>
      <h1>Morfikos KDS</h1>
      <p>{ready ? "Starter shell is running." : "Starting..."}</p>
    </main>
  );
}
