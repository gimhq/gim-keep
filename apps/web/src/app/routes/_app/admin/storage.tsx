import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/_app/admin/storage")({
  staticData: { titleKey: "gim:storage.title" },
});
