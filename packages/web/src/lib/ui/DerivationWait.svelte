<script lang="ts">
  /*
   * The derivation wait (flows §2): one screen state, used by passphrase entry
   * (§4.2), unlock (§3.1), signup (§3.2) and sign-in (§3.3). No progress
   * figure: Argon2id reports none. The hosting form disables its input while
   * this shows, so nothing can be edited or submitted again.
   */
  import { en } from "$lib/copy/en";

  let { layout = "inline" }: { layout?: "inline" | "stacked" } = $props();
</script>

<div class="wait {layout}" role="status">
  <div class="rings" aria-hidden="true"><div class="ring"></div><div class="ring two"></div><div class="dot"></div></div>
  <span>{en["derive.wait"]}</span>
</div>

<style>
  .wait {
    display: flex;
    align-items: center;
    gap: 18px;
  }
  .wait.stacked {
    flex-direction: column;
    gap: 24px;
    text-align: center;
  }
  .rings {
    width: 84px;
    height: 84px;
    flex: none;
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .stacked .rings {
    width: 120px;
    height: 120px;
  }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    border: 3px solid var(--accent);
    animation: breathe 2.6s ease-in-out infinite;
  }
  .ring.two {
    inset: 18px;
    animation-delay: -1.3s;
  }
  .stacked .ring.two {
    inset: 24px;
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent);
  }
  .stacked .dot {
    width: 18px;
    height: 18px;
  }
  @keyframes breathe {
    0%,
    100% {
      transform: scale(0.62);
      opacity: 0.3;
    }
    50% {
      transform: scale(1);
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ring {
      opacity: 0.6;
    }
  }
</style>
