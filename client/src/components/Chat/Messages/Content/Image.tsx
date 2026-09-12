import React, { useState, useRef, useMemo, useEffect } from 'react';
import { Skeleton } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import { useContentRowPortalPin } from '~/components/Chat/Messages/Windowing/useContentRowPortalPin';
import { useContentRowReadiness } from '~/components/Chat/Messages/Windowing/contentRowInteraction';
import DialogImage from './DialogImage';
import { cn } from '~/utils';

/** Max display height for chat images (Tailwind JIT class) */
export const IMAGE_MAX_H = 'max-h-[45vh]' as const;
/** Matches the `max-w-lg` Tailwind class on the wrapper button (32rem = 512px at 16px base) */
const IMAGE_MAX_W_PX = 512;

/** Caches image dimensions by src so remounts can reserve space */
const dimensionCache = new Map<string, { width: number; height: number }>();
/** Tracks URLs that have been fully painted — skip skeleton on remount */
const paintedUrls = new Set<string>();

/** Test-only: resets module-level caches */
export function _resetImageCaches(): void {
  dimensionCache.clear();
  paintedUrls.clear();
}

function computeHeightStyle(w: number, h: number): React.CSSProperties {
  return { height: `min(45vh, ${(h / w) * 100}vw, ${(h / w) * IMAGE_MAX_W_PX}px)` };
}

const Image = ({
  imagePath,
  altText,
  className,
  args,
  width,
  height,
}: {
  imagePath: string;
  altText: string;
  className?: string;
  args?: {
    prompt?: string;
    quality?: 'low' | 'medium' | 'high';
    size?: string;
    style?: string;
    [key: string]: unknown;
  };
  width?: number;
  height?: number;
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const paintFrame = useRef<number | null>(null);
  /**
   * Image readiness for content-row windowing (§8.2, §6 Q3). A known-size image row starts
   * `unstable-until-settled`, so reporting the load is what makes it windowable; a failure keeps
   * it mounted. Null whenever no row owns this image, which is every case outside windowing.
   */
  const rowReadiness = useContentRowReadiness();

  useEffect(
    () => () => {
      if (paintFrame.current != null) {
        cancelAnimationFrame(paintFrame.current);
      }
    },
    [],
  );

  /**
   * The image dialog is portaled outside the row subtree, so the row that owns this part would
   * otherwise be free to unmount and take the open dialog down with it. It is the first call site
   * of the §15.2 portal pin; see `useContentRowPortalPin`.
   */
  const portalPin = useContentRowPortalPin();
  const [portalElement, setPortalElement] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    // Held for as long as the dialog is open. `portalElement` arrives one commit later for the
    // first open, which is why `acquire` is idempotent.
    portalPin.acquire(portalElement);
    return () => portalPin.release();
  }, [isOpen, portalElement, portalPin]);

  const absoluteImageUrl = useMemo(() => {
    if (!imagePath) return imagePath;

    if (imagePath.startsWith('http') || imagePath.startsWith('data:')) {
      return imagePath;
    }

    // Root-relative server paths (`/images/...` static, `/api/share/...` share
    // routes) are resolved against the API base so they load under a subpath.
    if (imagePath.startsWith('/images/') || imagePath.startsWith('/api/')) {
      return `${apiBaseUrl()}${imagePath}`;
    }

    return imagePath;
  }, [imagePath]);

  const downloadImage = async () => {
    try {
      const response = await fetch(absoluteImageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch image: ${response.status}`);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);

      const link = document.createElement('a');
      link.href = url;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);

      window.URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Download failed:', error);
      const link = document.createElement('a');
      link.href = absoluteImageUrl;
      link.download = altText || 'image.png';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }
  };

  useEffect(() => {
    if (width && height && absoluteImageUrl) {
      dimensionCache.set(absoluteImageUrl, { width, height });
    }
  }, [absoluteImageUrl, width, height]);

  const dims = width && height ? { width, height } : dimensionCache.get(absoluteImageUrl);
  const hasDimensions = !!(dims?.width && dims?.height);
  const heightStyle = hasDimensions ? computeHeightStyle(dims.width, dims.height) : undefined;
  const showSkeleton = hasDimensions && !paintedUrls.has(absoluteImageUrl);

  /**
   * Report the load once the image has been painted. A URL already painted in this session is
   * reported immediately: the row still has to settle in its current generation, but it does not
   * need a second paint to know the image is there.
   */
  const handleImageLoad = () => {
    if (rowReadiness == null) {
      paintedUrls.add(absoluteImageUrl);
      return;
    }
    const alreadyPainted = paintedUrls.has(absoluteImageUrl);
    paintedUrls.add(absoluteImageUrl);
    if (alreadyPainted) {
      rowReadiness.reportReady();
      return;
    }
    paintFrame.current = requestAnimationFrame(() => {
      paintFrame.current = null;
      rowReadiness.reportReady();
    });
  };

  return (
    <div>
      <button
        ref={triggerRef}
        type="button"
        aria-label={`View ${altText} in dialog`}
        aria-haspopup="dialog"
        onClick={() => setIsOpen(true)}
        className={cn(
          'relative mt-1 w-full max-w-lg cursor-pointer overflow-hidden rounded-lg border border-border-light text-text-secondary-alt shadow-md transition-shadow',
          'focus:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-surface-primary',
          className,
        )}
        style={heightStyle}
      >
        {showSkeleton && <Skeleton className="absolute inset-0" aria-hidden="true" />}
        <img
          alt={altText}
          src={absoluteImageUrl}
          onLoad={handleImageLoad}
          onError={() => rowReadiness?.reportFailed()}
          className={cn(
            'relative block text-transparent',
            hasDimensions
              ? 'size-full object-contain'
              : cn('h-auto w-auto max-w-full', IMAGE_MAX_H),
          )}
        />
      </button>
      <DialogImage
        isOpen={isOpen}
        onOpenChange={setIsOpen}
        src={absoluteImageUrl}
        downloadImage={downloadImage}
        args={args}
        triggerRef={triggerRef}
        onPortalElement={setPortalElement}
      />
    </div>
  );
};

export default Image;
