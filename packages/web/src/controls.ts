/**
 * The page's controls over the canvas: the status badge, the name field, and the speech, Chat and
 * Connection settings buttons, which index.html holds in one element, `#controls`.
 */

/** The class that unfolds the controls on a phone, where they show the status and the More button alone. */
export const OPEN_CONTROLS = 'chalkline-controls--open';

/**
 * Returns the ref that moves `controls` into the element Excalidraw's `renderTopRightUI` shows, and back
 * to the page's body as Excalidraw takes that element away, such as where it switches between its
 * desktop and its phone layout, so that the same controls, with their listeners and their state, stay on
 * the page. React calls a ref with null before it calls the next one with its element.
 */
export function controlsAttacher(controls: HTMLElement): (host: HTMLElement | null) => void {
  let attached: HTMLElement | null = null;
  return (host) => {
    if (host !== null) {
      attached = host;
      host.append(controls);
      return;
    }
    if (attached !== null && controls.parentElement === attached) controls.ownerDocument.body.append(controls);
    attached = null;
  };
}

/**
 * Makes `badge` show the whole of the status `text` holds: its title follows the text, for a pointer's
 * hover, and a click or a tap unfolds the badge to show the whole message on as many lines as it takes,
 * and folds it again, which `aria-expanded` says. Escape folds it. Returns `stop`, which stops following
 * the text.
 */
export function bindStatusBadge(badge: HTMLButtonElement, text: HTMLElement): () => void {
  const follow = () => {
    badge.title = text.textContent ?? '';
  };
  const observer = new MutationObserver(follow);
  observer.observe(text, { childList: true, characterData: true, subtree: true });
  follow();
  badge.setAttribute('aria-expanded', 'false');
  badge.addEventListener('click', () => {
    badge.setAttribute('aria-expanded', String(badge.getAttribute('aria-expanded') !== 'true'));
  });
  badge.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') badge.setAttribute('aria-expanded', 'false');
  });
  return () => observer.disconnect();
}

/**
 * Makes `toggle` fold and unfold `controls` on a phone, where they show the status and `toggle` alone
 * until a person unfolds them: a click or a tap unfolds or folds them, which `aria-expanded` says, and
 * Escape in the unfolded controls folds them and puts the focus back on `toggle`.
 */
export function connectControlsToggle(toggle: HTMLButtonElement, controls: HTMLElement): void {
  const unfold = (open: boolean) => {
    controls.classList.toggle(OPEN_CONTROLS, open);
    toggle.setAttribute('aria-expanded', String(open));
  };
  toggle.addEventListener('click', () => unfold(!controls.classList.contains(OPEN_CONTROLS)));
  controls.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !controls.classList.contains(OPEN_CONTROLS)) return;
    unfold(false);
    toggle.focus();
  });
  unfold(false);
}
