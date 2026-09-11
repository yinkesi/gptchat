import { useEffect } from 'react';
import { bindWs, useStore } from './store';
import { Landing } from './pages/Landing';
import { Console } from './pages/Console';

export function App() {
  const { me, loadMe, loadRooms } = useStore();

  useEffect(() => {
    const off = bindWs();
    void loadMe().then((ok) => {
      if (ok) void loadRooms();
    });
    return off;
  }, [loadMe, loadRooms]);

  if (!me) return <Landing onDone={() => void loadMe()} />;
  return <Console />;
}
