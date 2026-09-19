# Pages

Sources for driving the whole pipeline. Each one is here because it broke
something; the note says what, so a render can be judged rather than just
looked at. Run them all with `tools/render-fixtures.sh`.

`../manga-page.png` is the other one, and the heavy case — see CLAUDE.md.

| page | what it is | what it catches |
| --- | --- | --- |
| `tweets-dark.png` | X screenshot, dark, two posts | A handle over its body. Level text, so every block must come back at 0 degrees. Light-on-dark, which `inkOf` has to read the same way round as dark-on-light. |
| `leaflet-tilted.png` | photo of a printed leaflet, held | The page leans and *curves*: 6.6, 6.6, 5.8, 3.8, 2.6 degrees down the five paragraphs. Every box is three times as tall as its text, so anything reading a box height as a font size goes wrong here. Centred, so alignment must come back `center`. |
| `wechat-chat.png` | chat screenshot, Chinese and Arabic | A grey "translated by" footer under two of the bubbles, close enough to the message to look like its next line. Mixed scripts and right-to-left. |
| `banner-small.png` | 237px ad banner | Four runs of text stacked tight: 22px over 37px in the same brown, then 16px green on a yellow panel. Neither size nor colour alone separates all four. |
| `banner-large.png` | 556px, the same banner | The one that showed level text being given a lean. The `東京都` pill is small enough that the profile ties with itself at every shallow angle. |
| `leaflet-story.png` | our own Russian render of the leaflet, as posted | A screenshot of translated output, so it reads back as an ordinary page. |
| `bubble-tilted.png` | synthetic: one tilted line in a flat white bubble | The only case that reaches `grown` **and** a real lean at once, which is the path where alignment and pitch are dropped but the angle is kept. Deliberately flat and wordy: `containerBox` refuses a shape over 2.5x the line's box height, and `allowance()` only grants 8x once the translation passes 12 characters. Regenerate with `tools/make-bubble.py`. |

## reported/

Not inputs. These are the outputs that were reported as wrong, kept so the
before is still there to compare a render against.

| image | what was wrong |
| --- | --- |
| `tweets-merged.png` | Handle and body in one block, reflowed as one huge centred paragraph. |
| `banner-merged.png` | All four runs of the banner in one block. |
| `banner-false-lean.png` | Level text drawn leaning: -1 degree on the headline, -7 on the pill. |
| `leaflet-google-translate.png` | Nothing — Google Translate on the same leaflet, as the thing to measure against. Per-line baselines, background reconstructed rather than patched. |
