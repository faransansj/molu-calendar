import { CATEGORIES } from "./calendar.ts";
import type { FeedEvent } from "./feed.ts";

const INITIALS = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const ONLY_INITIALS = /^[ㄱ-ㅎ]+$/;

function normalize(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/\s+/g, "");
}

export function initials(text: string): string {
  return Array.from(text, (char) => {
    const code = char.charCodeAt(0) - 0xac00;
    return code >= 0 && code <= 11171
      ? INITIALS[Math.floor(code / 588)]!
      : char;
  }).join("");
}

export function eventMatcher(
  query: string,
): ((event: FeedEvent) => boolean) | null {
  const words = query.split(/\s+/).map(normalize).filter(Boolean);
  if (!words.length) return null;
  const cache = new WeakMap<FeedEvent, { text: string; initials: string }>();
  const haystack = (event: FeedEvent) => {
    let entry = cache.get(event);
    if (!entry) {
      const text = normalize(
        [
          event.title,
          event.label,
          CATEGORIES[event.category].label,
          ...(event.students ?? []),
          ...(event.tags ?? []),
        ]
          .filter(Boolean)
          .join("|"),
      );
      entry = { text, initials: initials(text) };
      cache.set(event, entry);
    }
    return entry;
  };
  return (event) => {
    const { text, initials: short } = haystack(event);
    return words.every(
      (word) =>
        text.includes(word) ||
        (ONLY_INITIALS.test(word) && short.includes(word)),
    );
  };
}
