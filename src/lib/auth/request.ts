import "server-only";
import { headers } from "next/headers";
import type { AuthEventDetail } from "@/modules/tenant/commands";
import { clientAddressOf, deviceOf } from "./rules";

/**
 * The device and address a sign-in history row records. Vercel puts the visitor's address first
 * in X-Forwarded-For; locally there is none. Both are only what the browser and the network say,
 * shown to the company's owner to spot a sign-in that was not theirs.
 */
export async function requestDetail(): Promise<Pick<AuthEventDetail, "device" | "address">> {
  const list = await headers();
  return { device: deviceOf(list.get("user-agent")), address: clientAddressOf(list.get("x-forwarded-for")) };
}
