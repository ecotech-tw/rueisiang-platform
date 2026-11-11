import { useEffect, useRef, useState } from "react";

/** 本人月曆與排班管理共用的方向性月份進場動畫。 */
export function useScheduleMonthTransition(periodKey: string, direction: -1 | 0 | 1) {
  const directionRef = useRef(direction);
  directionRef.current = direction;
  const [entered, setEntered] = useState(direction === 0);

  useEffect(() => {
    const currentDirection = directionRef.current;
    if (currentDirection === 0) { setEntered(true); return; }
    setEntered(false);
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [periodKey]);

  return `transition-[opacity,translate] duration-150 ease-out motion-reduce:transition-none ${entered ? "translate-x-0 opacity-100" : `${directionRef.current > 0 ? "translate-x-2" : "-translate-x-2"} opacity-0`}`;
}
