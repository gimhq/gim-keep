import type { NavItem } from "@/shared/components/sidebar/types";
import { Database } from "lucide-react";

export const storageNav: NavItem = {
  area: "admin",
  key: "storage",
  path: "/admin/storage",
  icon: Database,
  order: 6,
};
