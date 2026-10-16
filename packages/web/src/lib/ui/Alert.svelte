<script lang="ts">
  /* One sentence that something needs attention, with the boards' warning icon. */
  let { text, id = undefined }: { text: string; id?: string | undefined } = $props();
</script>

<div class="alert" role="alert" {id}>
  <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"
    ><circle cx="12" cy="12" r="10"></circle><path d="M12 7v6"></path><path d="M12 17h.01"></path></svg
  >
  <span>{text}</span>
</div>

<style>
  svg {
    flex: none;
    margin-top: 3px;
  }
</style>
