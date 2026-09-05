/**
 * End-to-end checks for the realtime layer, run against a live server.
 *
 * These exercise the behaviours that unit tests cannot demonstrate: two
 * independent clients, real socket transport, presence across multiple tabs, and
 * idempotency under replay.
 *
 * Usage:
 *   docker compose up -d
 *   npm run seed  -w @chat/api
 *   npm run start -w @chat/api      # in another shell
 *   npm run test:realtime -w @chat/api
 */
import { io } from 'socket.io-client';

const API = 'http://localhost:3000/api';
const PASSWORD = 'demo-password-123';

const results = [];
const check = (label, ok, extra = '') => {
  results.push(ok);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function once(socket, event, ms = 3000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { socket.off(event, handler); resolve(null); }, ms);
    const handler = (payload) => { clearTimeout(timer); socket.off(event, handler); resolve(payload); };
    socket.on(event, handler);
  });
}

async function login(email) {
  const res = await fetch(`${API}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const user = await res.json();
  const cookies = res.headers.getSetCookie();
  const at = cookies.find((c) => c.startsWith('chat_at='))?.split(';')[0].split('=')[1];
  return { user, token: at, cookie: cookies.map((c) => c.split(';')[0]).join('; ') };
}

const connect = (token) =>
  new Promise((resolve, reject) => {
    const s = io('http://localhost:3000', {
      auth: { token }, transports: ['websocket'], reconnection: false,
    });
    s.on('connect', () => resolve(s));
    s.on('connect_error', (e) => { s.close(); reject(e); });
  });

const uuid = () => crypto.randomUUID();
setTimeout(() => { console.log('TIMED OUT'); process.exit(2); }, 90000).unref();

(async () => {
  const alice = await login('alice@demo.chat');
  const bob = await login('bob@demo.chat');

  const convRes = await fetch(`${API}/conversations`, { headers: { cookie: bob.cookie } });
  const conversations = await convRes.json();
  const conv = conversations.find((c) => c.members.some((m) => m.userId === alice.user.id));
  console.log(`\nconversation ${conv.id}\n`);

  console.log('--- 1. authentication ---');
  let rejected = false;
  try { await connect('not-a-valid-token'); } catch { rejected = true; }
  check('socket with an invalid token is rejected at handshake', rejected);

  const aliceSock = await connect(alice.token);
  const bobSock = await connect(bob.token);
  check('authenticated sockets connect', aliceSock.connected && bobSock.connected);
  await wait(400);

  console.log('\n--- 2. real-time delivery ---');
  const incoming = once(bobSock, 'message:new');
  const cmid = uuid();
  const sendStart = Date.now();
  const ack = await aliceSock.emitWithAck('message:send', {
    conversationId: conv.id, clientMessageId: cmid,
    content: { kind: 'TEXT', text: 'hello over the socket' },
  });
  const received = await incoming;
  const latency = Date.now() - sendStart;
  check('sender receives an ack', ack?.ok === true);
  check('recipient receives message:new without polling', received?.text === 'hello over the socket', `${latency}ms end-to-end`);
  check('clientMessageId round-trips for reconciliation', received?.clientMessageId === cmid);

  console.log('\n--- 3. idempotency over the socket ---');
  const dupes = [];
  const dupWatch = (m) => dupes.push(m);
  bobSock.on('message:new', dupWatch);
  const ack2 = await aliceSock.emitWithAck('message:send', {
    conversationId: conv.id, clientMessageId: cmid,
    content: { kind: 'TEXT', text: 'hello over the socket' },
  });
  await wait(700);
  bobSock.off('message:new', dupWatch);
  check('replaying a clientMessageId returns the same message id', ack2?.data?.id === ack?.data?.id);
  check('a replay is NOT re-broadcast to the recipient', dupes.length === 0, `(saw ${dupes.length})`);

  console.log('\n--- 4. typing indicator ---');
  const typing = once(bobSock, 'typing');
  aliceSock.emit('typing:start', { conversationId: conv.id });
  const typingEvent = await typing;
  check('typing relayed to the other member', typingEvent?.isTyping === true && typingEvent?.userId === alice.user.id);

  console.log('\n--- 5. multi-tab consistency ---');
  const aliceTab2 = await connect(alice.token);
  await wait(400);
  const tab2Sees = once(aliceTab2, 'message:new');
  await bobSock.emitWithAck('message:send', {
    conversationId: conv.id, clientMessageId: uuid(),
    content: { kind: 'TEXT', text: 'does the second tab see this' },
  });
  const seen = await tab2Sees;
  check('a second tab of the same account receives messages', seen?.text === 'does the second tab see this');

  console.log('\n--- 6. presence ---');
  let sawOffline = false;
  const offWatch = (p) => { if (p.userId === alice.user.id && p.online === false) sawOffline = true; };
  bobSock.on('presence', offWatch);
  aliceSock.disconnect();
  await wait(1200);
  check('closing ONE of two tabs does not mark the user offline', sawOffline === false);

  aliceTab2.disconnect();
  await wait(1200);
  bobSock.off('presence', offWatch);
  check('closing the LAST tab marks the user offline', sawOffline === true);

  console.log('\n--- 7. read receipts ---');
  const alice2 = await connect(alice.token);
  await wait(400);
  // Must be a message NEWER than anything Bob has already read. Bob sent one in
  // step 5, which advanced his own cursor, and the cursor only moves forward.
  const fresh = await alice2.emitWithAck('message:send', {
    conversationId: conv.id, clientMessageId: uuid(),
    content: { kind: 'TEXT', text: 'please read this one' },
  });
  await wait(300);
  const readEvent = once(alice2, 'read:receipt');
  bobSock.emit('receipt:read', { conversationId: conv.id, messageId: fresh.data.id });
  const receipt = await readEvent;
  check('read receipt reaches the sender', receipt?.userId === bob.user.id && receipt?.messageId === fresh.data.id);

  // The monotonic guarantee: a receipt for an older message must be ignored.
  const stale = once(alice2, 'read:receipt', 1200);
  bobSock.emit('receipt:read', { conversationId: conv.id, messageId: ack.data.id });
  check('a receipt for an OLDER message is ignored (cursor never moves back)', (await stale) === null);

  console.log('\n--- 8. authorization + moderation over the socket ---');
  const forbidden = await alice2.emitWithAck('conversation:subscribe', { conversationId: uuid() });
  check('subscribing to a conversation you are not in is refused', forbidden?.ok === false, forbidden?.error?.code ?? '');

  const blocked = await alice2.emitWithAck('message:send', {
    conversationId: conv.id, clientMessageId: uuid(),
    content: { kind: 'TEXT', text: 'f u c k this' },
  });
  check('profanity blocked over the socket too', blocked?.ok === false && blocked?.error?.reason === 'PROFANITY');

  bobSock.disconnect(); alice2.disconnect();
  const failed = results.filter((r) => !r).length;
  console.log(`\n${failed === 0 ? 'ALL PASS' : failed + ' FAILURES'} (${results.length} checks)`);
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR', e); process.exit(1); });
