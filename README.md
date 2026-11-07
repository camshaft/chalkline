# chalkline
A distributed whiteboarding and brainstorming tool that doesn't require a server

## Open a board

Open https://camshaft.github.io/chalkline/ and press New board to start a board. The page makes a new room and puts its name and password in the link's fragment, `#room=<name>&key=<password>`: share that link to invite people. A browser doesn't send the fragment to GitHub Pages, so the host never sees either part. A link that lacks either part, such as the page's own address, opens a join screen, where you start a new board or paste the link someone shared with you. New board, in Excalidraw's main menu, starts another board in the same tab, putting another board's link in the address bar opens that board, and the browser's Back button returns to the board before it.

Browsers find each other through public Nostr relays with [Trystero](https://github.com/dmotz/trystero), which carry only the connection details, encrypted with the room's password, and then connect directly over WebRTC. The board's shapes are [Excalidraw](https://github.com/excalidraw/excalidraw) elements in a [Yjs](https://github.com/yjs/yjs) document, and each participant holds a full copy of it. Reset the canvas, in Excalidraw's menu, clears the board for everyone in the room.

Each participant's cursor, name and selection travel beside the document as Yjs awareness state, which the board doesn't store: every other page draws your cursor with your name by it, and outlines the shapes you selected. Type the name the others see in the name field, in the page's controls at the board's top right; the browser keeps it for your next visit, and until you type one, it picks a name such as "Guest 4f2a".

The page's controls sit over the canvas in Excalidraw's own style and theme, so the canvas fills the window: the status, the name field, and the microphone and Chat buttons at the board's top right, and New board, Save file, Open file and Connection settings in Excalidraw's main menu. The status shows its start in a badge, and its whole message on hover, or once you click or tap the badge. On a phone, the controls take the screen's left edge, and show the status and More, which unfolds the rest. The canvas's background color, its grid and the Pen side button setting, which the main menu sets, stay with your browser for your next visit, as your name does; they are yours, and don't change the others' pages.

## Saving

The browser keeps each board in its IndexedDB storage, one store for each room and password, so a board you reload or open again from its link shows its shapes before any peer connects. Shapes you draw while no one else is connected reach the others once a peer connects again.

The main menu's Save file item downloads the board as an `.excalidraw` file, which Excalidraw opens too. Its Open file item, or a `.excalidraw` file dropped on the board, adds the file's shapes to the board for everyone in the room; where the board already holds one of the file's shapes, the file's copy replaces it. Each image's picture, from an opened file, a drop or a paste, goes to everyone in the room with the board's shapes, and the browser keeps it with the board. Excalidraw adds images of up to 4 MiB.

## Connection settings

Connection settings, in the main menu, or the Connection settings button on the join screen, opens two settings. They stay in the browser's own storage, apply to every board that browser opens, and are unset by default. Saving them reloads the board.

- TURN servers. Some networks, such as some office networks and VPNs, block direct connections between browsers, and the page then says that a peer couldn't connect. A TURN server forwards the encrypted traffic between two such browsers. Sign up for a hosted TURN service, such as [Cloudflare's](https://developers.cloudflare.com/calls/turn/), or run your own, such as [coturn](https://github.com/coturn/coturn), and enter its address, such as `turn:turn.example.com:3478`, with its username and password. On a board of three or more, a browser that connects to two others that can't connect to each other carries the board's changes and cursors between them.
- Relays. Your own Nostr relays, one `wss://` address a line, which the page uses in place of the public relays. Everyone on a board needs at least one relay in common.

## Run the local mode

Where everyone is on one local network, such as an office or a home network, `chalkline-lan` serves the page and a relay from one machine on it, and the browsers find each other through that machine instead of the public Nostr relays and the relays of Connection settings. On that machine, with Node 22 or later, in a clone of this repository:

```sh
npm ci
npm run lan
```

`npm run lan` builds the page and `chalkline-lan`, and starts it on port 8080. It prints the addresses it serves the board at: one for each of the machine's IPv4 addresses on a network, and `http://localhost:8080/` for the machine's own browser. Open one of them, press New board, and share the board's link from the address bar with the people on the same network. The link names the machine's relay, so each browser that opens it finds the board through that machine; the TURN servers of Connection settings still apply. It serves until you press Ctrl-C. `node packages/lan/dist/chalkline-lan.mjs --help` lists its options, such as `--port` for another port.

## Chat

The Chat button in the page's controls opens the board's chat, which everyone on the board and the agent read. Type a message in its field and press Enter or Send: the chat of each participant shows it with your name and the time. Shift+Enter starts a new line, and the field grows with the message up to six lines. Live speech adds to the same chat, and the agent answers there with `post_message`. Its Close button, or Escape, closes it. The chat opens on its newest message and keeps each new one in view. Where you scroll up to read earlier messages, it stays where you are and shows a New messages button, which takes you back to the end, as sending a message does.

On a phone, the chat opens as a sheet across the screen's width, over the canvas. While the on-screen keyboard shows, the sheet sits above it, so its Message field stays in sight.

Where the browser can speak (Web Speech's `speechSynthesis`), the Read agent messages aloud button in the page's controls, under the microphone, Chat and Feedback buttons, reads each message an agent posts in the chat aloud, so that you hear the agent's answers with the chat closed or away from the screen. It is off by default, and each browser turns it on for itself: press the button, and press it again to stop, which also stops the message it is reading. It reads each message that comes once it is on, once, and not the messages from before. While it reads a message, live speech stops listening, so that the board doesn't take the agent's words for yours, and it listens again once the message ends. Where the browser can't speak, the page doesn't show the button.

## Live speech

The microphone button in the page's controls turns on live speech. Speech is off by default, and each browser turns it on for itself. Before the browser starts listening, the page says where recognition runs: on the device, where the browser offers on-device recognition of your language (Web Speech's `processLocally`), after a download where the language needs one, or else on the browser vendor's speech service, which receives your audio. Recognition starts only once you choose Start listening. Each final result goes on the board's chat with your name and the time, as a typed message does, and everyone on the board and the agent can read it; the words the browser hasn't settled yet show on your page alone. Where the browser doesn't offer speech recognition, the microphone button is disabled, and you can still type in the chat.

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

## Pen tablets

With a pen tablet, such as a Wacom tablet, the pen's side button switches tools, so that you can change tools without the keyboard. The main menu's Pen side button items choose what a press of the side button does:

| Choice | A press of the side button |
| --- | --- |
| Switch between the last two tools, the default | Goes back to the tool you used before the current one, such as from the selection tool to free draw and back. Until you change tools, it picks free draw, or the selection tool from free draw. |
| Toggle the eraser | Picks the eraser, and the next press goes back to the tool before it. |
| Toggle the selection tool | Picks the selection tool, and the next press goes back to the tool before it. |
| Open the menu | Opens Excalidraw's menu, as a right click does. |

Your browser keeps the choice for your next visit, as it keeps your name. The page acts on a press that the browser reports as the pen's secondary button, a pointer event whose `pointerType` is `pen` and whose `button` is 2, and a mouse's right click still opens Excalidraw's menu. The side button doesn't pick Excalidraw's image tool, which asks for a file.

The page sees the tablet's buttons and the pen's other side button only as the keys or clicks that the tablet's driver sends for them, so set each one in the driver. This mapping to Chalkline's shortcuts hasn't been tried on a tablet yet:

| Button | Set the driver to send | What it does in Chalkline |
| --- | --- | --- |
| One of the pen's side buttons | A right click | What the Pen side button setting chooses |
| The pen's other side button | A middle click | Pans the canvas, as a mouse's middle button does |
| Tablet button 1 | The key `P` | Free draw |
| Tablet button 2 | The key `E` | The eraser |
| Tablet button 3 | The key `V` | The selection tool |
| Tablet button 4 | `Ctrl+Z`, or `Cmd+Z` on a Mac | Undo |

Excalidraw's other shortcuts suit more buttons: `R` for a rectangle, `D` for a diamond, `O` for an ellipse, `A` for an arrow, `L` for a line, `T` for a text and `H` for the hand, which pans. The main menu's Help lists every shortcut.

## Add a box from a script

`draw-box` joins a board from Node, with Trystero over [werift](https://github.com/shinyoshiaki/werift-webrtc), and adds one labelled rectangle made from Excalidraw's skeleton format:

```sh
npm ci
npm run build:node --workspace @chalkline/web
node packages/web/dist-node/draw-box.mjs --link '<the board link>' --label 'Hello from a script'
```

It stays in the room until you press Ctrl-C. `--help` lists its options.

## Connect an agent

`chalkline-mcp` serves the board's tools to an agent as a local MCP server, and `chalkline-mcp listen` tells the agent what people on the board say, type, write and draw. Each takes the board's link, a link of the local mode among them: that link names its machine's relay, and they find the board through it. Build it, and add the server to Claude Code with the board's link:

```sh
npm ci
npm run build --workspace @chalkline/mcp
claude mcp add --transport stdio chalkline -- node "$PWD/packages/mcp/dist/chalkline-mcp.mjs" '<the board link>'
```

An MCP server answers the calls its agent makes, so the agent learns what someone said or typed only once it reads the chat. `chalkline-mcp listen` joins the board too, and prints on standard output one JSON line for each group of words people say or type in the chat with no pause of 1 second between them, such as:

```json
{"at":"2026-11-07T03:00:04.000Z","speakers":["Ada","Grace"],"text":"draw a smiley face in blue"}
```

`text` holds the group's words, `speakers` who said them, and `at` when its last words were said. What was said before the listener started is left out, and so is each message an agent posts in the chat with `post_message`, so that the agent doesn't receive its own answers. Claude Code's Monitor tool runs a command in the background and turns each line the command prints into a message to the agent, so ask Claude Code, in the directory you built in, to run the listener with it:

> Use the Monitor tool to run `node packages/mcp/dist/chalkline-mcp.mjs listen '<the board link>' 2>>chalkline-listen.log` for 30 minutes, and act on each line it prints with the chalkline tools.

Each line costs the agent one turn. `--pause <seconds>` sets how long a pause ends a group: a longer pause puts more of what people say in one line, and so in one turn, and the agent answers later. The listener logs to standard error, which the command above adds to `chalkline-listen.log`: where it starts listening, each peer that connects and leaves, where it loses the room as its last peer leaves, and where it joins the room again.

The listener also prints a line for each text a person writes or changes on the board, a shape's label among them, once the text stays unchanged for 3 seconds, and a line for the freehand strokes a person draws, once they stay unchanged for 3 seconds, such as:

```json
{"at":"2026-11-07T03:00:09.000Z","kind":"text","text":"Claude are you listening?"}
{"at":"2026-11-07T03:00:21.000Z","kind":"sketch","ids":["Xk2fP9qL0aB3cD4eF5gH","m8N7b6V5c4X3z2L1k0Jh"],"box":{"x":120,"y":80,"width":340,"height":210}}
```

A text's line holds its words and when the person last changed it, and a sketch's line holds the ids of its strokes, as `get_board` and `read_changes` list them, the part of the board they cover and when the person last changed one. The agent's own changes don't make a line: the helper marks each element it adds or changes with the agent and the element's version, so a text the agent writes or changes doesn't make one, and neither does a freehand stroke an agent drew or a stroke whose last change the agent made. A person's later change of the words of an agent's text, such as a correction of the agent's answer, makes a line, and a text a person moves without changing its words doesn't. A freehand stroke makes a line where its place or points change, and a page's save of it with the same place and points doesn't. Where the listener first receives a text whose copy doesn't record when its words last changed, as a text a page wrote before Chalkline's pages recorded it, or a stroke whose copy doesn't record when its place and points last changed, and its last change came before the listener started, it reads it as one written or drawn before it started, since a page may save such an element again without changing it. A page that saves such a text again with the same words, or such a stroke again with the same place and points, records the time of the element's last change before the save as the time they last changed, so a listener that first receives the saved element reads it by that time. `--board-pause <seconds>` sets how long a text or a sketch stays unchanged before its line.

A Monitor watch ends at its deadline, 30 minutes at most, and Claude Code tells the agent when it ends. To go on listening, run the command again with `--after` set to the `at` of the last line the listener printed, or, where it printed none, to the time its log's `listening in room` line shows, so that the new listener leaves out what the old one printed and keeps what was said between the two. A text or a stroke whose copy doesn't record when its words, or its place and points, last changed is left out where its last change came between `--after` and the listener's start, though a person may have changed it then. On Amazon Bedrock, the Monitor tool needs Claude Code v2.1.310 or later. `chalkline-mcp listen --help` lists the listener's options.

## Development

The repository is one npm workspace. `packages/sync` holds the board's shared state, the entries of its transcript, which the page shows as its chat, the format of a board's link, and the adapter that carries the state between participants over Trystero, with an in-memory network for its tests that loses, delays and reorders messages. `packages/web` holds the page and `draw-box`. `packages/mcp` holds `chalkline-mcp`, the agent's helper: a local MCP server over standard input and output that joins the board its link opens, keeps its own copy of the board, and serves the tools `get_board`, which reads the board's shapes, with the points of each line, arrow and freehand stroke, the Mermaid requests that no page has converted yet, and the open feedback, `render_board`, which draws the whole board or a part of it as a PNG from the helper's copy of the board, so it needs no page, `add_shapes`, which adds shapes in Excalidraw's skeleton format: rectangles, ellipses, diamonds, texts, arrows and lines, a line or an arrow through points of its own, such as a curve or a zigzag, a closed line that its background color fills, and freehand strokes of the pen (`freedraw`), in front of the board's shapes or where its `place` puts them, `add_mermaid`, which asks a page to convert the Mermaid text of a whole diagram into shapes, `get_request`, which reads such a request by its id, `connect`, which draws an arrow bound to two shapes of the board, `update_shape`, which moves, resizes, relabels or recolors a shape, `delete_shapes`, which deletes shapes with their labels, `reorder_shapes`, which moves shapes forward or back in the board's stacking order, each with its label, `scale_shapes`, which makes shapes, or the shapes of a group, smaller or larger around a point in one change, each with its label, `read_changes`, which reads the shapes added, changed and deleted on the board, each as `get_board` lists it, with its creator, `read_transcript`, which reads the board's transcript, `post_message`, which posts a message in the board's chat, `read_feedback`, which reads the feedback people write on areas of the board, each with the shapes its area holds, and `answer_feedback`, which answers a feedback with what the agent changed for it. Each shape the helper adds, through its tools or through a Mermaid request, records the agent as its creator in the element's `customData`, so that the agent can change its own shapes. Each element the helper adds or changes also records the agent and the element's version, its change mark, so that a later change of the element by a person's page, which sets a new version on the element, reads as the person's. The conversion runs in a browser, so the helper writes each Mermaid request into the board's shared state, and one page of the room, the one whose awareness client id is the lowest, converts it, adds its shapes and marks it done, or marks it failed with the reason. A request written while no page is open stays on the board, and the first page that joins converts it. `read_transcript` answers the transcript's entries after a cursor, each with its `via`, `speech`, `typed` or `agent`, which says whether someone said it, typed it in the chat or an agent posted it, with the cursor after them, and where no entry follows the cursor, it answers once someone on the board says, types or posts one. An entry without `via`, as each one written before the chat, reads as speech. `read_changes` answers in the same way: each shape added, changed or deleted after its cursor, once, with the cursor after them, and where no shape changed after the cursor, it answers on the next change of a shape. A change of only a text's place, size or font isn't one of its changes, since a page changes them as it measures the text again. The helper also offers the transcript as the MCP resource `chalkline://transcript`, and notifies a client that subscribes to it after each change that adds an entry. `read_feedback` answers each feedback that became open after a cursor, a new one or one a person reopened, and where none did, it answers once a person writes or reopens one. The helper offers the open feedback as the MCP resource `chalkline://feedback` too, and notifies a client that subscribes to it after each change that opens a feedback. `packages/lan` holds the local-network mode, `chalkline-lan`, one command that serves the built page and a Trystero WebSocket relay from one machine. It sends a request for the page to the same address with `?relay=/relay`, and a page whose address names a relay finds the other participants through that relay in place of the public Nostr relays and the relays of Connection settings. The TURN servers of Connection settings still apply.

CI runs `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` on each pull request and on `main`, then starts the built `chalkline-mcp` on a new board and calls its tools, runs `chalkline-mcp listen --help` and starts `chalkline-mcp listen` on a new board, and the Pages workflow publishes `main` to GitHub Pages.

CI's End-to-end test job builds the page and `chalkline-mcp` and runs `npm run test:e2e --workspace @chalkline/lan`. The test serves the built page and the relay from one machine, as `chalkline-lan` does, opens the board in two Chromium contexts with Playwright, and starts the built `chalkline-mcp` on the same board through that relay. The helper adds a labelled rectangle and a labelled ellipse and connects them with a labelled arrow, and the test waits until both browsers show each of them with its label, its creator and the arrow's two ends. A second test opens a board in a desktop's window and in a phone's, 390 px wide, and checks that the canvas fills the window and that the page's controls lie within it, clear of Excalidraw's toolbar and buttons. It uses each control in its place: the status badge, the name field, the microphone button, the chat with its Close button, which on a phone opens as a sheet across the screen's width, and the main menu's Connection settings, Save file, Open file, Show grid, dark mode and New board. On the desktop it checks that the grid and the canvas's background stay across a reload, and it presses the pen's side button through Chromium's DevTools protocol: it checks that each press switches tools without Excalidraw's menu, that a mouse's right click still opens that menu, and that the Pen side button choice stays across a reload. The test presses the microphone button with a stand-in for the browser's speech recognition that doesn't ask whether recognition is available, since the tab of Playwright's Chromium crashes where the page asks that. Each browser's screenshot, and each layout's, light and dark and at 390 px wide, is kept as an artifact; for a pull request from a branch of this repository, the screenshots job copies them to the `screenshots` branch, in a directory named after the pull request's branch, where the pull request's description shows them.

CI's Board size measurement job builds the page and `chalkline-mcp` and runs `npm run measure --workspace @chalkline/lan`, the measurement in `packages/lan/e2e/board-size.measure.ts`. It serves the built page and the relay from one machine, as `chalkline-lan` does, opens a board in Chromium, and fills it with 100 shapes through the built `chalkline-mcp`, then a new board with 4,000: small rectangles, ellipses and lines, the shapes an agent's pictures are made of. For each board it prints, in one table, how long the page takes to load the board again, to draw it zoomed in and zoomed out, to show a shape that one `update_shape` call moves, and to show the shapes that 100 `update_shape` calls move one after another, as an agent's calls do. It counts each as the main thread's busy time from Chromium's metrics and as the time the page spends in the transactions that apply the helper's changes. It then checks that one `update_shape` call costs the page's main thread no more on the board of 4,000 shapes than on the board of 100 zoomed in, and no more than one frame of a pan zoomed out, where the window shows every shape and Excalidraw draws each of them again for a change as for a frame, each within one frame at 60 Hz, 16.7 ms, and fails where it costs more. To run it on your own machine, run `npm run build`, then `npm run measure --workspace @chalkline/lan`.

CI's README steps job runs the steps of Open a board, Run the local mode and Connect an agent in a new checkout, with the commands this file lists: `packages/lan/e2e/readme-steps.mjs` reads each command from this file and runs it from the repository's root, so a change to a step's commands changes what the job runs. It runs `npm ci` and `npm run lan`, opens the address `chalkline-lan` prints for localhost in Chromium with Playwright, presses New board, and opens the board's link from the address bar in a second browser context. It builds `chalkline-mcp`, runs the `claude mcp add` command with that link, and checks that `claude mcp get` lists the server. It then starts the command that `claude mcp add` was given, as Claude Code starts it, and the helper adds a labelled rectangle, which both browsers show. Next it runs the listener's command, adds an entry to the board's transcript from the first browser, as the page does for a person's speech, and waits until the listener prints it. It also opens the page at the address in Open a board, presses New board, and waits until the page joins the new board. Where Connect an agent repeats `npm ci`, the job doesn't run it again in the same checkout. Claude Code's Monitor tool turns each line into a turn of a model, which needs a model account, so the job runs the listener's command itself, as the Monitor tool runs it.

Installs use `npm ci`, which installs the versions package-lock.json pins. A change that adds, removes or updates a dependency changes package-lock.json too: run `npm install` on your machine, or run the Lock file workflow on the change's branch with `gh workflow run lock.yml --ref main -f branch=<the branch>`, which writes package-lock.json there and runs CI and the Probe workflow on the new head.

The Probe workflow is the live test across networks: Chromium and Firefox, each on its own GitHub-hosted runner with its own public address, open one board, and `draw-box` joins it from a third runner. Each browser first opens the page's own address and waits for its join screen, then puts the board's link in the address bar, types its name, draws a rectangle with the mouse, and waits until it shows the other browser's rectangle, the script's box, and the other browser's cursor with its name. It then saves the board with the main menu's Save file item, opens a file that holds a copy of its rectangle and an image with a picture of about 262 KB, and waits until it shows each browser's copy and image, with each image's picture. Next Chromium resets the canvas from Excalidraw's menu, and each browser waits until its board shows none of the shapes. Each browser then writes a request for a page to draw a Mermaid diagram, as `add_mermaid` does, and waits until its board shows each browser's diagram. Each browser then opens the chat, types a message of two lines in its field, with Shift+Enter between them, presses Enter, checks that the field grew with the message and went back once it was sent, and waits until its chat shows each browser's message on its two lines. Last, it chooses New board in the main menu and waits until the page loads again on a new room's link. It runs on each pull request against the branch's build, and after each deploy against the live page. Each browser's job summary lists the connection type it used to each peer, and its screenshot is kept as an artifact.
