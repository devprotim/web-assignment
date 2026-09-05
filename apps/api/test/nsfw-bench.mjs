/**
 * Measures real end-to-end moderation latency through the live API:
 * presign -> PUT to storage -> moderate (decode, magic-byte check, sharp
 * resize, model inference). The numbers in the README come from this.
 */
import sharp from 'sharp';

const API = 'http://localhost:3000/api';
const RUNS = 12;
// The upload bucket is 10/min and moderation 15/min, so pace above both rather
// than fighting the limiter this benchmark exists alongside.
const SPACING_MS = 6500;

const res = await fetch(`${API}/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'alice@demo.chat', password: 'demo-password-123' }),
});
const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');

// A realistic photo-sized JPEG rather than a flat colour, so decode and resize
// cost what they would in practice.
const image = await sharp({
  create: { width: 1600, height: 1200, channels: 3, background: { r: 120, g: 90, b: 70 } },
})
  .composite([{ input: Buffer.from(`<svg width="1600" height="1200">${
    Array.from({ length: 300 }, (_, i) =>
      `<circle cx="${(i * 37) % 1600}" cy="${(i * 53) % 1200}" r="${8 + (i % 40)}" fill="rgb(${i % 255},${(i * 7) % 255},${(i * 13) % 255})"/>`,
    ).join('')
  }</svg>`), top: 0, left: 0 }])
  .jpeg({ quality: 85 })
  .toBuffer();

console.log(`image: ${(image.length / 1024).toFixed(0)}KB, 1600x1200 JPEG`);

const timings = [];
for (let i = 0; i < RUNS; i++) {
  let presign = null;
  for (let attempt = 0; attempt < 5 && !presign?.uploadUrl; attempt++) {
    const response = await fetch(`${API}/attachments/presign`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify({ mime: 'image/jpeg', size: image.length }),
    });
    if (response.status === 429) {
      const wait = Number(response.headers.get('retry-after') ?? 5) + 1;
      process.stdout.write(`  rate limited, waiting ${wait}s\r`);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    presign = await response.json();
  }
  if (!presign?.uploadUrl) { console.error('could not presign'); break; }

  await fetch(presign.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: image,
  });

  const started = performance.now();
  const moderate = await fetch(`${API}/attachments/${presign.attachmentId}/moderate`, {
    method: 'POST', headers: { cookie },
  });
  const elapsed = performance.now() - started;
  if (!moderate.ok) { console.error('moderate failed', moderate.status, await moderate.text()); break; }
  timings.push(elapsed);
  await new Promise((r) => setTimeout(r, SPACING_MS));
}

timings.sort((a, b) => a - b);
const pct = (p) => timings[Math.min(timings.length - 1, Math.floor((p / 100) * timings.length))];
console.log(`runs:  ${timings.length}`);
console.log(`min:   ${timings[0]?.toFixed(0)}ms`);
console.log(`p50:   ${pct(50)?.toFixed(0)}ms`);
console.log(`p95:   ${pct(95)?.toFixed(0)}ms`);
console.log(`max:   ${timings.at(-1)?.toFixed(0)}ms`);
