// Reading the recogniser's output back into text.
//
// The head is trained with CTC, so it emits one distribution per slice of the
// crop rather than one per character: a wide glyph occupies several slices and
// a gap emits the blank class. Collapsing a run of the same class into one
// character and dropping the blanks is the whole decode.

export interface Reading {
  text: string;
  /** Mean confidence over the slices that survived the collapse. */
  score: number;
}

/** Index 0 is CTC's blank — the class meaning "nothing here", not a character. */
const BLANK = 0;

/**
 * One row of the batch. `logits` is the whole batch's output, already softmaxed
 * by the graph, laid out as [item][slice][class].
 */
export function decode(logits: Float32Array, item: number, slices: number,
                       classes: number, charset: string[]): Reading {
  const base = item * slices * classes;
  let text = '';
  let total = 0;
  let kept = 0;
  let previous = -1;
  for (let slice = 0; slice < slices; slice++) {
    const from = base + slice * classes;
    let best = 0;
    let at = 0;
    for (let cls = 0; cls < classes; cls++) {
      const value = logits[from + cls];
      if (value > best) {
        best = value;
        at = cls;
      }
    }
    // A glyph wider than one slice repeats its class; only the first is a
    // character. A blank between two of the same class is what separates a
    // genuine double letter, which is why the reset happens here and not above.
    if (at !== previous && at !== BLANK) {
      text += charset[at] ?? '';
      total += best;
      kept++;
    }
    previous = at;
  }
  return { text, score: kept ? total / kept : 0 };
}
