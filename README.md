# chalkline
A distributed whiteboarding and brainstorming tool that doesn't require a server

Open https://camshaft.github.io/chalkline/ and press New board to start a board. The page makes a new room and puts its name and password in the link's fragment, `#room=<name>&key=<password>`: share that link to invite people. A browser doesn't send the fragment to GitHub Pages, so the host never sees either part. A link that lacks either part, such as the page's own address, opens a join screen, where you start a new board or paste the link someone shared with you. The New board button at the top of a board starts another board in the same tab, putting another board's link in the address bar opens that board, and the browser's Back button returns to the board before it.

Browsers find each other through public Nostr relays with [Trystero](https://github.com/dmotz/trystero), which carry only the connection details, encrypted with the room's password, and then connect directly over WebRTC. The board's shapes are [Excalidraw](https://github.com/excalidraw/excalidraw) elements in a [Yjs](https://github.com/yjs/yjs) document, and each participant holds a full copy of it.

Each participant's cursor, name and selection travel beside the document as Yjs awareness state, which the board doesn't store: every other page draws your cursor with your name by it, and outlines the shapes you selected. Type the name the others see in the field at the top of the page; the browser keeps it for your next visit, and until you type one, it picks a name such as "Guest 4f2a".

## Saving

The browser keeps each board in its IndexedDB storage, one store for each room and password, so a board you reload or open again from its link shows its shapes before any peer connects. Shapes you draw while no one else is connected reach the others once a peer connects again.

The Save file button above the board downloads the board as an `.excalidraw` file, which Excalidraw opens too. The Open file button, or a `.excalidraw` file dropped on the board, adds the file's shapes to the board for everyone in the room; where the board already holds one of the file's shapes, the file's copy replaces it. An image's picture from a file shows only on the page that opened the file, since the board doesn't share picture data yet.

## Connection settings

The Connection settings button above the board opens two settings. They stay in the browser's own storage, apply to every board that browser opens, and are unset by default. Saving them reloads the board.

- TURN servers. Some networks, such as some office networks and VPNs, block direct connections between browsers, and the page then says that a peer couldn't connect. A TURN server forwards the encrypted traffic between two such browsers. Sign up for a hosted TURN service, such as [Cloudflare's](https://developers.cloudflare.com/calls/turn/), or run your own, such as [coturn](https://github.com/coturn/coturn), and enter its address, such as `turn:turn.example.com:3478`, with its username and password.
- Relays. Your own Nostr relays, one `wss://` address a line, which the page uses in place of the public relays. Everyone on a board needs at least one relay in common.

## Add a box from a script

`draw-box` joins a board from Node, with Trystero over [werift](https://github.com/shinyoshiaki/werift-webrtc), and adds one labelled rectangle made from Excalidraw's skeleton format:

```sh
npm ci
npm run build:node --workspace @chalkline/web
node packages/web/dist-node/draw-box.mjs --link '<the board link>' --label 'Hello from a script'
```

It stays in the room until you press Ctrl-C. `--help` lists its options.

## Development

The repository is one npm workspace. `packages/sync` holds the board's shared state and the adapter that carries it between participants over Trystero, with an in-memory network for its tests that loses, delays and reorders messages. `packages/web` holds the page and `draw-box`. `packages/lan` holds the local-network mode, `chalkline-lan`, one command that serves the built page and a Trystero WebSocket relay from one machine. It sends a request for the page to the same address with `?relay=/relay`, and a page whose address names a relay finds the other participants through that relay in place of the public Nostr relays and the relays of Connection settings. The TURN servers of Connection settings still apply.

CI runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` on each pull request and on `main`, and the Pages workflow publishes `main` to GitHub Pages.

Installs use `npm ci`, which installs the versions package-lock.json pins. A change that adds, removes or updates a dependency changes package-lock.json too: run `npm install` on your machine, or run the Lock file workflow on the change's branch with `gh workflow run lock.yml --ref main -f branch=<the branch>`, which writes package-lock.json there and runs CI and the Probe workflow on the new head.

The Probe workflow is the live test across networks: Chromium and Firefox, each on its own GitHub-hosted runner with its own public address, open one board, and `draw-box` joins it from a third runner. Each browser first opens the page's own address and waits for its join screen, then puts the board's link in the address bar, types its name, draws a rectangle with the mouse, and waits until it shows the other browser's rectangle, the script's box, and the other browser's cursor with its name. It then saves the board with the Save file button, opens a file that holds a copy of its rectangle, and waits until it shows each browser's copy. Last, it presses New board and waits until the page loads again on a new room's link. It runs on each pull request against the branch's build, and after each deploy against the live page. Each browser's job summary lists the connection type it used to each peer, and its screenshot is kept as an artifact.
