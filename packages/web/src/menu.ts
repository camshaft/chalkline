import { MainMenu } from '@excalidraw/excalidraw';
import { createElement, Fragment, useSyncExternalStore, type ReactElement } from 'react';
import type { Followed } from './followed';
import { SIDE_BUTTON_ACTIONS, type SideButtonSetting } from './pen';

/** The board's file commands, which the menu's Save file and Open file items run. */
export interface FileCommands {
  /** Saves the board as a file the browser downloads. */
  save(): void;
  /** Asks the person for a file to open onto the board. */
  open(): void;
}

/** What the page's items of Excalidraw's main menu do. */
export interface MenuActions {
  /** Opens a new board, in a new room. */
  newBoard(): void;
  /** Opens the page's connection settings. */
  connectionSettings(): void;
  /** Opens and closes the list of the agent's changes, each with an Undo button. */
  agentChanges(): void;
  /** The board's file commands, null until the board is open; the menu shows Save file and Open file once they are set. */
  files: Followed<FileCommands | null>;
  /**
   * Opens the History panel, null until this browser has opened its store of the board's snapshots; the menu shows
   * History once it is set.
   */
  history: Followed<(() => void) | null>;
  /** Whether the canvas shows its grid now. */
  grid(): boolean;
  /** Shows or hides the canvas's grid. */
  setGrid(shown: boolean): void;
  /** What a press of the pen's side button does, which the menu's Pen side button items choose. */
  sideButton: SideButtonSetting;
}

const icon = (...paths: string[]): ReactElement =>
  createElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: 16,
      height: 16,
      fill: 'none',
      stroke: 'currentColor',
      strokeWidth: 2,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      'aria-hidden': true,
    },
    ...paths.map((d) => createElement('path', { key: d, d })),
  );

const NEW_BOARD_ICON = icon('M12 5v14', 'M5 12h14');
const SAVE_ICON = icon('M12 3v12', 'M7 10l5 5 5-5', 'M5 21h14');
const OPEN_ICON = icon('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z');
const HISTORY_ICON = icon('M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8', 'M3 3v5h5', 'M12 7v5l4 2');
const SETTINGS_ICON = icon('M5 12.55a11 11 0 0 1 14.08 0', 'M1.42 9a16 16 0 0 1 21.16 0', 'M8.53 16.11a6 6 0 0 1 6.95 0', 'M12 20h.01');
const CHANGES_ICON = icon('M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11');
const GRID_ICON = icon('M3 3h18v18H3z', 'M3 9h18', 'M3 15h18', 'M9 3v18', 'M15 3v18');
const CHOSEN_ICON = icon('M5 12l5 5L20 7');
const UNCHOSEN_ICON = icon();

/** The Save file and Open file items, which show once the board's file commands are set. */
function FileItems({ files }: { files: Followed<FileCommands | null> }): ReactElement | null {
  const commands = useSyncExternalStore(files.subscribe, files.get);
  if (commands === null) return null;
  return createElement(
    Fragment,
    null,
    createElement(MainMenu.Item, { icon: SAVE_ICON, onSelect: () => commands.save(), children: 'Save file' }),
    createElement(MainMenu.Item, { icon: OPEN_ICON, onSelect: () => commands.open(), children: 'Open file' }),
  );
}

/** The History item, which shows once the History panel can open. */
function HistoryItem({ history }: { history: Followed<(() => void) | null> }): ReactElement | null {
  const open = useSyncExternalStore(history.subscribe, history.get);
  if (open === null) return null;
  return createElement(MainMenu.Item, { icon: HISTORY_ICON, onSelect: () => open(), children: 'History' });
}

/**
 * The item that shows or hides the canvas's grid. The menu shows its items again each time it opens, so
 * the item reads whether the grid shows then.
 */
function GridItem({ actions }: { actions: MenuActions }): ReactElement {
  const shown = actions.grid();
  return createElement(MainMenu.Item, {
    icon: GRID_ICON,
    onSelect: () => actions.setGrid(!shown),
    children: shown ? 'Hide grid' : 'Show grid',
  });
}

/**
 * The items that choose what a press of the pen's side button does, one for each choice, under the title Pen side
 * button. The menu shows its items again each time it opens, so the items read the choice then, and mark it.
 */
function SideButtonItems({ setting }: { setting: SideButtonSetting }): ReactElement {
  const chosen = setting.get();
  return createElement(MainMenu.Group, {
    title: 'Pen side button',
    children: SIDE_BUTTON_ACTIONS.map(({ action, label }) =>
      createElement(MainMenu.Item, {
        key: action,
        icon: action === chosen ? CHOSEN_ICON : UNCHOSEN_ICON,
        selected: action === chosen,
        onSelect: () => setting.set(action),
        children: label,
      }),
    ),
  });
}

/**
 * Excalidraw's main menu with the page's items first: New board, Save file and Open file once the board
 * is open, History once this browser has opened its snapshots of the board, Connection settings, and
 * Agent's changes, which opens the list of the agent's changes with an Undo button for each. Then come
 * Excalidraw's own items for the canvas, then its items for
 * the drawing space: the theme, the grid and the canvas's background, and last the items that choose what
 * the pen's side button does. The menu leaves out
 * Excalidraw's own Open and Save, which act on this page alone.
 */
export function ChalklineMenu({ actions }: { actions: MenuActions }): ReactElement {
  return createElement(MainMenu, {
    children: createElement(
      Fragment,
      null,
      createElement(MainMenu.Item, { icon: NEW_BOARD_ICON, onSelect: () => actions.newBoard(), children: 'New board' }),
      createElement(FileItems, { files: actions.files }),
      createElement(HistoryItem, { history: actions.history }),
      createElement(MainMenu.Item, {
        icon: SETTINGS_ICON,
        onSelect: () => actions.connectionSettings(),
        children: 'Connection settings',
      }),
      createElement(MainMenu.Item, {
        icon: CHANGES_ICON,
        onSelect: () => actions.agentChanges(),
        children: "Agent's changes",
      }),
      createElement(MainMenu.Separator, null),
      createElement(MainMenu.DefaultItems.SaveAsImage, null),
      createElement(MainMenu.DefaultItems.SearchMenu, null),
      createElement(MainMenu.DefaultItems.Help, null),
      createElement(MainMenu.DefaultItems.ClearCanvas, null),
      createElement(MainMenu.Separator, null),
      createElement(MainMenu.DefaultItems.ToggleTheme, null),
      createElement(GridItem, { actions }),
      createElement(MainMenu.DefaultItems.ChangeCanvasBackground, null),
      createElement(MainMenu.Separator, null),
      createElement(SideButtonItems, { setting: actions.sideButton }),
    ),
  });
}
