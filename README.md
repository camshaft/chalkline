# chalkline
A distributed whiteboarding and brainstorming tool that doesn't require a server

Open https://camshaft.github.io/chalkline/ to start a board. The page makes a new room and puts its name and password in the link's fragment, `#room=<name>&key=<password>`: share that link to invite people. A browser doesn't send the fragment to GitHub Pages, so the host never sees either part.

Browsers find each other through public Nostr relays with [Trystero](https://github.com/dmotz/trystero), which carry only the connection details, encrypted with the room's password, and then connect directly over WebRTC. The board's shapes are [Excalidraw](https://github.com/excalidraw/excalidraw) elements in a [Yjs](https://github.com/yjs/yjs) document, and each participant holds a full copy of it.

## Add a box from a script

`draw-box` joins a board from Node, with Trystero over [werift](https://github.com/shinyoshiaki/werift-webrtc), and adds one labelled rectangle made from Excalidraw's skeleton format:

```sh
npm install
npm run build:node --workspace @chalkline/web
node packages/web/dist-node/draw-box.mjs --link '<the board link>' --label 'Hello from a script'
```

It stays in the room until you press Ctrl-C. `--help` lists its options.

## Development

The repository is one npm workspace. `packages/sync` holds the board's shared state and the adapter that carries it between participants over Trystero, with an in-memory network for its tests that loses, delays and reorders messages. `packages/web` holds the page and `draw-box`.

CI runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` on each pull request and on `main`, and the Pages workflow publishes `main` to GitHub Pages.

The Probe workflow is the live test across networks: Chromium and Firefox, each on its own GitHub-hosted runner with its own public address, open one board, and `draw-box` joins it from a third runner. Each browser draws a rectangle with the mouse and waits until it shows the other browser's rectangle and the script's box. It runs on each pull request against the branch's build, and after each deploy against the live page. Each browser's job summary lists the connection type it used to each peer, and its screenshot is kept as an artifact.
