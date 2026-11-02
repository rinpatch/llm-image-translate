#!/bin/sh
# Renders extension/icons/*.png from the SVGs beside them. Needs rsvg-convert
# (brew install librsvg).
#
# 16px has its own drawing: the 128 outline smoothed down to 16 is a grey smear,
# so that one is placed pixel by pixel.
set -e
cd "$(dirname "$0")/../extension/icons"
rsvg-convert -w 16 icon-16.svg -o 16.png
rsvg-convert -w 48 icon.svg -o 48.png
rsvg-convert -w 128 icon.svg -o 128.png
