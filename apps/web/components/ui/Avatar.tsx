export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return `${parts[0][0]}${parts[parts.length - 1][0]}`.toUpperCase();
}

export function Avatar({
  name,
  size = "md",
  accent = false,
  speaking = false,
}: {
  name: string;
  size?: "sm" | "md" | "lg" | "xl";
  accent?: boolean;
  speaking?: boolean;
}) {
  const px = size === "sm" ? 32 : size === "md" ? 40 : size === "lg" ? 64 : 112;
  const type = size === "sm" ? "text-[11px]" : size === "md" ? "text-sm" : size === "lg" ? "text-xl" : "text-4xl";
  return (
    <span
      style={{ width: px, height: px, minWidth: px, minHeight: px }}
      className={`relative inline-flex aspect-square shrink-0 items-center justify-center overflow-hidden rounded-full leading-none font-semibold tracking-tight text-white whitespace-nowrap ${type} ${
        accent ? "bg-[var(--accent)]" : "bg-[#3c4454]"
      } ${speaking ? "ring-4 ring-[var(--accent)] ring-offset-2 ring-offset-[var(--studio-panel)]" : ""}`}
    >
      {initials(name)}
    </span>
  );
}
