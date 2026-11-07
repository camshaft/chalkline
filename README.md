# chalkline
A distributed whiteboarding and brainstorming tool that doesn't require a server

## Open a board

Open https://camshaft.github.io/chalkline/ and press New board to start a board. The page makes a new room and puts its name and password in the link's fragment, `#room=<name>&key=<password>`: share that link to invite people. A browser doesn't send the fragment to GitHub Pages, so the host never sees either part. A link that lacks either part, such as the page's own address, opens a join screen, where you start a new board or paste the link someone shared with you. The New board button at the top of a board starts another board in the same tab, putting another board's link in the address bar opens that board, and the browser's Back button returns to the board before it.

Browsers find each other through public Nostr relays with [Trystero](https://github.com/dmotz/trystero), which carry only the connection details, encrypted with the room's password, and then connect directly over WebRTC. The board's shapes are [Excalidraw](https://github.com/excalidraw/excalidraw) elements in a [Yjs](https://github.com/yjs/yjs) document, and each participant holds a full copy of it. Reset the canvas, in Excalidraw's menu, clears the board for everyone in the room.

Each participant's cursor, name and selection travel beside the document as Yjs awareness state, which the board doesn't store: every other page draws your cursor with your name by it, and outlines the shapes you selected. Type the name the others see in the field at the top of the page; the browser keeps it for your next visit, and until you type one, it picks a name such as "Guest 4f2a".

## Saving

The browser keeps each board in its IndexedDB storage, one store for each room and password, so a board you reload or open again from its link shows its shapes before any peer connects. Shapes you draw while no one else is connected reach the others once a peer connects again.

The Save file button above the board downloads the board as an `.excalidraw` file, which Excalidraw opens too. The Open file button, or a `.excalidraw` file dropped on the board, adds the file's shapes to the board for everyone in the room; where the board already holds one of the file's shapes, the file's copy replaces it. Each image's picture, from an opened file, a drop or a paste, goes to everyone in the room with the board's shapes, and the browser keeps it with the board. Excalidraw adds images of up to 4 MiB.

## Connection settings

The Connection settings button above the board opens two settings. They stay in the browser's own storage, apply to every board that browser opens, and are unset by default. Saving them reloads the board.

- TURN servers. Some networks, such as some office networks and VPNs, block direct connections between browsers, and the page then says that a peer couldn't connect. A TURN server forwards the encrypted traffic between two such browsers. Sign up for a hosted TURN service, such as [Cloudflare's](https://developers.cloudflare.com/calls/turn/), or run your own, such as [coturn](https://github.com/coturn/coturn), and enter its address, such as `turn:turn.example.com:3478`, with its username and password.
- Relays. Your own Nostr relays, one `wss://` address a line, which the page uses in place of the public relays. Everyone on a board needs at least one relay in common.

## Run the local mode

Where everyone is on one local network, such as an office or a home network, `chalkline-lan` serves the page and a relay from one machine on it, and the browsers find each other through that machine instead of the public Nostr relays and the relays of Connection settings. On that machine, with Node 22 or later, in a clone of this repository:

```sh
npm ci
npm run lan
```

`npm run lan` builds the page and `chalkline-lan`, and starts it on port 8080. It prints the addresses it serves the board at: one for each of the machine's IPv4 addresses on a network, and `http://localhost:8080/` for the machine's own browser. Open one of them, press New board, and share the board's link from the address bar with the people on the same network. The link names the machine's relay, so each browser that opens it finds the board through that machine; the TURN servers of Connection settings still apply. It serves until you press Ctrl-C. `node packages/lan/dist/chalkline-lan.mjs --help` lists its options, such as `--port` for another port.

## Live speech

The microphone button above the board turns on live speech. Speech is off by default, and each browser turns it on for itself. Before the browser starts listening, the page says where recognition runs: on the device, where the browser offers on-device recognition of your language (Web Speech's `processLocally`), after a download where the language needs one, or else on the browser vendor's speech service, which receives your audio. Recognition starts only once you choose Start listening. Each final result goes on the board's transcript with your name and the time, and everyone on the board and the agent can read it; the words the browser hasn't settled yet show on your page alone. The Transcript button opens the transcript. Where the browser doesn't offer speech recognition, the microphone button is disabled, and the transcript still shows what the others say.

The Probe workflow's Speech jobs open a board in Playwright's Chromium, the runner's Google Chrome and Microsoft Edge, and Firefox, each with a fake microphone. Each checks that the microphone button is enabled only where the browser offers speech recognition, that the page doesn't start recognition before you press the button and agree, and that the page says where recognition runs first, and its job summary lists what the browser offered and did.

The browsers the change ran in, in those jobs on 2026-11-07 (the fake microphone's tone has no words, so these runs didn't add a transcript entry) and on cameron's desktop:

| Browser | What it offered | What happened |
| --- | --- | --- |
| Google Chrome 156.0.8078.79, headless, Linux (the runner's own Chrome) | `SpeechRecognition`, `processLocally`, `available` and `install` | Its check said that en-US needs a download, and the page said so before it started. After Start listening, the browser downloaded the language and recognition started on the device. The microphone button turned it off. |
| Microsoft Edge 156.0.4314.58, headless, Linux (the runner's own Edge) | `SpeechRecognition`, `processLocally`, `available` and `install` | Its check didn't offer en-US on the device, so the page named the vendor's speech service before it started. After Start listening, recognition started on the service. The microphone button turned it off. |
| Firefox 159.0, headless, Linux | Neither `SpeechRecognition` nor `webkitSpeechRecognition` | The microphone button is disabled. |
| Playwright's Chromium 158.0.8127.18 (its headless shell), Linux | `SpeechRecognition`, `processLocally`, `available` and `install` | The tab crashed when the page called `SpeechRecognition.available({ langs: ['en-US'], processLocally: true })`, after the microphone button. |
| Headless Chromium 149.0.7827.0, Linux, on cameron's desktop, on the live page before this change | `SpeechRecognition`, `processLocally`, `available` and `install` | A direct call of `SpeechRecognition.available({ langs: ['en-US'], processLocally: true })` didn't answer, and the page stopped answering, in each of three tries. |

So the page asks the browser where recognition runs only once you press the microphone button, and shows Cancel speech while the browser answers.

## Add a box from a script

`draw-box` joins a board from Node, with Trystero over [werift](https://github.com/shinyoshiaki/werift-webrtc), and adds one labelled rectangle made from Excalidraw's skeleton format:

```sh
npm ci
npm run build:node --workspace @chalkline/web
node packages/web/dist-node/draw-box.mjs --link '<the board link>' --label 'Hello from a script'
```

It stays in the room until you press Ctrl-C. `--help` lists its options.

## Connect an agent

`chalkline-mcp` serves the board's tools to an agent as a local MCP server, and `chalkline-mcp listen` tells the agent what people on the board say. Each takes the board's link, a link of the local mode among them: that link names its machine's relay, and they find the board through it. Build it, and add the server to Claude Code with the board's link:

```sh
npm ci
npm run build --workspace @chalkline/mcp
claude mcp add --transport stdio chalkline -- node "$PWD/packages/mcp/dist/chalkline-mcp.mjs" '<the board link>'
```

An MCP server answers the calls its agent makes, so the agent learns what someone said only once it reads the transcript. `chalkline-mcp listen` joins the board too, and prints on standard output one JSON line for each group of words people say with no pause of 1 second between them, such as:

```json
{"at":"2026-11-07T03:00:04.000Z","speakers":["Ada","Grace"],"text":"draw a smiley face in blue"}
```

`text` holds the group's words, `speakers` who said them, and `at` when its last words were said. What was said before the listener started is left out. Claude Code's Monitor tool runs a command in the background and turns each line the command prints into a message to the agent, so ask Claude Code, in the directory you built in, to run the listener with it:

> Use the Monitor tool to run `node packages/mcp/dist/chalkline-mcp.mjs listen '<the board link>' 2>>chalkline-listen.log` for 30 minutes, and act on each line it prints with the chalkline tools.

Each line costs the agent one turn. `--pause <seconds>` sets how long a pause ends a group: a longer pause puts more of what people say in one line, and so in one turn, and the agent answers later. The listener logs to standard error, which the command above adds to `chalkline-listen.log`: where it starts listening, each peer that connects and leaves, where it loses the room as its last peer leaves, and where it joins the room again.

A Monitor watch ends at its deadline, 30 minutes at most, and Claude Code tells the agent when it ends. To go on listening, run the command again with `--after` set to the `at` of the last line the listener printed, or, where it printed none, to the time its log's `listening in room` line shows, so that the new listener leaves out what the old one printed and keeps what was said between the two. On Amazon Bedrock, the Monitor tool needs Claude Code v2.1.310 or later. `chalkline-mcp listen --help` lists the listener's options.

## Development

The repository is one npm workspace. `packages/sync` holds the board's shared state, the entries of its transcript, the format of a board's link, and the adapter that carries the state between participants over Trystero, with an in-memory network for its tests that loses, delays and reorders messages. `packages/web` holds the page and `draw-box`. `packages/mcp` holds `chalkline-mcp`, the agent's helper: a local MCP server over standard input and output that joins the board its link opens, keeps its own copy of the board, and serves the tools `get_board`, which reads the board's shapes, with the points of each line, arrow and freehand stroke, and the Mermaid requests that no page has converted yet, `render_board`, which draws the whole board or a part of it as a PNG from the helper's copy of the board, so it needs no page, `add_shapes`, which adds shapes in Excalidraw's skeleton format: rectangles, ellipses, diamonds, texts, arrows and lines, a line or an arrow through points of its own, such as a curve or a zigzag, a closed line that its background color fills, and freehand strokes of the pen (`freedraw`), `add_mermaid`, which asks a page to convert the Mermaid text of a whole diagram into shapes, `get_request`, which reads such a request by its id, `connect`, which draws an arrow bound to two shapes of the board, `update_shape`, which moves, resizes, relabels or recolors a shape, `delete_shapes`, which deletes shapes with their labels, and `read_transcript`, which reads the board's transcript. Each shape the helper adds, through its tools or through a Mermaid request, records the agent as its creator in the element's `customData`, so that the agent can change its own shapes. The conversion runs in a browser, so the helper writes each Mermaid request into the board's shared state, and one page of the room, the one whose awareness client id is the lowest, converts it, adds its shapes and marks it done, or marks it failed with the reason. A request written while no page is open stays on the board, and the first page that joins converts it. `read_transcript` answers the transcript's entries after a cursor, with the cursor after them, and where no entry follows the cursor, it answers once someone on the board says one. The helper also offers the transcript as the MCP resource `chalkline://transcript`, and notifies a client that subscribes to it after each change that adds an entry. `packages/lan` holds the local-network mode, `chalkline-lan`, one command that serves the built page and a Trystero WebSocket relay from one machine. It sends a request for the page to the same address with `?relay=/relay`, and a page whose address names a relay finds the other participants through that relay in place of the public Nostr relays and the relays of Connection settings. The TURN servers of Connection settings still apply.

CI runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` on each pull request and on `main`, then starts the built `chalkline-mcp` on a new board and calls its tools, runs `chalkline-mcp listen --help` and starts `chalkline-mcp listen` on a new board, and the Pages workflow publishes `main` to GitHub Pages.

CI's End-to-end test job builds the page and `chalkline-mcp` and runs `npm run test:e2e --workspace @chalkline/lan`. The test serves the built page and the relay from one machine, as `chalkline-lan` does, opens the board in two Chromium contexts with Playwright, and starts the built `chalkline-mcp` on the same board through that relay. The helper adds a labelled rectangle and a labelled ellipse and connects them with a labelled arrow, and the test waits until both browsers show each of them with its label, its creator and the arrow's two ends. Each browser's screenshot is kept as an artifact. The test doesn't press the microphone button, since the tab of Playwright's Chromium crashes where the page asks whether speech recognition is available.

CI's README steps job runs the steps of Open a board, Run the local mode and Connect an agent in a new checkout, with the commands this file lists: `packages/lan/e2e/readme-steps.mjs` reads each command from this file and runs it from the repository's root, so a change to a step's commands changes what the job runs. It runs `npm ci` and `npm run lan`, opens the address `chalkline-lan` prints for localhost in Chromium with Playwright, presses New board, and opens the board's link from the address bar in a second browser context. It builds `chalkline-mcp`, runs the `claude mcp add` command with that link, and checks that `claude mcp get` lists the server. It then starts the command that `claude mcp add` was given, as Claude Code starts it, and the helper adds a labelled rectangle, which both browsers show. Next it runs the listener's command, adds an entry to the board's transcript from the first browser, as the page does for a person's speech, and waits until the listener prints it. It also opens the page at the address in Open a board, presses New board, and waits until the page joins the new board. Where Connect an agent repeats `npm ci`, the job doesn't run it again in the same checkout. Claude Code's Monitor tool turns each line into a turn of a model, which needs a model account, so the job runs the listener's command itself, as the Monitor tool runs it.

Installs use `npm ci`, which installs the versions package-lock.json pins. A change that adds, removes or updates a dependency changes package-lock.json too: run `npm install` on your machine, or run the Lock file workflow on the change's branch with `gh workflow run lock.yml --ref main -f branch=<the branch>`, which writes package-lock.json there and runs CI and the Probe workflow on the new head.

The Probe workflow is the live test across networks: Chromium and Firefox, each on its own GitHub-hosted runner with its own public address, open one board, and `draw-box` joins it from a third runner. Each browser first opens the page's own address and waits for its join screen, then puts the board's link in the address bar, types its name, draws a rectangle with the mouse, and waits until it shows the other browser's rectangle, the script's box, and the other browser's cursor with its name. It then saves the board with the Save file button, opens a file that holds a copy of its rectangle and an image with a picture of about 262 KB, and waits until it shows each browser's copy and image, with each image's picture. Next Chromium resets the canvas from Excalidraw's menu, and each browser waits until its board shows none of the shapes. Each browser then writes a request for a page to draw a Mermaid diagram, as `add_mermaid` does, and waits until its board shows each browser's diagram. Last, it presses New board and waits until the page loads again on a new room's link. It runs on each pull request against the branch's build, and after each deploy against the live page. Each browser's job summary lists the connection type it used to each peer, and its screenshot is kept as an artifact.
