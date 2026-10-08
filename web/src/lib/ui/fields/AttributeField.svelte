<script lang="ts">
  import type { AttributeDto } from '$shared';

  /**
   * One editor for every attribute type a board can declare.
   *
   * Boards define their own attributes, so the UI cannot ship a form per type —
   * it has to render whatever the config says. Keeping all eight branches in one
   * small component means adding a type to the engine means adding a branch
   * here, and nothing else changes.
   */
  interface Props {
    attribute: AttributeDto;
    value: unknown;
    compact?: boolean;
    onchange: (value: unknown) => void;
  }

  let { attribute, value, compact = false, onchange }: Props = $props();

  const text = $derived(typeof value === 'string' ? value : (value ?? '') === '' ? '' : String(value));
  const list = $derived(Array.isArray(value) ? value.map(String) : []);

  function number(raw: string): void {
    if (raw.trim() === '') return onchange(null);
    const parsed = attribute.type === 'int' ? Number.parseInt(raw, 10) : Number(raw);
    if (Number.isFinite(parsed)) onchange(parsed);
  }
</script>

{#if attribute.type === 'bool'}
  <input
    type="checkbox"
    checked={value === true}
    onchange={(event) => onchange(event.currentTarget.checked)}
  />
{:else if attribute.type === 'enum'}
  <select class="control" value={text} onchange={(event) => onchange(event.currentTarget.value || null)}>
    <option value="">—</option>
    {#each attribute.values ?? [] as option (option)}
      <option value={option}>{option}</option>
    {/each}
  </select>
{:else if attribute.type === 'int' || attribute.type === 'float'}
  <input
    class="control number"
    type="number"
    step={attribute.type === 'int' ? 1 : 'any'}
    value={text}
    onchange={(event) => number(event.currentTarget.value)}
  />
{:else if attribute.type === 'date'}
  <input
    class="control"
    type="date"
    value={text}
    onchange={(event) => onchange(event.currentTarget.value || null)}
  />
{:else if attribute.type === 'array'}
  <input
    class="control"
    value={list.join(', ')}
    placeholder="comma, separated"
    onchange={(event) =>
      onchange(
        event.currentTarget.value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
      )}
  />
{:else if attribute.type === 'text' && !compact}
  <textarea class="control" rows="4" value={text} onchange={(event) => onchange(event.currentTarget.value)}
  ></textarea>
{:else}
  <input class="control" value={text} onchange={(event) => onchange(event.currentTarget.value)} />
{/if}

<style>
  .control {
    width: 100%;
    padding: 0.25rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-0);
    font-size: var(--text-sm);
  }

  .control:focus {
    background: var(--surface-1);
  }

  .number {
    max-width: 6rem;
  }

  textarea.control {
    resize: vertical;
    font-family: inherit;
    line-height: 1.5;
  }
</style>
