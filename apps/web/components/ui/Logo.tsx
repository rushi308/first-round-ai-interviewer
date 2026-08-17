import { APP_NAME } from "@/lib/brand";

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2.5">
      <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-[var(--accent)] text-[11px] font-bold tracking-tight text-white">
        FR
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-white">{APP_NAME}</span>
    </span>
  );
}
