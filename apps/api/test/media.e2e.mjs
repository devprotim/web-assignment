/**
 * End-to-end checks for the image upload and moderation pipeline.
 *
 * Covers the paths that matter for the requirement "a user should not be able to
 * bypass the check by directly calling the message API": sending an unmoderated
 * attachment, uploading a file whose magic bytes disagree with its declared type,
 * and moderating an attachment belonging to someone else.
 *
 * Usage: see realtime.e2e.mjs
 */
import sharp from 'sharp';

const API = 'http://localhost:3000/api';
const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};

async function login(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'demo-password-123' }),
  });
  const user = await res.json();
  const cookie = res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return { user, cookie };
}

const alice = await login('alice@demo.chat');
const convs = await (await fetch(`${API}/conversations`, { headers: { cookie: alice.cookie } })).json();
const conv = convs[0];

// A plain photograph-like image with EXIF attached, so we can prove EXIF is stripped.
const benign = await sharp({
  create: { width: 600, height: 400, channels: 3, background: { r: 90, g: 140, b: 200 } },
}).jpeg().withExif({ IFD0: { Copyright: 'SECRET-CAMERA-DATA', Software: 'test' } }).toBuffer();

async function presign(mime, size, cookie = alice.cookie) {
  const res = await fetch(`${API}/attachments/presign`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
    body: JSON.stringify({ mime, size }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

console.log('--- 1. presign validation ---');
const badMime = await presign('application/x-msdownload', 1000);
check('non-image mime is refused at presign', badMime.status === 400 || badMime.status === 422, String(badMime.status));
const tooBig = await presign('image/jpeg', 50 * 1024 * 1024);
check('oversized declared size is refused at presign', tooBig.status === 400 || tooBig.status === 422, String(tooBig.status));

console.log('\n--- 2. happy path: upload -> moderate -> send ---');
const p = await presign('image/jpeg', benign.length);
check('presign returns an upload URL and attachment id', Boolean(p.body?.uploadUrl && p.body?.attachmentId));

const put = await fetch(p.body.uploadUrl, {
  method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: benign,
});
check('browser PUTs bytes directly to object storage (not through the API)', put.ok, `HTTP ${put.status}`);

console.log('\n--- 3. an unmoderated attachment cannot be sent ---');
const premature = await fetch(`${API}/conversations/${conv.id}/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie: alice.cookie },
  body: JSON.stringify({
    clientMessageId: crypto.randomUUID(),
    content: { kind: 'IMAGE', attachmentId: p.body.attachmentId },
  }),
});
const prematureBody = await premature.json().catch(() => ({}));
check('sending a PENDING attachment is refused (bypass attempt)', premature.status === 422, `${premature.status} ${prematureBody.reason ?? ''}`);

console.log('\n--- 4. moderation ---');
const modStart = Date.now();
const mod = await fetch(`${API}/attachments/${p.body.attachmentId}/moderate`, {
  method: 'POST', headers: { cookie: alice.cookie },
});
const modBody = await mod.json().catch(() => ({}));
check('benign image passes moderation', mod.status === 201 || mod.status === 200, `${mod.status} in ${Date.now() - modStart}ms`);
check('approved attachment reports APPROVED', modBody.moderationStatus === 'APPROVED', modBody.moderationStatus ?? '');
check('a thumbnail is generated', Boolean(modBody.thumbnailUrl));
check('image is re-encoded to webp', modBody.mime === 'image/webp', modBody.mime ?? '');

console.log('\n--- 5. EXIF stripping ---');
if (modBody.url) {
  const stored = Buffer.from(
    await (await fetch(`http://localhost:3000${modBody.url}`, { headers: { cookie: alice.cookie } })).arrayBuffer(),
  );
  check('stored image does not contain original EXIF', !stored.includes('SECRET-CAMERA-DATA'));
  const meta = await sharp(stored).metadata();
  check('stored image is a valid webp', meta.format === 'webp', meta.format ?? '');
}

console.log('\n--- 5b. media authorization ---');
{
  const anon = await fetch(`http://localhost:3000${modBody.url}`, { redirect: 'manual' });
  check('unauthenticated read of media is refused', anon.status === 401, String(anon.status));
}

console.log('\n--- 6. approved attachment can now be sent ---');
const send = await fetch(`${API}/conversations/${conv.id}/messages`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', cookie: alice.cookie },
  body: JSON.stringify({
    clientMessageId: crypto.randomUUID(),
    content: { kind: 'IMAGE', attachmentId: p.body.attachmentId },
  }),
});
const sent = await send.json().catch(() => ({}));
check('approved attachment sends successfully', send.status === 201, String(send.status));
check('message carries the attachment url', Boolean(sent.attachment?.url));

console.log('\n--- 7. magic-byte validation (filename/mime cannot be trusted) ---');
const fake = Buffer.from('MZ\x90\x00 this is an executable, not a jpeg, but declared as one');
const p2 = await presign('image/jpeg', fake.length);
await fetch(p2.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: fake });
const mod2 = await fetch(`${API}/attachments/${p2.body.attachmentId}/moderate`, {
  method: 'POST', headers: { cookie: alice.cookie },
});
const mod2Body = await mod2.json().catch(() => ({}));
check('file whose magic bytes are not an image is rejected', mod2.status === 422, `${mod2.status} ${mod2Body.reason ?? ''}`);

console.log('\n--- 8. cross-user attachment theft ---');
const bob = await login('bob@demo.chat');
const p3 = await presign('image/jpeg', benign.length);
await fetch(p3.body.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: benign });
const steal = await fetch(`${API}/attachments/${p3.body.attachmentId}/moderate`, {
  method: 'POST', headers: { cookie: bob.cookie },
});
check("another user cannot moderate someone else's attachment", steal.status === 403, String(steal.status));

console.log('\n--- 9. outsider cannot read media from a conversation they are not in ---');
{
  const mallory = await login('mallory@demo.chat').catch(async () => {
    await fetch(`${API}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mallory@demo.chat', password: 'demo-password-123', displayName: 'Mallory' }),
    });
    return login('mallory@demo.chat');
  });
  const peek = await fetch(`http://localhost:3000${modBody.url}`, {
    headers: { cookie: mallory.cookie }, redirect: 'manual',
  });
  check('non-member is refused the image', peek.status === 403, String(peek.status));
}

const failed = results.filter((r) => !r).length;
console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILURES'} (${results.length} checks)`);
process.exit(failed === 0 ? 0 : 1);
