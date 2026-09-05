/**
 * The bundled sticker pack.
 *
 * Defined here rather than fetched from an API because stickers are static
 * public assets, not user data: no authorization, no round trip, and the client
 * can render the picker immediately on first paint. The SVGs live in the web
 * app's static assets and are a few KB each, so they cost nothing to cache.
 */

export interface Sticker {
  id: string;
  /** Used as the accessible label and the picker's search term. */
  label: string;
  url: string;
}

export interface StickerPack {
  id: string;
  name: string;
  stickers: Sticker[];
}

const sticker = (id: string, label: string): Sticker => ({
  id,
  label,
  url: `/stickers/${id}.svg`,
});

export const STICKER_PACKS: StickerPack[] = [
  {
    id: 'basics',
    name: 'Basics',
    stickers: [
      sticker('thumbs-up', 'Thumbs up'),
      sticker('heart', 'Heart'),
      sticker('laughing', 'Laughing'),
      sticker('thinking', 'Thinking'),
      sticker('party', 'Party'),
      sticker('sad', 'Sad'),
      sticker('fire', 'Fire'),
      sticker('ok-hand', 'OK'),
    ],
  },
];

const byKey = new Map(
  STICKER_PACKS.flatMap((pack) =>
    pack.stickers.map((s) => [`${pack.id}/${s.id}`, s] as const),
  ),
);

/**
 * Resolves a sticker reference from a message. Returns null for anything not in
 * the pack, so a client cannot make the UI render an arbitrary URL by sending a
 * made-up sticker id.
 */
export function resolveSticker(packId: string, stickerId: string): Sticker | null {
  return byKey.get(`${packId}/${stickerId}`) ?? null;
}
