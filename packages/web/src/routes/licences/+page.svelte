<script lang="ts">
  /*
   * The licences screen: each third-party work the app ships, linked to its
   * licence text in static/licenses/. Plain links to plain files: a full page
   * load (data-sveltekit-reload), never a client route.
   */
  import { copy } from "$lib/copy/language.svelte";
  import { asset, resolve } from "$app/paths";
  import { LICENCES } from "$lib/licences";

  const t = $derived(copy());
</script>

<svelte:head>
  <title>{t["licences.title"]} · Vitrina</title>
</svelte:head>

<main class="screen licences">
  <h1>{t["licences.title"]}</h1>
  <p>{t["licences.intro"]}</p>
  <ul>
    {#each LICENCES as l (l.file)}
      <li><a href={asset(`/licenses/${l.file}`)} data-sveltekit-reload data-licence={l.file}>{t[l.covers] as string}</a></li>
    {/each}
  </ul>
  <div class="bottom">
    <a class="btn ghost" href={resolve("/")}>{t["licences.back"]}</a>
  </div>
</main>

<style>
  ul {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  a {
    color: var(--accent);
  }
  .btn.ghost {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
  }
</style>
