# Website

Source for the marketing site at [egodeath.alephvoid.com](https://egodeath.alephvoid.com).

The site is static HTML, CSS and a little JavaScript with no build step. `styles.css` follows the shared Aleph Void palette used by the other product sites. Preview it locally from the repository root with any static server:

```sh
python3 -m http.server 8000 -d site
```

- `assets/img/screenshot.png` is a symlink to the repository's `images/screenshot.png`, so the README and the site share one screenshot.
- `assets/sample/input.js` is the before/after example in the hero. The deploy workflow generates `assets/sample/output.js` from it with the current build (`--target-tokens 3000`). It is not committed, because CodeQL would flag the obfuscated code; to preview it locally run `npm run build && node dist/cli.js --target-tokens 3000 site/assets/sample/input.js > site/assets/sample/output.js`. Without it the hero shows the short static excerpt in `index.html`.

Pushing changes under `site/`, `images/` or `src/` to `main` deploys to GitHub Pages with `.github/workflows/deploy-site.yml`.
