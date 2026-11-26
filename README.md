# Ultima Pixel Sandbox (PoC)

A serverless, browser-based Ultima Online engine proof-of-concept powered by **ClassicUO** compiled to **.NET 10 WebAssembly AOT**, running against an in-memory UO loopback socket and a **100% original, copyright-free dark-medieval pixel-art MUL/IDX asset pack**.

- **Embedded in portfolio:** https://giga487.github.io/AmatoSplashPage/ultima-pixel
- **Standalone demo:** https://giga487.github.io/ultima-pixel-poc/

## Highlights
- **Zero backend / zero login:** an in-memory loopback socket emulates the minimal UO handshake, movement confirmation, Paperdoll, status, and local overhead speech directly inside the browser.
- **100% original procedural pixel-art assets (~4 MB):** custom isometric island map (`map0.mul`, `statics0.mul`), weathered medieval tiles, 3D skeletal pixel-art character animations (`anim.mul`), pixelated Paperdoll hero (`gumpart.mul`), bitmap pixel fonts, and synthesized SFX — no proprietary game files included.
- **Classic 800×600 layout:** 800×600 game viewport with side dark area where the Paperdoll opens on startup, plus `?embed=1` mode for clean `<iframe>` embedding.

## Controls
- **Right-click & hold:** walk or run around the island
- **Double-click character (or `Alt+P`):** open/close Paperdoll
- **Type + Enter:** local overhead chat

## License & Attribution
This static bundle distributes a WebAssembly build of [ClassicUO](https://github.com/ClassicUO/ClassicUO) (licensed under the **BSD-2-Clause License**, see `LICENSE`) together with original procedural pixel-art assets generated for this proof-of-concept.
