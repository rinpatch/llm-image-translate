// How a translation shows on the page, as two pictures to pick between, on the
// welcome page and the settings page. A sentence about "notes" means nothing to
// someone who has not used Danbooru; the picture of one does.
import { type ComponentChildren } from 'preact';

// The panel is a picture of an image, so it stays black on white in a dark theme.
const Panel = ({ children }: { children: ComponentChildren }) => (
  <svg viewBox="0 0 200 120" role="img" aria-hidden="true">
    <rect x="0.5" y="0.5" width="199" height="119" fill="#fff" stroke="#000" />
    <path d="M30 18 C 30 4, 150 4, 150 18 L 150 78 C 150 96, 30 96, 30 78 Z
             M70 92 L 58 112 L 90 92" fill="#fff" stroke="#000" stroke-width="1.5"
      stroke-linejoin="round" />
    {children}
  </svg>
);

// Columns read right to left, as the reader would find them on a manga page.
const ORIGINAL = ['どこへ', '行くの'];
const Original = () => (
  <g font-size="15" fill="#000" text-anchor="middle">
    {ORIGINAL.map((column, i) => [...column].map((ch, j) => (
      <text x={100 - i * 20} y={36 + j * 18}>{ch}</text>
    )))}
  </g>
);

const Replaced = () => (
  <Panel>
    <g font-size="14" fill="#000" text-anchor="middle" font-family="sans-serif">
      <text x="90" y="44">Where are</text>
      <text x="90" y="62">you going?</text>
    </g>
  </Panel>
);

// The box and note in the colours content/notes.ts draws them in.
const Noted = () => (
  <Panel>
    <Original />
    <rect x="64" y="20" width="54" height="62" fill="rgba(255,255,238,.5)" stroke="#000" />
    <rect x="64" y="88" width="128" height="22" fill="#ffe" stroke="#000" />
    <text x="70" y="103" font-size="12" fill="#000" font-family="sans-serif">Where are you going?</text>
    <path d="M111 58 L 111 74 L 115 70 L 118 77 L 121 76 L 118 69 L 123 69 Z"
      fill="#000" stroke="#fff" stroke-width="1" stroke-linejoin="round" />
  </Panel>
);

const CARDS = [
  { notes: false, title: 'Replace the text', picture: <Replaced />,
    blurb: 'The translation is painted into the image where the original was.' },
  { notes: true, title: 'Notes over the image', picture: <Noted />,
    blurb: 'The image stays as it is. Hover a box to read its translation.' },
];

export function Display({ notes, onPick }: { notes: boolean; onPick: (notes: boolean) => void }) {
  return (
    <div class="display" role="radiogroup" aria-label="Show translations">
      {CARDS.map((card) => (
        <label class="choice">
          <input type="radio" name="display" checked={notes === card.notes}
            onChange={() => onPick(card.notes)} />
          <div>
            {card.picture}
            <b>{card.title}</b>
            <p class="blurb">{card.blurb}</p>
          </div>
        </label>
      ))}
    </div>
  );
}
