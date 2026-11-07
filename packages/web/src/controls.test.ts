// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bindStatusBadge, connectControlsToggle, controlsAttacher, followKeyboard, OPEN_CONTROLS } from './controls';

// A MutationObserver calls its callback in a microtask after the change.
const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

const press = (target: Element, key: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));

describe('controlsAttacher', () => {
  it("moves the controls into each host Excalidraw shows, and back to the page's body as a host goes", () => {
    const controls = document.createElement('div');
    const desktop = document.createElement('div');
    const phone = document.createElement('div');
    document.body.replaceChildren(controls, desktop, phone);
    const attach = controlsAttacher(controls);

    attach(desktop);
    expect(controls.parentElement).toBe(desktop);

    attach(null);
    expect(controls.parentElement).toBe(document.body);

    attach(phone);
    expect(controls.parentElement).toBe(phone);
  });

  it("leaves the controls where they are once they moved out of the host that goes", () => {
    const controls = document.createElement('div');
    const host = document.createElement('div');
    const elsewhere = document.createElement('div');
    document.body.replaceChildren(host, elsewhere);
    const attach = controlsAttacher(controls);

    attach(host);
    elsewhere.append(controls);
    attach(null);

    expect(controls.parentElement).toBe(elsewhere);
  });
});

describe('bindStatusBadge', () => {
  function badge(text = 'Joining the room...') {
    const button = document.createElement('button');
    const status = document.createElement('span');
    status.textContent = text;
    button.append(status);
    document.body.replaceChildren(button);
    const stop = bindStatusBadge(button, status);
    return { button, status, stop };
  }

  it('shows the whole status as its title, and follows each change of the status', async () => {
    const { button, status } = badge();
    expect(button.title).toBe('Joining the room...');

    status.textContent = "Couldn't reach a peer: the relay refused the connection.";
    await settled();

    expect(button.title).toBe("Couldn't reach a peer: the relay refused the connection.");
  });

  it('unfolds on a click or a tap, folds on the next one, and folds on Escape', () => {
    const { button } = badge();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    button.click();
    expect(button.getAttribute('aria-expanded')).toBe('false');

    button.click();
    press(button, 'Escape');
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('stops following the status once stopped', async () => {
    const { button, status, stop } = badge('Connected.');

    stop();
    status.textContent = 'Disconnected.';
    await settled();

    expect(button.title).toBe('Connected.');
  });
});

describe('connectControlsToggle', () => {
  function controls() {
    const box = document.createElement('div');
    const toggle = document.createElement('button');
    const name = document.createElement('input');
    box.append(toggle, name);
    document.body.replaceChildren(box);
    connectControlsToggle(toggle, box);
    return { box, toggle, name };
  }

  it('starts folded, and unfolds and folds the controls on each click or tap, which it says', () => {
    const { box, toggle } = controls();
    expect(box.classList.contains(OPEN_CONTROLS)).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(box.classList.contains(OPEN_CONTROLS)).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    toggle.click();
    expect(box.classList.contains(OPEN_CONTROLS)).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('folds the unfolded controls on Escape, and puts the focus back on the toggle', () => {
    const { box, toggle, name } = controls();
    toggle.click();
    name.focus();

    press(name, 'Escape');

    expect(box.classList.contains(OPEN_CONTROLS)).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
  });

  it("leaves the focus where it is on Escape while the controls are folded", () => {
    const { toggle, name } = controls();
    name.focus();

    press(name, 'Escape');

    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(name);
  });
});

describe('followKeyboard', () => {
  class FakeViewport extends EventTarget {
    height = 844;
    offsetTop = 0;
  }

  const variables = (root: HTMLElement) => ({
    inset: root.style.getPropertyValue('--chalkline-keyboard-inset'),
    visible: root.style.getPropertyValue('--chalkline-visible-height'),
  });

  it('sets the height the keyboard covers and the height left above it, on each resize and scroll', () => {
    const viewport = new FakeViewport();
    const root = document.createElement('div');
    followKeyboard({ innerHeight: 844, visualViewport: viewport }, root);
    expect(variables(root)).toEqual({ inset: '0px', visible: '844px' });

    // The keyboard shows, and the visible part shrinks.
    viewport.height = 500;
    viewport.dispatchEvent(new Event('resize'));
    expect(variables(root)).toEqual({ inset: '344px', visible: '500px' });

    // The browser scrolls the visible part down the page, as Safari does to show a field.
    viewport.offsetTop = 100;
    viewport.dispatchEvent(new Event('scroll'));
    expect(variables(root)).toEqual({ inset: '244px', visible: '500px' });

    // A zoomed-out page's visible part is taller than the window: the keyboard covers nothing.
    viewport.height = 900;
    viewport.offsetTop = 0;
    viewport.dispatchEvent(new Event('resize'));
    expect(variables(root)).toEqual({ inset: '0px', visible: '900px' });
  });

  it("leaves the variables unset in a browser that doesn't have a visual viewport", () => {
    const root = document.createElement('div');

    followKeyboard({ innerHeight: 844, visualViewport: null }, root)();

    expect(variables(root)).toEqual({ inset: '', visible: '' });
  });

  it('stops following the viewport once stopped', () => {
    const viewport = new FakeViewport();
    const root = document.createElement('div');
    const stop = followKeyboard({ innerHeight: 844, visualViewport: viewport }, root);

    stop();
    viewport.height = 500;
    viewport.dispatchEvent(new Event('resize'));

    expect(variables(root)).toEqual({ inset: '0px', visible: '844px' });
  });
});
