/*
 * The only file permitted to name a concrete adapter (vitrina-server-architecture.md §5).
 *
 * It constructs the driven adapters, injects them into the use-case factories,
 * and returns the finished use cases. `buildServer` receives those use cases and
 * never a repository — which is what keeps the web app one caller of the API
 * rather than its owner (non-negotiable #5).
 *
 * Phase 0 builds nothing, because `health` needs nothing. The file exists so the
 * path exists: when the first repository arrives it has one obvious home, and
 * the wiring does not have to be invented under time pressure.
 */

import type { UseCases } from "./application/use-cases/index.js";

export function buildUseCases(): UseCases {
  /*
   * When this grows: construct the Postgres pool and the object-store client
   * here, wrap them in the adapters under adapters/driven/, and pass those to
   * the use-case factories. Nothing above this line may name a vendor.
   */
  return {};
}
