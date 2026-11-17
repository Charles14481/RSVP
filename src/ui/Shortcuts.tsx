import { Panel } from './Panel';

const KEYS: [string, string][] = [
  ['Space', 'Play or pause'],
  ['← / →', 'Previous or next sentence'],
  ['↑ / ↓', 'Faster or slower by 25 wpm'],
  ['R', 'Back to the start of the paragraph'],
  ['I', 'Inspector: surprisal of each word'],
  ['S', 'Settings'],
  ['?', 'This list'],
  ['Esc', 'Close a panel, or back to the library'],
];

export function Shortcuts({ onClose }: { onClose: () => void }) {
  return (
    <Panel title="Keyboard shortcuts" onClose={onClose}>
      <dl className="keys">
        {KEYS.map(([k, v]) => (
          <div key={k}>
            <dt>
              <kbd>{k}</kbd>
            </dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      <p className="field-hint">
        While paused, the surrounding text is shown with your place marked; click any word to continue from there. On a touch screen, tap
        the word to play or pause.
      </p>
    </Panel>
  );
}
