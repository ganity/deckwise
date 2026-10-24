import type { PPTImageElement } from "../../../../../lib/types/slides";
import { useElementShadow } from "../hooks/useElementShadow";
import { useElementFlip } from "../hooks/useElementFlip";
import { ImageOutline } from "./ImageOutline/index";
import { useClipImage } from "./useClipImage";
import { useFilter } from "./useFilter";

interface ImageElementVisualProps {
  readonly elementInfo: PPTImageElement;
  readonly src?: string;
  readonly children?: React.ReactNode;
  readonly className?: string;
  readonly onMouseDown?: React.MouseEventHandler<HTMLDivElement>;
  readonly onTouchStart?: React.TouchEventHandler<HTMLDivElement>;
}

export function ImageElementVisual({
  elementInfo,
  src,
  children,
  className,
  onMouseDown,
  onTouchStart,
}: ImageElementVisualProps) {
  const { shadowStyle } = useElementShadow(elementInfo.shadow);
  const { flipStyle } = useElementFlip(elementInfo.flipH, elementInfo.flipV);
  const { clipShape, imgPosition } = useClipImage(elementInfo);
  const { filter } = useFilter(elementInfo.filters);

  return (
    <div
      className={`w-full h-full relative ${className ?? ""}`}
      style={{
        filter: shadowStyle ? `drop-shadow(${shadowStyle})` : "",
        transform: flipStyle,
      }}
      onMouseDown={onMouseDown}
      onTouchStart={onTouchStart}
    >
      <ImageOutline elementInfo={elementInfo} />
      <div
        className="image-content w-full h-full overflow-hidden relative"
        style={{ clipPath: clipShape.style }}
      >
        {children ?? (
          <>
            {src ? (
              <img
                data-spotlight-target="image-visible-area"
                src={src}
                draggable={false}
                style={{
                  position: "absolute",
                  top: imgPosition.top,
                  left: imgPosition.left,
                  width: imgPosition.width,
                  height: imgPosition.height,
                  maxWidth: "none",
                  maxHeight: "none",
                  filter,
                }}
                alt=""
                onDragStart={(event) => event.preventDefault()}
              />
            ) : null}
            {elementInfo.colorMask ? (
              <div
                className="color-mask absolute inset-0"
                style={{ backgroundColor: elementInfo.colorMask }}
              />
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
