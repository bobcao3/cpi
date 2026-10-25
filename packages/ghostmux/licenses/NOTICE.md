# Ghostmux native components

Keep the license files with any binary you redistribute. This directory holds
the font and library notices used by the native npm packages.

## Font Logos

The retained Nerd Fonts table calls Font Logos "unlicensed". Font Logos provides
the [Unlicense](LICENSE-font-logos), which includes a public-domain dedication
and permits redistribution. The copy here comes from
[the corresponding upstream release](https://github.com/lukas-w/font-logos/blob/e92426e28ee5bbf4ca328b33e3a393b7a5045f01/LICENSE).

We retain the upstream table and signed source notices unchanged. The included
license gives the terms.

Copyright licenses do not grant rights to use third-party trademarks.

## Retained notices and release bundles

The [original notices](ghostmux/THIRD_PARTY_NOTICES.md) refer to files under
`fonts/`. In this copy, those license files sit beside that notice instead.

Check the actual bundle before redistributing it. The
[npm packager](https://github.com/bobcao3/cpi/blob/main/packages/ghostmux/scripts/ghostmux-package.mjs)
copies this directory. The
[standalone release stager](https://github.com/bobcao3/cpi/blob/main/packages/ghostmux/scripts/ghostmux-release.mjs)
uses a separate list that currently omits this notice and `LICENSE-font-logos`.
