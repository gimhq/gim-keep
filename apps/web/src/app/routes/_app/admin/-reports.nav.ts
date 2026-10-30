import type { NavItem } from "@/shared/components/sidebar/types";
import { Flag } from "lucide-react";

export const reportsNav: NavItem = {
  area: "admin",
  key: "reports",
  path: "/admin/reports",
  icon: Flag,
  order: 5,
};
