"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ChevronRight,
  Download,
  Heart,
  Image as ImageIcon,
  MessageCircle,
  MoreHorizontal,
  Sparkles,
  Trash2,
  UserRound,
  Wallpaper,
  X,
} from "lucide-react";

import { PageShell } from "@/components/ui/page-shell";
import {
  addGalleryComment,
  collectGalleryPhotos,
  findGallerySessionForPhoto,
  galleryPhotoDateLabel,
  hideGalleryPhoto,
  loadGalleryMeta,
  toggleGalleryFavorite,
  type GalleryMetaStore,
  type GalleryPhoto,
} from "@/lib/gallery-storage";
import { loadCharacters, saveCharacters } from "@/lib/character-storage";
import {
  loadChatMessages,
  loadChatSessions,
  saveChatSessions,
  type ChatMessage,
} from "@/lib/chat-storage";
import {
  loadUserIdentities,
  resolveUserIdentity,
  saveUserIdentities,
} from "@/lib/settings-storage";
import { flattenCompletionResult, generateChatCompletion } from "@/lib/chat-engine";
import { CHAT_OPEN_SESSION_EVENT } from "@/lib/chat-notification-events";
import { isMediaStoreRef, loadMediaBlob, loadMediaObjectUrl } from "@/lib/media-cache-storage";
import { normalizeThemeProfile } from "@/lib/theme-types";
import { readThemeProfile, saveThemeAssetFromBlob, writeThemeProfile } from "@/lib/theme-storage";

type GalleryTab = "photos" | "albums" | "memories";

type GalleryAppProps = {
  onClose: () => void;
};

function dataUrlToBlob(dataUrl: string): Blob | null {
  const match = dataUrl.match(/^data:([^;,]+)(;base64)?,(.*)$/);
  if (!match) return null;
  try {
    const raw = match[2] ? atob(match[3]) : decodeURIComponent(match[3]);
    const bytes = new Uint8Array(raw.length);
    for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
    return new Blob([bytes], { type: match[1] || "image/png" });
  } catch {
    return null;
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("图片读取失败"));
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.readAsDataURL(blob);
  });
}

async function resolvePhotoBlob(src: string): Promise<Blob | null> {
  if (isMediaStoreRef(src)) {
    return (await loadMediaBlob(src))?.blob ?? null;
  }
  if (src.startsWith("data:")) return dataUrlToBlob(src);
  try {
    const response = await fetch(src);
    if (!response.ok) return null;
    return await response.blob();
  } catch {
    return null;
  }
}

async function resolvePersistentImage(src: string): Promise<string | null> {
  if (src.startsWith("data:image/") || src.startsWith("http://") || src.startsWith("https://")) {
    return src;
  }
  const blob = await resolvePhotoBlob(src);
  return blob ? blobToDataUrl(blob) : null;
}

function GalleryImage({ photo, className }: { photo: GalleryPhoto; className?: string }) {
  const [src, setSrc] = useState<string>(() => isMediaStoreRef(photo.src) ? "" : photo.src);

  useEffect(() => {
    let active = true;
    let objectUrl: string | null = null;
    setSrc(isMediaStoreRef(photo.src) ? "" : photo.src);
    if (!isMediaStoreRef(photo.src)) return () => { active = false; };

    void loadMediaObjectUrl(photo.src).then((url) => {
      if (!active || !url) {
        if (url) URL.revokeObjectURL(url);
        return;
      }
      objectUrl = url;
      setSrc(url);
    });

    return () => {
      active = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [photo.src]);

  if (!src) {
    return (
      <div className={`${className ?? ""} grid place-items-center bg-white/55 text-[var(--c-text-muted)]`}>
        <ImageIcon size={22} strokeWidth={1.5} />
      </div>
    );
  }

  return <img src={src} alt={photo.title} className={className} loading="lazy" />;
}

function shortDate(photo: GalleryPhoto): string {
  const date = new Date(photo.createdAt);
  if (Number.isNaN(date.getTime()) || date.getTime() <= 0) return "头像";
  return `${date.getMonth() + 1}.${String(date.getDate()).padStart(2, "0")}`;
}

function cleanCommentText(text: string): string {
  const cleaned = text
    .replace(/\[(?:状态栏|内心|旁白)[\s\S]*?\]/g, "")
    .replace(/^[“\"']|[”\"']$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length <= 100) return cleaned;
  return `${cleaned.slice(0, 98).trim()}…`;
}

function GalleryTabs({ value, onChange }: { value: GalleryTab; onChange: (tab: GalleryTab) => void }) {
  const tabs: Array<{ id: GalleryTab; label: string }> = [
    { id: "photos", label: "照片" },
    { id: "albums", label: "相簿" },
    { id: "memories", label: "回忆" },
  ];
  return (
    <div className="sticky bottom-0 z-20 mt-auto border-t border-white/70 bg-[color-mix(in_srgb,var(--c-page-bg)_88%,transparent)] px-5 pb-[max(12px,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl">
      <div className="grid grid-cols-3 gap-2">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            onClick={() => onChange(tab.id)}
            className={`rounded-full px-3 py-2 text-[12px] font-semibold transition ${value === tab.id ? "bg-white text-[var(--c-text-title)] shadow-sm" : "text-[var(--c-text-muted)]"}`}
          >
            {tab.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export function GalleryApp({ onClose }: GalleryAppProps) {
  const [tab, setTab] = useState<GalleryTab>("photos");
  const [photos, setPhotos] = useState<GalleryPhoto[]>([]);
  const [meta, setMeta] = useState<GalleryMetaStore>({});
  const [selected, setSelected] = useState<GalleryPhoto | null>(null);
  const [albumFilter, setAlbumFilter] = useState<string | null>(null);
  const [showActions, setShowActions] = useState(false);
  const [commentBusy, setCommentBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setPhotos(collectGalleryPhotos());
    setMeta(loadGalleryMeta());
  }, []);

  useEffect(() => {
    refresh();
    const onChatChanged = () => refresh();
    window.addEventListener("chat-message-pushed", onChatChanged);
    window.addEventListener("chat-messages-deleted", onChatChanged);
    return () => {
      window.removeEventListener("chat-message-pushed", onChatChanged);
      window.removeEventListener("chat-messages-deleted", onChatChanged);
    };
  }, [refresh]);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 2400);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const visiblePhotos = useMemo(() => {
    if (!albumFilter) return photos;
    if (albumFilter === "favorites") return photos.filter((photo) => meta[photo.id]?.favorite);
    if (albumFilter === "avatars") return photos.filter((photo) => photo.source !== "chat");
    if (albumFilter === "chat") return photos.filter((photo) => photo.source === "chat");
    if (albumFilter.startsWith("character:")) {
      const characterId = albumFilter.slice("character:".length);
      return photos.filter((photo) => photo.characterId === characterId);
    }
    return photos;
  }, [albumFilter, meta, photos]);

  const grouped = useMemo(() => {
    const map = new Map<string, GalleryPhoto[]>();
    for (const photo of visiblePhotos) {
      const label = galleryPhotoDateLabel(photo);
      const current = map.get(label) ?? [];
      current.push(photo);
      map.set(label, current);
    }
    return Array.from(map.entries());
  }, [visiblePhotos]);

  const characterAlbums = useMemo(() => {
    const map = new Map<string, { id: string; name: string; photos: GalleryPhoto[] }>();
    for (const photo of photos) {
      if (!photo.characterId || !photo.characterName) continue;
      const current = map.get(photo.characterId) ?? { id: photo.characterId, name: photo.characterName, photos: [] };
      current.photos.push(photo);
      map.set(photo.characterId, current);
    }
    return Array.from(map.values()).sort((a, b) => b.photos.length - a.photos.length);
  }, [photos]);

  const memoryPhotos = useMemo(() => {
    const now = Date.now();
    return photos.filter((photo) => {
      const time = new Date(photo.createdAt).getTime();
      return Number.isFinite(time) && time > 0 && now - time >= 7 * 86_400_000;
    });
  }, [photos]);

  const oldestPhoto = useMemo(() => {
    return [...photos]
      .filter((photo) => new Date(photo.createdAt).getTime() > 0)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())[0] ?? null;
  }, [photos]);

  const openAlbum = (filter: string) => {
    setAlbumFilter(filter);
    setTab("photos");
  };

  const handleBack = () => {
    if (selected) {
      setSelected(null);
      setShowActions(false);
      return;
    }
    if (albumFilter) {
      setAlbumFilter(null);
      return;
    }
    onClose();
  };

  const handleToggleFavorite = (photo: GalleryPhoto) => {
    setMeta(toggleGalleryFavorite(photo.id));
  };

  const handleOpenChat = (photo: GalleryPhoto) => {
    const session = findGallerySessionForPhoto(photo);
    if (!session) {
      setNotice("这张照片没有可返回的聊天");
      return;
    }
    window.dispatchEvent(new CustomEvent("mascot-navigate", { detail: { app: "chat" } }));
    window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent(CHAT_OPEN_SESSION_EVENT, {
        detail: { sessionId: session.id, messageId: photo.messageId },
      }));
    }, 80);
  };

  const handleAskCharacter = async (photo: GalleryPhoto) => {
    const session = findGallerySessionForPhoto(photo);
    if (!session) {
      setNotice("还没有可以看这张照片的角色会话");
      return;
    }
    setCommentBusy(true);
    try {
      const characterId = photo.characterId;
      const history = loadChatMessages(session.id);
      const synthetic: ChatMessage = {
        id: `gallery_preview_${Date.now()}`,
        sessionId: session.id,
        role: "user",
        status: "sent",
        createdAt: new Date().toISOString(),
        content: "我在相册里翻到了这张照片。请只用你本人自然的语气，给这张照片留一句很短的私人留言。不要解释任务，不要写旁白、动作描写或状态栏，最多两句话。",
        mediaType: "image",
        mediaUrl: photo.src,
      };
      const result = await generateChatCompletion(session, [...history, synthetic], {
        appId: "gallery",
        appTags: ["gallery", "photo-memory"],
        attachedImages: [photo.src],
        toolsAllowed: false,
      });
      const text = cleanCommentText(flattenCompletionResult(result));
      if (!text) throw new Error("角色没有留下文字");
      const character = characterId ? loadCharacters().find((item) => item.id === characterId) : undefined;
      setMeta(addGalleryComment(photo.id, {
        text,
        characterId,
        characterName: character?.name ?? photo.characterName,
      }));
      setNotice("TA 留下了一句话");
    } catch (error) {
      console.warn("[Gallery] character comment failed", error);
      setNotice(error instanceof Error ? error.message : "暂时没能收到 TA 的留言");
    } finally {
      setCommentBusy(false);
    }
  };

  const handleSetCharacterAvatar = async (photo: GalleryPhoto) => {
    if (!photo.characterId) {
      setNotice("这张照片没有关联角色");
      return;
    }
    const persistent = await resolvePersistentImage(photo.src);
    if (!persistent) {
      setNotice("图片读取失败");
      return;
    }
    const characters = loadCharacters();
    const index = characters.findIndex((item) => item.id === photo.characterId);
    if (index < 0) return;
    const next = [...characters];
    next[index] = { ...next[index], avatar: persistent, updatedAt: new Date().toISOString() };
    saveCharacters(next);
    setNotice(`已设为 ${next[index].name} 的头像`);
    setShowActions(false);
  };

  const handleSetMyAvatar = async (photo: GalleryPhoto) => {
    const persistent = await resolvePersistentImage(photo.src);
    if (!persistent) {
      setNotice("图片读取失败");
      return;
    }
    const identities = loadUserIdentities();
    const current = resolveUserIdentity(photo.characterId, "chat") ?? identities[0];
    if (!current) {
      setNotice("请先在设置里创建用户身份");
      return;
    }
    saveUserIdentities(identities.map((identity) => identity.id === current.id ? { ...identity, avatarUrl: persistent } : identity));
    setNotice(`已设为「${current.name || "我的身份"}」头像`);
    setShowActions(false);
  };

  const handleSetChatBackground = async (photo: GalleryPhoto) => {
    const session = findGallerySessionForPhoto(photo);
    if (!session) {
      setNotice("这张照片没有关联聊天");
      return;
    }
    const persistent = await resolvePersistentImage(photo.src);
    if (!persistent) {
      setNotice("图片读取失败");
      return;
    }
    const sessions = loadChatSessions();
    saveChatSessions(sessions.map((item) => item.id === session.id ? { ...item, backgroundImage: persistent } : item));
    setNotice("已设为聊天背景");
    setShowActions(false);
  };

  const handleSetWallpaper = async (photo: GalleryPhoto) => {
    const blob = await resolvePhotoBlob(photo.src);
    if (!blob) {
      setNotice("图片读取失败");
      return;
    }
    try {
      const assetId = await saveThemeAssetFromBlob(blob, "wallpaper");
      const current = readThemeProfile();
      const next = normalizeThemeProfile({
        ...current,
        wallpaperAssetId: assetId,
        wallpaperLibrary: Array.from(new Set([...current.wallpaperLibrary, assetId])),
      });
      writeThemeProfile(next);
      setNotice("已设为桌面壁纸，重新进入鲜果机后生效");
      setShowActions(false);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "设置壁纸失败");
    }
  };

  const handleDownload = async (photo: GalleryPhoto) => {
    const blob = await resolvePhotoBlob(photo.src);
    if (!blob) {
      setNotice("图片读取失败");
      return;
    }
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `xianguo-photo-${Date.now()}.${blob.type.includes("png") ? "png" : blob.type.includes("webp") ? "webp" : "jpg"}`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setNotice("已开始保存图片");
    setShowActions(false);
  };

  const handleRemove = (photo: GalleryPhoto) => {
    if (!window.confirm("从相册中移除这张图片？聊天中的原消息不会被删除。")) return;
    setMeta(hideGalleryPhoto(photo.id));
    setSelected(null);
    setShowActions(false);
    setPhotos(collectGalleryPhotos());
    setNotice("已从相册移除");
  };

  const comments = selected ? meta[selected.id]?.comments ?? [] : [];

  if (selected) {
    return (
      <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--c-page-bg)]">
        <div className="flex h-14 shrink-0 items-center justify-between px-4">
          <button type="button" onClick={handleBack} className="grid h-9 w-9 place-items-center rounded-full bg-white/70 text-[var(--c-text-title)] shadow-sm">
            <ArrowLeft size={18} />
          </button>
          <div className="text-center">
            <div className="text-[13px] font-semibold text-[var(--c-text-title)]">{selected.title}</div>
            <div className="text-[10px] text-[var(--c-text-muted)]">{galleryPhotoDateLabel(selected)}</div>
          </div>
          <button type="button" onClick={() => setShowActions(true)} className="grid h-9 w-9 place-items-center rounded-full bg-white/70 text-[var(--c-text-title)] shadow-sm">
            <MoreHorizontal size={19} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-28">
          <div className="overflow-hidden rounded-[28px] bg-white/60 shadow-[0_12px_40px_rgba(83,64,76,0.10)]">
            <GalleryImage photo={selected} className="block max-h-[58vh] w-full object-contain" />
          </div>

          {selected.caption && selected.caption !== selected.title && (
            <p className="mx-2 mt-3 text-[12px] leading-5 text-[var(--c-text-muted)]">{selected.caption}</p>
          )}

          <div className="mt-4 grid grid-cols-3 gap-2">
            <button type="button" onClick={() => handleToggleFavorite(selected)} className="flex flex-col items-center gap-1.5 rounded-[18px] bg-white/65 px-2 py-3 text-[11px] text-[var(--c-text-title)] shadow-sm">
              <Heart size={18} fill={meta[selected.id]?.favorite ? "currentColor" : "none"} />
              {meta[selected.id]?.favorite ? "已收藏" : "收藏"}
            </button>
            <button type="button" onClick={() => handleOpenChat(selected)} className="flex flex-col items-center gap-1.5 rounded-[18px] bg-white/65 px-2 py-3 text-[11px] text-[var(--c-text-title)] shadow-sm">
              <MessageCircle size={18} />
              回到聊天
            </button>
            <button type="button" disabled={commentBusy} onClick={() => void handleAskCharacter(selected)} className="flex flex-col items-center gap-1.5 rounded-[18px] bg-white/65 px-2 py-3 text-[11px] text-[var(--c-text-title)] shadow-sm disabled:opacity-50">
              <Sparkles size={18} />
              {commentBusy ? "TA在看…" : "给TA看"}
            </button>
          </div>

          {comments.length > 0 && (
            <section className="mt-5">
              <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.14em] text-[var(--c-text-muted)]">PHOTO NOTES</div>
              <div className="space-y-2">
                {[...comments].reverse().map((comment) => (
                  <div key={comment.id} className="rounded-[20px] bg-white/72 px-4 py-3 shadow-sm">
                    <div className="text-[11px] font-semibold text-[var(--c-text-title)]">{comment.characterName || "TA"}</div>
                    <div className="mt-1 text-[13px] leading-5 text-[var(--c-text)]">{comment.text}</div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        {showActions && (
          <div className="absolute inset-0 z-40 flex items-end bg-black/20 p-3 backdrop-blur-[2px]" onClick={() => setShowActions(false)}>
            <div className="w-full rounded-[28px] bg-[var(--c-page-bg)] p-3 shadow-2xl" onClick={(event) => event.stopPropagation()}>
              <div className="mb-2 flex items-center justify-between px-2 py-1">
                <span className="text-[12px] font-semibold text-[var(--c-text-title)]">使用这张照片</span>
                <button type="button" onClick={() => setShowActions(false)} className="grid h-8 w-8 place-items-center rounded-full bg-white/70"><X size={16} /></button>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <ActionButton icon={<UserRound size={16} />} label="设为角色头像" onClick={() => void handleSetCharacterAvatar(selected)} disabled={!selected.characterId} />
                <ActionButton icon={<UserRound size={16} />} label="设为我的头像" onClick={() => void handleSetMyAvatar(selected)} />
                <ActionButton icon={<ImageIcon size={16} />} label="设为聊天背景" onClick={() => void handleSetChatBackground(selected)} disabled={!findGallerySessionForPhoto(selected)} />
                <ActionButton icon={<Wallpaper size={16} />} label="设为桌面壁纸" onClick={() => void handleSetWallpaper(selected)} />
                <ActionButton icon={<Download size={16} />} label="保存到设备" onClick={() => void handleDownload(selected)} />
                <ActionButton icon={<Trash2 size={16} />} label="从相册移除" onClick={() => handleRemove(selected)} danger />
              </div>
            </div>
          </div>
        )}

        {notice && <Toast text={notice} />}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-[var(--c-page-bg)]">
      <PageShell title={albumFilter ? "相簿" : "相册"} onBack={handleBack}>
        <div className="flex min-h-full flex-col pb-2">
          {tab === "photos" && (
            <div className="px-1 pb-3">
              {albumFilter && (
                <div className="mb-3 flex items-center justify-between rounded-[18px] bg-white/60 px-4 py-2.5">
                  <span className="text-[12px] font-semibold text-[var(--c-text-title)]">{albumFilter === "favorites" ? "我的收藏" : albumFilter === "avatars" ? "头像" : albumFilter === "chat" ? "聊天图片" : characterAlbums.find((album) => `character:${album.id}` === albumFilter)?.name || "相簿"}</span>
                  <button type="button" className="text-[11px] text-[var(--c-text-muted)]" onClick={() => setAlbumFilter(null)}>全部照片</button>
                </div>
              )}

              {grouped.length === 0 ? (
                <EmptyState title="这里还没有照片" body="聊天里出现的图片和头像会自动来到这里。" />
              ) : grouped.map(([label, items]) => (
                <section key={label} className="mb-5">
                  <div className="mb-2 flex items-end justify-between px-1">
                    <h3 className="m-0 text-[15px] font-semibold text-[var(--c-text-title)]">{label}</h3>
                    <span className="text-[10px] text-[var(--c-text-muted)]">{items.length} 张</span>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {items.map((photo) => (
                      <button key={photo.id} type="button" className="group relative aspect-square overflow-hidden rounded-[15px] bg-white/55" onClick={() => setSelected(photo)}>
                        <GalleryImage photo={photo} className="h-full w-full object-cover transition duration-200 group-active:scale-[0.98]" />
                        {meta[photo.id]?.favorite && <Heart size={13} fill="white" className="absolute right-2 top-2 text-white drop-shadow" />}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
            </div>
          )}

          {tab === "albums" && (
            <div className="space-y-5 px-1 pb-5">
              <section>
                <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.14em] text-[var(--c-text-muted)]">AUTO ALBUMS</div>
                <div className="grid grid-cols-2 gap-2.5">
                  <AlbumCard title="聊天图片" count={photos.filter((photo) => photo.source === "chat").length} photo={photos.find((photo) => photo.source === "chat")} onClick={() => openAlbum("chat")} />
                  <AlbumCard title="头像" count={photos.filter((photo) => photo.source !== "chat").length} photo={photos.find((photo) => photo.source !== "chat")} onClick={() => openAlbum("avatars")} />
                  <AlbumCard title="我的收藏" count={photos.filter((photo) => meta[photo.id]?.favorite).length} photo={photos.find((photo) => meta[photo.id]?.favorite)} onClick={() => openAlbum("favorites")} />
                </div>
              </section>

              {characterAlbums.length > 0 && (
                <section>
                  <div className="mb-2 px-1 text-[11px] font-semibold tracking-[0.14em] text-[var(--c-text-muted)]">WITH THEM</div>
                  <div className="space-y-2">
                    {characterAlbums.map((album) => (
                      <button key={album.id} type="button" onClick={() => openAlbum(`character:${album.id}`)} className="flex w-full items-center gap-3 rounded-[20px] bg-white/62 p-2.5 text-left shadow-sm">
                        <GalleryImage photo={album.photos[0]} className="h-14 w-14 shrink-0 rounded-[15px] object-cover" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-[var(--c-text-title)]">和 {album.name} 的照片</div>
                          <div className="mt-0.5 text-[10px] text-[var(--c-text-muted)]">{album.photos.length} 张照片</div>
                        </div>
                        <ChevronRight size={16} className="text-[var(--c-text-muted)]" />
                      </button>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}

          {tab === "memories" && (
            <div className="space-y-4 px-1 pb-5">
              {oldestPhoto && (
                <button type="button" className="relative block w-full overflow-hidden rounded-[26px] bg-white/60 text-left shadow-sm" onClick={() => setSelected(oldestPhoto)}>
                  <GalleryImage photo={oldestPhoto} className="h-48 w-full object-cover" />
                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/55 to-transparent p-4 pt-12 text-white">
                    <div className="text-[10px] font-semibold tracking-[0.14em] opacity-80">FIRST PHOTO</div>
                    <div className="mt-1 text-[18px] font-semibold">最早的一张</div>
                    <div className="mt-0.5 text-[11px] opacity-85">{oldestPhoto.title} · {shortDate(oldestPhoto)}</div>
                  </div>
                </button>
              )}

              {memoryPhotos.length > 0 ? (
                <section className="rounded-[24px] bg-white/58 p-3 shadow-sm">
                  <div className="mb-3 px-1">
                    <div className="text-[15px] font-semibold text-[var(--c-text-title)]">一些之前的回忆</div>
                    <div className="mt-0.5 text-[10px] text-[var(--c-text-muted)]">七天以前留下的照片</div>
                  </div>
                  <div className="grid grid-cols-3 gap-1.5">
                    {memoryPhotos.slice(0, 9).map((photo) => (
                      <button key={photo.id} type="button" className="aspect-square overflow-hidden rounded-[14px]" onClick={() => setSelected(photo)}>
                        <GalleryImage photo={photo} className="h-full w-full object-cover" />
                      </button>
                    ))}
                  </div>
                </section>
              ) : (
                <EmptyState title="回忆正在慢慢长大" body="使用一段时间后，这里会出现以前的照片。" />
              )}
            </div>
          )}
        </div>
      </PageShell>
      <GalleryTabs value={tab} onChange={(next) => { setAlbumFilter(null); setTab(next); }} />
      {notice && <Toast text={notice} />}
    </div>
  );
}

function AlbumCard({ title, count, photo, onClick }: { title: string; count: number; photo?: GalleryPhoto; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="overflow-hidden rounded-[20px] bg-white/62 text-left shadow-sm">
      <div className="aspect-[4/3] bg-white/45">
        {photo ? <GalleryImage photo={photo} className="h-full w-full object-cover" /> : <div className="grid h-full place-items-center text-[var(--c-text-muted)]"><ImageIcon size={24} /></div>}
      </div>
      <div className="px-3 py-2.5">
        <div className="text-[12px] font-semibold text-[var(--c-text-title)]">{title}</div>
        <div className="mt-0.5 text-[10px] text-[var(--c-text-muted)]">{count} 张</div>
      </div>
    </button>
  );
}

function ActionButton({ icon, label, onClick, disabled, danger }: { icon: React.ReactNode; label: string; onClick: () => void; disabled?: boolean; danger?: boolean }) {
  return (
    <button type="button" disabled={disabled} onClick={onClick} className={`flex items-center gap-2.5 rounded-[18px] bg-white/72 px-3 py-3 text-left text-[11px] font-medium shadow-sm disabled:opacity-35 ${danger ? "text-red-500" : "text-[var(--c-text-title)]"}`}>
      {icon}
      <span>{label}</span>
    </button>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex min-h-[300px] flex-col items-center justify-center px-8 text-center">
      <div className="grid h-14 w-14 place-items-center rounded-[22px] bg-white/65 text-[var(--c-text-muted)] shadow-sm"><ImageIcon size={24} strokeWidth={1.5} /></div>
      <div className="mt-4 text-[14px] font-semibold text-[var(--c-text-title)]">{title}</div>
      <div className="mt-1 max-w-[230px] text-[11px] leading-5 text-[var(--c-text-muted)]">{body}</div>
    </div>
  );
}

function Toast({ text }: { text: string }) {
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-20 z-50 flex justify-center px-5">
      <div className="rounded-full bg-black/72 px-4 py-2 text-[11px] text-white shadow-lg backdrop-blur">{text}</div>
    </div>
  );
}
