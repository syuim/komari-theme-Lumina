import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

interface CanvasStripProps {
  className?: string;
  height: number;
  ariaHidden?: boolean;
  redrawKey?: string | number;
  draw: (ctx: CanvasRenderingContext2D, width: number, height: number) => void;
  getHoverIndex?: (offsetX: number, width: number) => number | null;
  onHoverIndex?: (index: number | null) => void;
}

/**
 * 主题只有 light/dark 两套 CSS 变量，取值在一次外观内是常量。
 * 首页每轮重绘会有上百次 getPropertyValue，这里按外观缓存结果。
 */
const cssColorCache = new Map<string, string>();
let cssColorCacheKey = "";

function currentAppearanceKey() {
  return typeof document === "undefined"
    ? ""
    : document.documentElement.dataset.appearance ?? "";
}

export function resolveCssColor(
  color: string,
  styles?: CSSStyleDeclaration,
): string {
  const match = color.match(/^var\((--[^),\s]+)/);
  if (!match) return color;

  const appearanceKey = currentAppearanceKey();
  if (appearanceKey !== cssColorCacheKey) {
    cssColorCache.clear();
    cssColorCacheKey = appearanceKey;
  }

  const cached = cssColorCache.get(color);
  if (cached !== undefined) return cached;

  const resolvedStyles = styles ?? getComputedStyle(document.documentElement);
  const resolved = resolvedStyles.getPropertyValue(match[1]).trim() || color;
  cssColorCache.set(color, resolved);
  return resolved;
}

export function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
) {
  const safeRadius = Math.max(0, Math.min(radius, width / 2, height / 2));
  ctx.beginPath();
  ctx.moveTo(x + safeRadius, y);
  ctx.lineTo(x + width - safeRadius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  ctx.lineTo(x + width, y + height - safeRadius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  ctx.lineTo(x + safeRadius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  ctx.lineTo(x, y + safeRadius);
  ctx.quadraticCurveTo(x, y, x + safeRadius, y);
  ctx.closePath();
  ctx.fill();
}

/**
 * 首页一张卡片就有 8 条画布，节点一多每条各建一个 ResizeObserver 开销可观，
 * 这里全局共用一个实例分发尺寸变化。
 */
type SizeListener = (width: number) => void;
const sizeListeners = new WeakMap<Element, SizeListener>();
let sharedSizeObserver: ResizeObserver | null = null;

function getSharedSizeObserver() {
  if (typeof ResizeObserver === "undefined") return null;
  sharedSizeObserver ??= new ResizeObserver((entries) => {
    for (const entry of entries) {
      const listener = sizeListeners.get(entry.target);
      if (!listener) continue;
      const inlineSize =
        entry.contentBoxSize?.[0]?.inlineSize ?? entry.contentRect.width;
      listener(inlineSize);
    }
  });
  return sharedSizeObserver;
}

function observeSize(element: Element, listener: SizeListener) {
  const observer = getSharedSizeObserver();
  if (!observer) return () => undefined;
  sizeListeners.set(element, listener);
  observer.observe(element);
  return () => {
    observer.unobserve(element);
    sizeListeners.delete(element);
  };
}

export function CanvasStrip({
  className,
  height,
  ariaHidden = false,
  redrawKey,
  draw,
  getHoverIndex,
  onHoverIndex,
}: CanvasStripProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const applyWidth = (next: number) => {
      const rounded = Math.round(next);
      setWidth((previous) => (previous === rounded ? previous : rounded));
    };

    applyWidth(canvas.clientWidth);
    return observeSize(canvas, applyWidth);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;

    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.round(width * dpr));
    const pixelHeight = Math.max(1, Math.round(height * dpr));
    // 重设 canvas.width/height 会清空画布，尺寸没变时只需手动清一次。
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    draw(ctx, width, height);
  }, [draw, height, redrawKey, width]);

  const handlePointerMove = useCallback(
    (event: PointerEvent<HTMLCanvasElement>) => {
      if (!getHoverIndex || !onHoverIndex || width <= 0) return;
      onHoverIndex(getHoverIndex(event.nativeEvent.offsetX, width));
    },
    [getHoverIndex, onHoverIndex, width],
  );

  const handlePointerLeave = useCallback(() => {
    onHoverIndex?.(null);
  }, [onHoverIndex]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ width: "100%", height }}
      aria-hidden={ariaHidden}
      onPointerMove={handlePointerMove}
      onPointerLeave={handlePointerLeave}
    />
  );
}
