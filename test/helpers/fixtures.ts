import { readFileSync } from 'node:fs';

export const PASSAGES = ['austen', 'mixed'] as const;
export type PassageName = (typeof PASSAGES)[number];

/** Fixture passages are stored already normalized, apart from the trailing newline. */
export function passage(name: PassageName): string {
  return readFileSync(new URL(`../fixtures/passages/${name}.txt`, import.meta.url), 'utf8').replace(/\r\n/g, '\n').trim();
}
