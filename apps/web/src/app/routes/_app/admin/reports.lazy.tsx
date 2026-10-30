/* eslint-disable react-refresh/only-export-components */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createLazyFileRoute } from "@tanstack/react-router";
import { Eye } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/shared/components/ui/badge";
import { Button } from "@/shared/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/shared/components/ui/dialog";
import { ErrorBanner } from "@/shared/components/ui/error-banner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/shared/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/shared/components/ui/tabs";
import { formatDateTime } from "@/shared/lib/format";
import { http } from "@/shared/lib/http";

export const Route = createLazyFileRoute("/_app/admin/reports")({
  component: ReportsPage,
});

const STATUSES = ["open", "resolved", "dismissed"] as const;
type ReportStatus = typeof STATUSES[number];

interface ReportedMessage {
  readonly messageId: string;
  readonly senderUserId: string;
  readonly sentAtMs: number;
  readonly text: string;
}

interface Report {
  readonly id: string;
  readonly reporterId: string;
  readonly reportedUserId: string;
  readonly reason: string;
  readonly note: string | null;
  readonly messages: ReportedMessage[];
  readonly status: ReportStatus;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
  readonly resolvedBy: string | null;
}

function shortId(id: string): string {
  return id.length > 16
    ? `${id.slice(0, 10)}…${id.slice(-4)}`
    : id;
}

function ReportsPage() {
  const { t } = useTranslation("gim");
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<ReportStatus>("open");
  const [selected, setSelected] = useState<Report | null>(null);

  const query = useQuery({
    queryKey: ["gim-reports", status],
    queryFn: () => http<{ data: Report[] }>(`/gim/reports?status=${status}&limit=200`),
  });

  const update = useMutation({
    mutationFn: (input: { id: string; status: ReportStatus }) => http(`/gim/reports/${input.id}`, {
      method: "PATCH",
      body: JSON.stringify({ status: input.status }),
    }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["gim-reports"],
      });
      setSelected(null);
    },
  });

  const reports = query.data?.data ?? [];
  const error = query.error ?? update.error;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t("reports.title")}</h1>
        <p className="mt-1 text-muted-foreground">{t("reports.description")}</p>
      </div>

      <ErrorBanner message={error instanceof Error
        ? error.message
        : null}
      />

      <Tabs
        value={status}
        onValueChange={(v) => {
          if (STATUSES.includes(v as ReportStatus))
            setStatus(v as ReportStatus);
        }}
      >
        <TabsList>
          {STATUSES.map(s => (
            <TabsTrigger key={s} value={s}>{t(`reports.status.${s}`)}</TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("reports.col.time")}</TableHead>
              <TableHead>{t("reports.col.reason")}</TableHead>
              <TableHead>{t("reports.col.reported")}</TableHead>
              <TableHead>{t("reports.col.reporter")}</TableHead>
              <TableHead>{t("reports.col.messages")}</TableHead>
              <TableHead>{t("reports.col.actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {query.isLoading
              ? (
                  <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{t("common.loading")}</TableCell></TableRow>
                )
              : reports.length === 0
                ? (
                    <TableRow><TableCell colSpan={6} className="h-24 text-center text-muted-foreground">{t("reports.empty")}</TableCell></TableRow>
                  )
                : reports.map(report => (
                    <TableRow key={report.id}>
                      <TableCell className="text-xs text-muted-foreground">{formatDateTime(report.createdAt)}</TableCell>
                      <TableCell><Badge variant="outline">{t(`reports.reason.${report.reason}`, { defaultValue: report.reason })}</Badge></TableCell>
                      <TableCell className="font-mono text-xs" title={report.reportedUserId}>{shortId(report.reportedUserId)}</TableCell>
                      <TableCell className="font-mono text-xs" title={report.reporterId}>{shortId(report.reporterId)}</TableCell>
                      <TableCell>{report.messages.length}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="icon-sm" aria-label={t("reports.view")} onClick={() => setSelected(report)}>
                          <Eye className="size-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open)
            setSelected(null);
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("reports.detailTitle")}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-[140px_1fr] gap-2">
                <span className="text-muted-foreground">{t("reports.col.reason")}</span>
                <span>{t(`reports.reason.${selected.reason}`, { defaultValue: selected.reason })}</span>
                <span className="text-muted-foreground">{t("reports.col.reported")}</span>
                <span className="break-all font-mono text-xs">{selected.reportedUserId}</span>
                <span className="text-muted-foreground">{t("reports.col.reporter")}</span>
                <span className="break-all font-mono text-xs">{selected.reporterId}</span>
                <span className="text-muted-foreground">{t("reports.col.time")}</span>
                <span>{formatDateTime(selected.createdAt)}</span>
                {selected.resolvedAt && (
                  <>
                    <span className="text-muted-foreground">{t("reports.closedAt")}</span>
                    <span>{formatDateTime(selected.resolvedAt)}</span>
                  </>
                )}
                {selected.note && (
                  <>
                    <span className="text-muted-foreground">{t("reports.note")}</span>
                    <span className="whitespace-pre-wrap">{selected.note}</span>
                  </>
                )}
              </div>
              <div>
                <p className="mb-2 font-medium">{t("reports.messagesTitle", { count: selected.messages.length })}</p>
                {selected.messages.length === 0
                  ? <p className="text-muted-foreground">{t("reports.noMessages")}</p>
                  : (
                      <ul className="max-h-72 space-y-2 overflow-auto">
                        {selected.messages.map(m => (
                          <li key={m.messageId} className="rounded-md bg-muted p-2">
                            <div className="mb-1 flex justify-between gap-2 text-xs text-muted-foreground">
                              <span className="font-mono" title={m.senderUserId}>{shortId(m.senderUserId)}</span>
                              <span>{formatDateTime(m.sentAtMs)}</span>
                            </div>
                            <p className="whitespace-pre-wrap break-words">{m.text}</p>
                          </li>
                        ))}
                      </ul>
                    )}
              </div>
            </div>
          )}
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline">{t("common.close")}</Button>} />
            {selected && selected.status === "open"
              ? (
                  <>
                    <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: selected.id, status: "dismissed" })}>
                      {t("reports.dismiss")}
                    </Button>
                    <Button disabled={update.isPending} onClick={() => update.mutate({ id: selected.id, status: "resolved" })}>
                      {t("reports.resolve")}
                    </Button>
                  </>
                )
              : selected && (
                <Button variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: selected.id, status: "open" })}>
                  {t("reports.reopen")}
                </Button>
              )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
