import { hasE2EEnv, removeE2EData } from "./support/admin";

export default async function globalTeardown() {
  if (hasE2EEnv()) await removeE2EData();
}
