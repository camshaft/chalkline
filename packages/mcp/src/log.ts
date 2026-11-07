// chalkline-mcp speaks MCP on its standard output, so its console writes each line to standard
// error, the lines of Trystero and Excalidraw among them. main.ts imports this module before any
// other, so that no module writes to standard output before the console is replaced.
import { Console } from 'node:console';

globalThis.console = new Console({ stdout: process.stderr, stderr: process.stderr });
