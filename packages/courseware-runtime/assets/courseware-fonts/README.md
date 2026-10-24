Courseware font binaries in this directory are pinned for PC/Android layout parity.

The shared Android package is extracted without changing its files under
`fonts/`. The web app loads each original `index.css` from that directory and
waits for `document.fonts.ready` before mounting slide content.

- lxgw-wenkai-500-normal.woff2: OFL-1.1, MD5 26e4ae1e9b40a5ac0fcbb7d067f9edce
- comic-neue-latin-400-normal.woff2: OFL-1.1, MD5 d0346bbf7ae077cf903158b13c216b01
- comic-neue-latin-700-normal.woff2: OFL-1.1, MD5 16951fb1680d3f156db16041da646ca5

Source packages: @fontsource/lxgw-wenkai@5.3.0 and @fontsource/comic-neue@5.3.0.
