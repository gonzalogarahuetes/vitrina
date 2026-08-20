/*
 * The set of use cases the composition root builds and the HTTP adapter calls.
 *
 * Empty in Phase 0 — `health` needs none. vitrina-server-architecture.md §5 still threads it
 * through the composition root deliberately: "It is deliberately over-built for
 * one route: the shape is the point, not the current contents."
 *
 * vitrina-server-architecture.md §4 decision 4 fixes the shape each entry takes:
 * `(deps) => (input) => Promise<result>`.
 */
export type UseCases = {
  // B.6's routes populate this.
};
