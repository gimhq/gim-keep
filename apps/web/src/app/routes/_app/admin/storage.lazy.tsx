/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import { Eye, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/shared/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/shared/components/ui/card";
import { ConfirmDeleteDialog } from "@/shared/components/ui/confirm-delete-dialog";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import { Input } from "@/shared/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { useDebounce } from "@/shared/hooks/use-debounce";
import { formatDateTime } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";

export const Route = createLazyFileRoute("/_app/admin/storage")({
  component: StoragePage,
});

interface StorageUser {
  readonly userId: string;
  readonly slots: number;
  readonly bytes: number;
  readonly lastUpdatedAt: string;
}

interface StorageResponse {
  readonly data: StorageUser[];
  readonly meta: {
    readonly total: number;
    readonly page: number;
    readonly limit: number;
    readonly totals: { readonly users: number; readonly slots: number; readonly bytes: number };
  };
}

interface SlotInfo {
  readonly name: string;
  readonly version: number;
  readonly bytes: number;
  readonly updatedAt: string;
}

const LIMIT = 50;

function formatBytes(bytes: number): string {
  if (bytes < 1024)
    return `${bytes} B`;
  if (bytes < 1024 * 1024)
    return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

function StoragePage() {
  const { t } = useTranslation("gim");
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [viewing, setViewing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const q = useDebounce(search.trim(), 300);

  const query = useQuery({
    queryKey: ["gim-storage", q, page],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(LIMIT),
      });
      if (q)
        params.set("q", q);
      return http<StorageResponse>(`/gim/storage?${params.toString()}`);
    },
  });

  const slots = useQuery({
    queryKey: ["gim-storage-user", viewing],
    queryFn: () => http<{ data: SlotInfo[] }>(`/gim/storage/${encodeURIComponent(viewing!)}`),
    enabled: viewing !== null,
  });

  const remove = useMutation({
    mutationFn: (userId: string) => http(`/gim/storage/${encodeURIComponent(userId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["gim-storage"],
      });
      setDeleting(null);
    },
  });

  const users = query.data?.data ?? [];
  const totals = query.data?.meta.totals;
  const totalPages = Math.ceil((query.data?.meta.total ?? 0) / LIMIT);
  const error = query.error ?? remove.error;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("storage.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("storage.description")}</p>
      </div>

      <ErrorBanner message={error instanceof Error
        ? error.message
        : null}
      />

      <div className="grid gap-4 sm:grid-cols-3">
        {([
          ["users", totals?.users],
          ["slots", totals?.slots],
          [
            "bytes",
            totals === undefined
              ? undefined
              : formatBytes(totals.bytes),
          ],
        ] as const).map(([key, value]) => (
          <Card key={key}>
            <CardHeader><CardTitle className="text-sm font-medium text-muted-foreground">{t(`storage.totals.${key}`)}</CardTitle></CardHeader>
            <CardContent className="text-2xl font-semibold">{value ?? "–"}</CardContent>
          </Card>
        ))}
      </div>

      <Input
        placeholder={t("storage.search")}
        value={search}
        onChange={(e) => {
          setSearch(e.target.value);
          setPage(1);
        }}
        className="max-w-sm"
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("storage.col.user")}</TableHead>
              <TableHead>{t("storage.col.slots")}</TableHead>
              <TableHead>{t("storage.col.size")}</TableHead>
              <TableHead>{t("storage.col.updated")}</TableHead>
              <TableHead>{t("storage.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading
              ? (
                  <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">{t("common.loading")}</TableCell></TableRow>
                )
              : users.length === 0
                ? (
                    <TableRow><TableCell colSpan={5} className="h-24 text-center text-muted-foreground">{t("storage.empty")}</TableCell></TableRow>
                  )
                : users.map(user => (
                    <TableRow key={user.userId}>
                      <TableCell className="break-all font-mono text-xs">{user.userId}</TableCell>
                      <TableCell>{user.slots}</TableCell>
                      <TableCell>{formatBytes(user.bytes)}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(user.lastUpdatedAt)}</TableCell>
                      <TableCell className="flex gap-1">
                        <Button variant="ghost" size="icon-sm" aria-label={t("storage.view")} onClick={() => setViewing(user.userId)}>
                          <Eye className="size-4" />
                        </Button>
                        <Button variant="ghost" size="icon-sm" aria-label={t("storage.delete")} onClick={() => setDeleting(user.userId)}>
                          <Trash2 className="size-4 text-destructive" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-end gap-2">
          <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>{t("common.prev")}</Button>
          <span className="px-2 text-sm">{`${page} / ${totalPages}`}</span>
          <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage(p => p + 1)}>{t("common.next")}</Button>
        </div>
      )}

      <p className="text-xs text-muted-foreground">{t("storage.sealedNote")}</p>

      <Dialog
        open={viewing !== null}
        onOpenChange={(open) => {
          if (!open)
            setViewing(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("storage.slotsTitle")}</DialogTitle>
          </DialogHeader>
          <p className="break-all font-mono text-xs text-muted-foreground">{viewing}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("storage.col.slot")}</TableHead>
                <TableHead>{t("storage.col.version")}</TableHead>
                <TableHead>{t("storage.col.size")}</TableHead>
                <TableHead>{t("storage.col.updated")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(slots.data?.data ?? []).map(slot => (
                <TableRow key={slot.name}>
                  <TableCell className="font-mono text-xs">{slot.name}</TableCell>
                  <TableCell>{slot.version}</TableCell>
                  <TableCell>{formatBytes(slot.bytes)}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{formatDateTime(slot.updatedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.close")}</Button>} />
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDeleteDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open)
            setDeleting(null);
        }}
        title={t("storage.deleteTitle")}
        description={t("storage.deleteDescription", { userId: deleting ?? "" })}
        pending={remove.isPending}
        onConfirm={() => {
          if (deleting)
            remove.mutate(deleting);
        }}
      />
    </div>
  );
}
