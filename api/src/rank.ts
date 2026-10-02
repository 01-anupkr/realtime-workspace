import { generateKeyBetween } from "fractional-indexing";

export function rankBetween(previous: string | null, next: string | null): string {
  return generateKeyBetween(previous, next);
}
