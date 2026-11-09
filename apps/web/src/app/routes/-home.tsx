import { Flag, LockKeyhole, ToggleRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Logo } from "@/shared/components/logo";
import { ModeToggle } from "@/shared/components/mode-toggle";
import { BASE_PATH } from "@/shared/lib/http";

const FEATURES = [
  ["backup", LockKeyhole],
  ["reports", Flag],
  ["choice", ToggleRight],
] as const;

/**
 * The home page, shown at `/` when `HOME_PAGE` is `base` or `root` (see
 * `.env.example`): what the keep server is, for gim users who open its
 * address. It is public and makes no authenticated call; the console
 * behind the sign-in link is for the team.
 */
export function HomePage() {
  const { t } = useTranslation("home");
  return (
    <div className="flex min-h-svh flex-col bg-background">
      <header className="mx-auto flex w-full max-w-3xl items-center justify-between p-4">
        <div className="flex items-center gap-2 font-semibold">
          <Logo className="size-7" />
          {t("brand")}
        </div>
        <ModeToggle />
      </header>
      <main className="mx-auto w-full max-w-3xl flex-1 space-y-10 px-4 py-12">
        <div className="space-y-3">
          <h1 className="text-3xl font-bold tracking-tight">{t("title")}</h1>
          <p className="text-lg text-muted-foreground">{t("lead")}</p>
        </div>
        <div className="grid gap-6 sm:grid-cols-3">
          {FEATURES.map(([key, Icon]) => (
            <div key={key} className="space-y-2">
              <Icon className="size-5 text-primary" />
              <h2 className="font-semibold">{t(`features.${key}.title`)}</h2>
              <p className="text-sm text-muted-foreground">{t(`features.${key}.body`)}</p>
            </div>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">{t("noAction")}</p>
      </main>
      <footer className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-2 border-t p-4 text-xs text-muted-foreground">
        <span>{t("teamOnly")}</span>
        {/* A plain link: at the origin root the router has no base prefix,
            so a router link would not reach the app under BASE_PATH. */}
        <a href={`${BASE_PATH}/overview`} className="underline-offset-4 hover:underline">
          {t("enter")}
        </a>
      </footer>
    </div>
  );
}
