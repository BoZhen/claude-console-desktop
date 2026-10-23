# Third-party notices

Claude Console desktop is MIT-licensed (LICENSE). It contains, or its packages
carry, the following work of others, each under its own license.

## In this repository

- **Feather** icon "settings", drawn in `shell/index.html` (the gear on the rail
  and in the pane's tab bar). MIT License, text below. The other icons of the window
  and the disk image's arrow are drawn for this app.

## In the packages (`scripts/build-mac.sh`, `scripts/build-linux.sh`)

- **Electron** and **Chromium**: Electron's MIT license and Chromium's licenses come
  with every package (`LICENSE` and `LICENSES.chromium.html` beside the app).
- `resources/server`, the servers the app runs on "This computer"
  (`scripts/stage-server.sh`), each with its license file:
  - [Claude Console](https://github.com/BoZhen/claude-console), MIT
    (`server/console/LICENSE`), with KaTeX (MIT, `static/katex/LICENSE`), Lucide
    icons (ISC) and Fluent UI Emoji (MIT) under `static/`;
  - [web file manager](https://github.com/BoZhen/web-file-manager), MIT
    (`server/webfm/LICENSE`), with PDF.js (Apache 2.0, `pdfjs/LICENSE`) and MathJax
    (Apache 2.0, `mathjax/LICENSE`).

## Feather

The MIT License (MIT)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
