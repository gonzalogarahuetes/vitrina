<script lang="ts">
  /*
   * The licences screen: each third-party work the app ships, linked to its
   * licence text in static/licenses/. Plain links to plain files: a full page
   * load (data-sveltekit-reload), never a client route.
   */
  import { en } from "$lib/copy/en";
  import { asset, resolve } from "$app/paths";
  import { LICENCES } from "$lib/licences";
</script>

<svelte:head>
  <title>{en["licences.title"]} · Vitrina</title>
</svelte:head>

<main class="screen licences">
  <h1>{en["licences.title"]}</h1>
  <p>{en["licences.intro"]}</p>
  <ul>
    {#each LICENCES as l (l.file)}
      <li><a href={asset(`/licenses/${l.file}`)} data-sveltekit-reload data-licence={l.file}>{en[l.covers] as string}</a></li>
    {/each}
  </ul>
  <div class="bottom">
    <a class="btn ghost" href={resolve("/")}>{en["licences.back"]}</a>
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
