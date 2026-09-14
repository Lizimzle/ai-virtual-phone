import { loadCharacters } from "@/lib/character-storage";
import {
  loadChatContacts,
  loadChatMessages,
  loadChatSessions,
  type ChatMessage,
  type ChatSession,
} from "@/lib/chat-storage";
import { loadUserIdentities } from "@/lib/settings-storage";
import { kvGet, kvSet, registerKvMigration } from "@/lib/kv-db";

export type GalleryPhotoSource = "chat" | "character-avatar" | "user-avatar";

export type GalleryPhoto = {
  id: string;
  src: string;
  createdAt: string;
  source: GalleryPhotoSource;
  title: string;
  characterId?: string;
  characterName?: string;
  sessionId?: string;
  messageId?: string;
  role?: ChatMessage["role"];
  caption?: string;
};

export type GalleryComment = {
  id: string;
  text: string;
  characterId?: string;
  characterName?: string;
  createdAt: string;
};

export type GalleryPhotoMeta = {
  favorite?: boolean;
  hidden?: boolean;
  comments?: GalleryComment[];
};

export type GalleryMetaStore = Record<string, GalleryPhotoMeta>;

const GALLERY_META_STORAGE_KEY = "ai_phone_gallery_meta_v1";
registerKvMigration(GALLERY_META_STORAGE_KEY);

function safeIso(value: unknown, fallback = new Date(0).toISOString()): string {
  if (typeof value !== "string" || !value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function validImageRef(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const src = value.trim();
  return Boolean(
    src && (
      src.startsWith("data:image/") ||
      src.startsWith("media-store://") ||
      src.startsWith("blob:") ||
      src.startsWith("http://") ||
      src.startsWith("https://") ||
      src.startsWith("/")
    )
  );
}

function isGalleryImageMessage(message: ChatMessage): boolean {
  if (!validImageRef(message.mediaUrl)) return false;
  if (message.mediaType === "image") return true;
  return message.mediaType === "media_file" && message.mediaData?.fileType === "image";
}

function sessionCharacterId(session: ChatSession): string | undefined {
  if (session.isGroup) return undefined;
  const contact = loadChatContacts().find((item) => item.id === session.contactId);
  return contact?.characterId;
}

export function loadGalleryMeta(): GalleryMetaStore {
  if (typeof window === "undefined") return {};
  try {
    const raw = kvGet(GALLERY_META_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as GalleryMetaStore
      : {};
  } catch {
    return {};
  }
}

export function saveGalleryMeta(meta: GalleryMetaStore): void {
  if (typeof window === "undefined") return;
  kvSet(GALLERY_META_STORAGE_KEY, JSON.stringify(meta));
}

export function updateGalleryPhotoMeta(
  photoId: string,
  updater: (current: GalleryPhotoMeta) => GalleryPhotoMeta,
): GalleryMetaStore {
  const current = loadGalleryMeta();
  const next = {
    ...current,
    [photoId]: updater(current[photoId] ?? {}),
  };
  saveGalleryMeta(next);
  return next;
}

export function toggleGalleryFavorite(photoId: string): GalleryMetaStore {
  return updateGalleryPhotoMeta(photoId, (current) => ({
    ...current,
    favorite: !current.favorite,
  }));
}

export function hideGalleryPhoto(photoId: string): GalleryMetaStore {
  return updateGalleryPhotoMeta(photoId, (current) => ({ ...current, hidden: true }));
}

export function addGalleryComment(photoId: string, comment: Omit<GalleryComment, "id" | "createdAt">): GalleryMetaStore {
  return updateGalleryPhotoMeta(photoId, (current) => ({
    ...current,
    comments: [
      ...(current.comments ?? []),
      {
        ...comment,
        id: `gallery_comment_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        createdAt: new Date().toISOString(),
      },
    ],
  }));
}

export function collectGalleryPhotos(): GalleryPhoto[] {
  if (typeof window === "undefined") return [];

  const characters = loadCharacters();
  const characterMap = new Map(characters.map((character) => [character.id, character]));
  const contacts = loadChatContacts();
  const contactMap = new Map(contacts.map((contact) => [contact.id, contact]));
  const photos: GalleryPhoto[] = [];

  for (const session of loadChatSessions()) {
    const privateCharacterId = session.isGroup ? undefined : contactMap.get(session.contactId)?.characterId;
    for (const message of loadChatMessages(session.id)) {
      if (!isGalleryImageMessage(message) || !message.mediaUrl) continue;

      const characterId = message.role === "assistant"
        ? (message.senderCharacterId ?? privateCharacterId)
        : privateCharacterId;
      const character = characterId ? characterMap.get(characterId) : undefined;
      const senderLabel = message.role === "user"
        ? "我发送的图片"
        : character?.name
          ? `${character.name} 发来的图片`
          : "聊天图片";

      photos.push({
        id: `chat:${message.id}`,
        src: message.mediaUrl,
        createdAt: safeIso(message.createdAt),
        source: "chat",
        title: senderLabel,
        characterId,
        characterName: character?.name,
        sessionId: session.id,
        messageId: message.id,
        role: message.role,
        caption: message.mediaData?.label || message.content || undefined,
      });
    }
  }

  for (const character of characters) {
    if (!validImageRef(character.avatar)) continue;
    photos.push({
      id: `character-avatar:${character.id}`,
      src: character.avatar,
      createdAt: safeIso(character.updatedAt ?? character.createdAt),
      source: "character-avatar",
      title: `${character.name} 的头像`,
      characterId: character.id,
      characterName: character.name,
      caption: "角色头像",
    });
  }

  for (const identity of loadUserIdentities()) {
    if (!validImageRef(identity.avatarUrl)) continue;
    photos.push({
      id: `user-avatar:${identity.id}`,
      src: identity.avatarUrl,
      createdAt: new Date(0).toISOString(),
      source: "user-avatar",
      title: `${identity.name || "我"} 的头像`,
      caption: "我的头像",
    });
  }

  const meta = loadGalleryMeta();
  return photos
    .filter((photo) => !meta[photo.id]?.hidden)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function findGallerySessionForPhoto(photo: GalleryPhoto): ChatSession | null {
  const sessions = loadChatSessions();
  if (photo.sessionId) {
    return sessions.find((session) => session.id === photo.sessionId) ?? null;
  }
  if (!photo.characterId) return null;
  return sessions.find((session) => sessionCharacterId(session) === photo.characterId) ?? null;
}

export function galleryPhotoDateLabel(photo: GalleryPhoto): string {
  const date = new Date(photo.createdAt);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "头像";
  const today = new Date();
  const startToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const startTarget = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startToday - startTarget) / 86_400_000);
  if (diffDays === 0) return "今天";
  if (diffDays === 1) return "昨天";
  if (date.getFullYear() === today.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`;
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
