import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/ui/Logo";

export function AppHeader({
  subtitle,
  right,
}: {
  subtitle?: string;
  right?: ReactNode;
}) {
  return (
    <header className="flex items-center justify-between px-5 py-4 lg:px-7">
      <div className="flex items-center gap-4">
        <Link href="/">
          <Logo />
        </Link>
        {subtitle ? <p className="hidden text-sm text-[var(--studio-muted)] sm:block">{subtitle}</p> : null}
      </div>
      {right}
    </header>
  );
}
