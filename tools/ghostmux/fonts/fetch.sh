#!/bin/sh
set -eu
cd "$(dirname "$0")"
base=https://raw.githubusercontent.com
noto=3ec599d8ea849413786a184f20e473c3fcbc4082
cjk=f8d157532fbfaeda587e826d4cd5b21a49186f7c
nerd=33db50390a1b173e6f19ecc2119248d2ec166a11
ghostty=12752b2ac1bb05ce53402ed8c853ed1f96eef0b1
curl -fLsS --retry 3 -o NotoSansMono-Regular.ttf "$base/notofonts/notofonts.github.io/$noto/fonts/NotoSansMono/hinted/ttf/NotoSansMono-Regular.ttf"
curl -fLsS --retry 3 -o NotoSansMono-Bold.ttf "$base/notofonts/notofonts.github.io/$noto/fonts/NotoSansMono/hinted/ttf/NotoSansMono-Bold.ttf"
curl -fLsS --retry 3 -o NotoSansMonoCJKsc-Regular.otf "$base/notofonts/noto-cjk/$cjk/Sans/Mono/NotoSansMonoCJKsc-Regular.otf"
curl -fLsS --retry 3 -o NotoSansMonoCJKsc-Bold.otf "$base/notofonts/noto-cjk/$cjk/Sans/Mono/NotoSansMonoCJKsc-Bold.otf"
curl -fLsS --retry 3 -o NotoEmoji-Regular.ttf "$base/ghostty-org/ghostty/$ghostty/src/font/res/NotoEmoji-Regular.ttf"
curl -fLsS --retry 3 -o SymbolsNerdFontMono-Regular.ttf "$base/ryanoasis/nerd-fonts/$nerd/patched-fonts/NerdFontsSymbolsOnly/SymbolsNerdFontMono-Regular.ttf"
sha256sum -c MANIFEST.sha256
