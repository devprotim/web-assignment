/**
 * Seeds two demo accounts and a conversation large enough to prove the
 * pagination claims: the assignment says to assume 10,000+ messages, and a
 * virtual-scrolling history endpoint is only credible against real volume.
 *
 * Message ids are backdated UUIDv7s so `ORDER BY id` reflects the intended
 * chronology, exactly as it would with organically created messages.
 */
import { resolve } from 'node:path';
import { config as loadEnv } from 'dotenv';
import * as argon2 from 'argon2';
import { v7 as uuidv7 } from 'uuid';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';

loadEnv({ path: resolve(import.meta.dirname, '../../../.env') });

const MESSAGE_COUNT = 10_050;
const BATCH_SIZE = 1_000;

const DEMO_PASSWORD = 'demo-password-123';

const SAMPLES = [
  'Morning! Did you get a chance to look at the deploy?',
  'Yes, it went out about an hour ago.',
  'Nice. Any errors in the logs?',
  'Nothing so far. Latency looks flat.',
  'Good. I will keep an eye on it this afternoon.',
  'Do you want to pair on the pagination work later?',
  'Sure, after standup works for me.',
  'I pushed the index migration, take a look when you can.',
  'Looks reasonable. One question about the cursor.',
  'Ask away.',
];

async function main(): Promise<void> {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
  const prisma = new PrismaClient({ adapter });

  const passwordHash = await argon2.hash(DEMO_PASSWORD, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  const alice = await prisma.user.upsert({
    where: { email: 'alice@demo.chat' },
    update: {},
    create: { id: uuidv7(), email: 'alice@demo.chat', displayName: 'Alice Nguyen', passwordHash },
  });
  const bob = await prisma.user.upsert({
    where: { email: 'bob@demo.chat' },
    update: {},
    create: { id: uuidv7(), email: 'bob@demo.chat', displayName: 'Bob Marsh', passwordHash },
  });

  const directKey = [alice.id, bob.id].sort().join(':');
  const conversation = await prisma.conversation.upsert({
    where: { directKey },
    update: {},
    create: {
      id: uuidv7(),
      type: 'DIRECT',
      directKey,
      members: { create: [{ userId: alice.id }, { userId: bob.id }] },
    },
  });

  const existing = await prisma.message.count({ where: { conversationId: conversation.id } });
  const alreadySeeded = existing >= MESSAGE_COUNT;

  // Spread the history over the past 30 days, one message every ~4 minutes.
  const startMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const stepMs = Math.floor((30 * 24 * 60 * 60 * 1000) / MESSAGE_COUNT);

  if (alreadySeeded) console.log(`Main conversation already has ${existing} messages.`);
  else console.log(`Seeding ${MESSAGE_COUNT} messages...`);

  let lastCreatedAt = new Date(startMs);

  for (let offset = 0; alreadySeeded ? false : offset < MESSAGE_COUNT; offset += BATCH_SIZE) {
    const batch = [];
    for (let i = offset; i < Math.min(offset + BATCH_SIZE, MESSAGE_COUNT); i++) {
      const msecs = startMs + i * stepMs;
      const sender = i % 2 === 0 ? alice : bob;
      lastCreatedAt = new Date(msecs);
      batch.push({
        id: uuidv7({ msecs }),
        conversationId: conversation.id,
        senderId: sender.id,
        clientMessageId: uuidv7({ msecs }),
        kind: 'TEXT' as const,
        status: 'VISIBLE' as const,
        body: `${SAMPLES[i % SAMPLES.length]} (#${i + 1})`,
        createdAt: lastCreatedAt,
      });
    }
    await prisma.message.createMany({ data: batch, skipDuplicates: true });
    process.stdout.write(`  ${Math.min(offset + BATCH_SIZE, MESSAGE_COUNT)}/${MESSAGE_COUNT}\r`);
  }

  if (!alreadySeeded) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: lastCreatedAt },
    });
  }

  // Alice has read everything; Bob is left with a backlog so the unread badge
  // has something to show on first load.
  const newest = await prisma.message.findFirst({
    where: { conversationId: conversation.id },
    orderBy: { id: 'desc' },
    select: { id: true },
  });
  if (newest) {
    await prisma.conversationMember.update({
      where: { conversationId_userId: { conversationId: conversation.id, userId: alice.id } },
      data: { lastReadMessageId: newest.id, lastDeliveredMessageId: newest.id },
    });
  }

  await seedBackgroundConversations(prisma, alice.id, bob.id, startMs, stepMs);

  console.log(`\nSeeded conversation ${conversation.id}`);
  console.log(`  alice@demo.chat / ${DEMO_PASSWORD}`);
  console.log(`  bob@demo.chat   / ${DEMO_PASSWORD}`);
  await prisma.$disconnect();
}

/**
 * Interleaves other conversations into the same table.
 *
 * Without these, `messages` holds exactly one conversation, and Postgres can
 * answer a history query by walking the primary key backwards because every row
 * it meets happens to match. That would make any claim about the
 * `(conversationId, id DESC)` index untestable. A realistic mix of conversations
 * is what forces the planner to actually use it.
 */
async function seedBackgroundConversations(
  prisma: PrismaClient,
  aliceId: string,
  bobId: string,
  startMs: number,
  stepMs: number,
): Promise<void> {
  const OTHER_USERS = 12;
  const MESSAGES_EACH = 400;

  const passwordHash = await argon2.hash('demo-password-123', {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  console.log(`Seeding ${OTHER_USERS} background conversations...`);

  for (let u = 0; u < OTHER_USERS; u++) {
    const email = `demo${u}@demo.chat`;
    const other = await prisma.user.upsert({
      where: { email },
      update: {},
      create: { id: uuidv7(), email, displayName: `Demo User ${u + 1}`, passwordHash },
    });

    const partner = u % 2 === 0 ? aliceId : bobId;
    const directKey = [partner, other.id].sort().join(':');
    const convo = await prisma.conversation.upsert({
      where: { directKey },
      update: {},
      create: {
        id: uuidv7(),
        type: 'DIRECT',
        directKey,
        members: { create: [{ userId: partner }, { userId: other.id }] },
      },
    });

    const existing = await prisma.message.count({ where: { conversationId: convo.id } });
    if (existing >= MESSAGES_EACH) continue;

    const batch = [];
    let last = new Date(startMs);
    for (let i = 0; i < MESSAGES_EACH; i++) {
      // Interleaved with the main conversation's timeline, not appended after it.
      const msecs = startMs + i * stepMs * Math.floor(MESSAGE_COUNT / MESSAGES_EACH);
      last = new Date(msecs);
      batch.push({
        id: uuidv7({ msecs }),
        conversationId: convo.id,
        senderId: i % 2 === 0 ? partner : other.id,
        clientMessageId: uuidv7({ msecs }),
        kind: 'TEXT' as const,
        status: 'VISIBLE' as const,
        body: `${SAMPLES[i % SAMPLES.length]} (#${i + 1})`,
        createdAt: last,
      });
    }
    await prisma.message.createMany({ data: batch, skipDuplicates: true });
    await prisma.conversation.update({
      where: { id: convo.id },
      data: { lastMessageAt: last },
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
