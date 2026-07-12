/**
 * Shared Streamdown wrapper for chat content (agent_message + reasoning).
 *
 * `linkSafety.enabled: false` is load-bearing: Streamdown's default link
 * renderer wraps each link in a "link safety" confirmation popover whose body
 * contains block elements (a `<p>` description). Since a markdown link sits
 * inline inside a paragraph `<p>`, that popover nests a `<p>` inside a `<p>` —
 * an invalid-DOM hydration error ("<p> cannot be a descendant of <p>").
 * Disabling it renders links as plain anchors. Centralised here so both
 * call sites (item-card, reasoning-block) stay consistent.
 */
import { Streamdown } from 'streamdown';

export function ChatMarkdown({ children }: { children: string }) {
  return <Streamdown linkSafety={{ enabled: false }}>{children}</Streamdown>;
}
