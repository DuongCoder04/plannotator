import { useEffect } from 'react';
import { planLookAnsweredElsewhere } from '../utils/lookAndFeelAnnouncement';

/**
 * While the plan-look chooser or notice is open, close it when the person
 * comes back to this tab after answering it in another one. `onAnswered`
 * receives the look chosen there (true = Grid); the caller adopts it without
 * writing anything.
 */
export function usePlanLookAnsweredElsewhere(open: boolean, onAnswered: (grid: boolean) => void): void {
  useEffect(() => {
    if (!open) return;
    const check = () => {
      if (document.visibilityState !== 'visible') return;
      const grid = planLookAnsweredElsewhere();
      if (grid !== null) onAnswered(grid);
    };
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    return () => {
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [open, onAnswered]);
}
