import type { HTMLAttributes, SVGProps } from "react";

/**
 * The single CostKey identity mark used throughout the console.
 *
 * Geometry is the observatory signature from the CostKey design language
 * (48 px grid): dome, telescope, base and one warm arched window. The body
 * uses currentColor so the mark stays legible on paper and on the dark
 * authentication surface; the window is always Lamplight.
 */
export function BrandMark({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      className={className}
      viewBox="0 0 48 48"
      aria-hidden={props["aria-label"] ? undefined : true}
      focusable="false"
      {...props}
    >
      <path fill="currentColor" d="M7 24C7 14 14 8 23 8c9 0 16 7 16 16H7Z" />
      <path fill="currentColor" d="m26 11 12-8 4 6-12 8-4-6Z" />
      <path fill="currentColor" d="M5 25h36v4H5zm5 6h26v12H10Z" />
      <path fill="#f5cc68" d="M20 43v-8a3 3 0 0 1 6 0v8Z" />
    </svg>
  );
}

export function BrandLockup({ className, markClassName, ...props }: HTMLAttributes<HTMLSpanElement> & { markClassName?: string }) {
  return (
    <span className={className} {...props}>
      <BrandMark className={markClassName} />
      <span>CostKey</span>
    </span>
  );
}
