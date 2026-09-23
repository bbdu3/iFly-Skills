// n8n-specific restrictions around the original Skill renderer.
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { renderGif } from '../../skills/animated-sketch-diagram/scripts/render-gif.mjs';

const [input, output, ...args] = process.argv.slice(2);
const option = (key, fallback) => args.includes('--' + key) ? Number(args[args.indexOf('--' + key) + 1]) : fallback;
try {
  const width = option('width', 800), height = option('height', 500), scale = option('scale', 1);
  const fps = option('fps', 10), duration = option('loop', 2000);
  for (const [value, min, max] of [[width, 64, 1600], [height, 64, 1200], [scale, 1, 2], [fps, 1, 25], [duration, 100, 5000]]) {
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid rendering options');
  }
  const frames = Math.ceil(duration * fps / 1000);
  if (frames * width * height * scale * scale > 120_000_000) throw new Error('Render budget exceeded');
  const chrome = process.env.IFLYTEK_CHROME_EXECUTABLE, ffmpeg = process.env.IFLYTEK_FFMPEG_EXECUTABLE;
  if ([chrome, ffmpeg].some(p => !p || !isAbsolute(p) || !statSync(p).isFile())) throw new Error('Missing runtime');
  if (statSync(input).size > 256 * 1024) throw new Error('HTML exceeds size limit');
  const font = readFileSync(new URL('../../skills/animated-sketch-diagram/assets/fonts/Kalam-400.woff2', import.meta.url)).toString('base64');
  const fontStyle = "<style>@font-face{font-family:Kalam;src:url(data:font/woff2;base64," + font + ") format('woff2');font-weight:400;}</style>";
  let html = readFileSync(input, 'utf8');
  html = /<head(?:\s[^>]*)?>/i.test(html)
    ? html.replace(/<head(?:\s[^>]*)?>/i, match => match + fontStyle)
    : '<!doctype html><html><head>' + fontStyle + '</head><body>' + html + '</body></html>';
  await renderGif(input, output, {
    fps, loop: frames / fps * 1000, scale, ffmpegPath: ffmpeg, ffmpegTimeout: 30000,
    launchOptions: { executablePath: chrome, chromiumSandbox: true, timeout: 15000 },
    pageOptions: { viewport: { width, height }, javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false },
    preparePage: async page => {
      page.setDefaultTimeout(15000);
      const origin = 'https://ifly-diagram.invalid/';
      await page.context().route('**/*', route => route.request().url() === origin && route.request().isNavigationRequest()
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: html, headers: {
          'Content-Security-Policy': "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; font-src data:; frame-src 'none'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'none'",
        } }) : route.abort());
      await page.goto(origin, { waitUntil: 'load', timeout: 15000 });
    },
  });
} catch {
  console.error('GIF rendering failed; check input, runtime paths and resource limits.');
  process.exitCode = 1;
}
