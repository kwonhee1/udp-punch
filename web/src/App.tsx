import { LogPanel } from "./components/LogPanel";
import { MeCard } from "./components/MeCard";
import { PeerList } from "./components/PeerList";
import { usePeerManager } from "./hooks/usePeerManager";

const CONFIG = { supabaseUrl: __SUPABASE_URL__, supabaseKey: __SUPABASE_KEY__ };

export default function App() {
  const [manager, snapshot] = usePeerManager(CONFIG);
  return (
    <main>
      <h1>UDP 홀 펀칭</h1>
      <MeCard snapshot={snapshot} />
      <PeerList manager={manager} snapshot={snapshot} />
      <LogPanel logs={snapshot.logs} />
    </main>
  );
}
