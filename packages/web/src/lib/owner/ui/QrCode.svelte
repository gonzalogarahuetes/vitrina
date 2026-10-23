<script lang="ts">
  /*
   * The invite QR as inline SVG (invite spec §3): one path, presentation
   * attributes only (no style attribute, which CSP refuses), and never a
   * data: image. The quiet zone is inside the grid, drawn white, so a dark
   * page around it cannot eat into it. Sized to the column, up to 360 px:
   * large enough to photograph off a screen.
   */
  import { qrModules, qrPath } from "$lib/owner/qr";

  let { text, label }: { text: string; label: string } = $props();

  const modules = $derived(qrModules(text));
  const d = $derived(qrPath(modules));
</script>

<svg class="qr" viewBox="0 0 {modules.size} {modules.size}" role="img" aria-label={label} shape-rendering="crispEdges" xmlns="http://www.w3.org/2000/svg">
  <rect width={modules.size} height={modules.size} fill="#ffffff"></rect>
  <path {d} fill="#000000"></path>
</svg>

<style>
  .qr {
    display: block;
    width: 100%;
    max-width: 360px;
    height: auto;
    aspect-ratio: 1;
    align-self: center;
    border: 1px solid var(--disabled-line);
  }
</style>
