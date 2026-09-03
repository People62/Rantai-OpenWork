import { resolveExtensionIconSrc } from "./extension-icon-src";

const LIGHT_MARK = "/openwork-mark.svg";
const DARK_MARK = "/openwork-mark-dark.svg";

type BrandMarkProps = {
  /** Organization logo from desktop policy. Rendered as-is when present. */
  logoUrl?: string | null;
  className?: string;
  size?: number;
};

/**
 * The app mark, drawn in the colour that belongs to the active theme.
 *
 * Two files rather than one file plus `dark:invert`: inverting is only safe
 * for an achromatic mark. Any brand colour comes back as its complement —
 * navy would return as tan, sky as rust — so each theme gets its own drawing.
 * The swap is CSS, not state, which keeps the right mark on the first paint.
 */
export function BrandMark({ logoUrl, className = "", size = 26 }: BrandMarkProps) {
  const shared = `shrink-0 object-contain object-left ${className}`.trim();

  if (logoUrl) {
    return (
      <img src={logoUrl} alt="" width={size} height={size} className={shared} aria-hidden="true" />
    );
  }

  return (
    <>
      <img
        src={resolveExtensionIconSrc(LIGHT_MARK)}
        alt=""
        width={size}
        height={size}
        className={`${shared} dark:hidden`}
        aria-hidden="true"
      />
      <img
        src={resolveExtensionIconSrc(DARK_MARK)}
        alt=""
        width={size}
        height={size}
        className={`${shared} hidden dark:block`}
        aria-hidden="true"
      />
    </>
  );
}
