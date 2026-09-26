import { useAppStore } from "../../stores/app-store";

export default function AdminPage() {
  const ready = useAppStore((state) => state.ready);

  return (
    <main>
      <h1>Morfikos Admin</h1>
      <p>{ready ? "Starter shell is running." : "Starting..."}</p>
    </main>
  );
}
