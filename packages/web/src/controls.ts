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

/** The part of a window's visual viewport that `followKeyboard` reads. */
export interface KeyboardViewport {
  readonly height: number;
  readonly offsetTop: number;
  addEventListener(type: 'resize' | 'scroll', listener: () => void): void;
  removeEventListener(type: 'resize' | 'scroll', listener: () => void): void;
}

/** The part of a window that `followKeyboard` reads. */
export interface KeyboardWindow {
  readonly innerHeight: number;
  readonly visualViewport: KeyboardViewport | null;
}

/**
 * Sets two variables on `root` from the window's visual viewport, which shrinks while a phone's
 * on-screen keyboard shows: `--chalkline-keyboard-inset`, the height of the page below the part the
 * person sees, which the keyboard covers, and `--chalkline-visible-height`, the height of the part they
 * see. It sets them again on each resize and scroll of the visual viewport, and leaves them unset in a
 * browser that doesn't have one. Returns `stop`, which stops following the viewport.
 */
export function followKeyboard(win: KeyboardWindow, root: HTMLElement): () => void {
  const viewport = win.visualViewport;
  if (viewport === null) return () => undefined;
  const follow = () => {
    const inset = Math.max(0, win.innerHeight - viewport.height - viewport.offsetTop);
    root.style.setProperty('--chalkline-keyboard-inset', `${Math.round(inset)}px`);
    root.style.setProperty('--chalkline-visible-height', `${Math.round(viewport.height)}px`);
  };
  viewport.addEventListener('resize', follow);
  viewport.addEventListener('scroll', follow);
  follow();
  return () => {
    viewport.removeEventListener('resize', follow);
    viewport.removeEventListener('scroll', follow);
  };
}
