"use client";

import { useEffect } from "react";

import {
  ICON_LAYOUT_STORAGE_KEY,
  getDesktopIconLayoutItems,
  getDesktopPageKey,
  getDesktopPageKeys,
  getDesktopPageNumber,
  loadDesktopFolders,
  loadDockLayout,
  normalizeDesktopIconLayout,
  writeDesktopIconLayout,
} from "@/lib/desktop-layout-storage";
import { hydrateKvDb, kvGet } from "@/lib/kv-db";
import { GRID_COLS, GRID_ROWS } from "@/lib/widget-types";
import { buildOccupancyGrid, loadWidgets } from "@/lib/widget-storage";

const GALLERY_ICON_ID = "gallery" as const;

function findFreeCell(grid: (string | null)[][]): { row: number; col: number } | null {
  const preferred: Array<[number, number]> = [
    [6, 3], [6, 4], [6, 2], [6, 1],
    [5, 3], [5, 4], [5, 2], [5, 1],
  ];

  for (const [row, col] of preferred) {
    if (row <= GRID_ROWS && col <= GRID_COLS && grid[row - 1]?.[col - 1] === null) {
      return { row, col };
    }
  }

  for (let row = 1; row <= GRID_ROWS; row += 1) {
    for (let col = 1; col <= GRID_COLS; col += 1) {
      if (grid[row - 1]?.[col - 1] === null) return { row, col };
    }
  }
  return null;
}

async function ensureGalleryIconOnDesktop(): Promise<void> {
  await hydrateKvDb();

  const raw = kvGet(ICON_LAYOUT_STORAGE_KEY);
  // 没有持久化布局时，DesktopShell 会直接使用新的默认布局；无需额外写入。
  if (!raw) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }

  const folders = loadDesktopFolders();
  const folderIds = new Set(Object.keys(folders));
  const layout = normalizeDesktopIconLayout(parsed, folderIds);
  const alreadyPlaced = getDesktopIconLayoutItems(layout).some((item) => item.id === GALLERY_ICON_ID)
    || loadDockLayout().includes(GALLERY_ICON_ID);
  if (alreadyPlaced) return;

  const widgets = loadWidgets();
  const existingPages = getDesktopPageKeys(layout);
  const pageNumbers = existingPages.map(getDesktopPageNumber).filter((page) => page > 0);

  // 优先第三页：默认第三页底部有空位；若用户已自定义，则寻找任何真正空闲的格子。
  const orderedPages = Array.from(new Set([
    3,
    ...pageNumbers,
  ])).filter((page) => page >= 1);

  for (const page of orderedPages) {
    const pageKey = getDesktopPageKey(page);
    const icons = layout[pageKey] ?? [];
    const grid = buildOccupancyGrid(icons, widgets, page);
    const cell = findFreeCell(grid);
    if (!cell) continue;
    layout[pageKey] = [...icons, { id: GALLERY_ICON_ID, ...cell }];
    writeDesktopIconLayout(layout, folderIds);
    return;
  }

  // 所有现有页面都满了时才新建一页，绝不移动用户已有图标或组件。
  const highestWidgetPage = widgets.reduce((max, widget) => Math.max(max, widget.page), 0);
  const nextPage = Math.max(3, highestWidgetPage, ...pageNumbers) + 1;
  const pageKey = getDesktopPageKey(nextPage);
  layout[pageKey] = [{ id: GALLERY_ICON_ID, row: 5, col: 1 }];
  writeDesktopIconLayout(layout, folderIds);
}

export function GalleryBootstrap() {
  useEffect(() => {
    void ensureGalleryIconOnDesktop().catch((error) => {
      console.warn("[Gallery] desktop icon migration failed", error);
    });
  }, []);

  return null;
}
