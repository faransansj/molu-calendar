import { useNow } from "../hooks/calendar.ts";
import { TIME_ZONE, dateKey, dayLabel } from "../lib/calendar/calendar.ts";

const clock = new Intl.DateTimeFormat("en-GB", {
  timeZone: TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

export function KstClock({ className }: { className?: string }) {
  const now = useNow(1000);
  const today = dateKey(now);
  const [hours, minutes, seconds] = clock.format(now).split(":");
  return (
    <div
      className={`flex items-baseline justify-between gap-1.5 whitespace-nowrap ${className}`}
      role="group"
      aria-label="현재 한국 시각"
    >
      <time className="text-2xs/none font-semibold text-muted" dateTime={today}>
        {dayLabel(today)}
      </time>
      <time
        className="font-body text-md/none font-medium text-blue tabular-nums"
        dateTime={new Date(now).toISOString()}
      >
        {`${hours}:${minutes}`}
        <span className="text-muted">{`:${seconds}`}</span>
      </time>
    </div>
  );
}
