import { SurprisalService } from './client';

let service: SurprisalService | null = null;

/**
 * The app's one surprisal service, with the scoring worker. Kept apart from
 * client.ts so code that relays to a worker elsewhere (the browser
 * extension's content script) does not bundle the worker.
 */
export function surprisalService(): SurprisalService {
  return (service ??= new SurprisalService(() => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module', name: 'surprisal' })));
}
