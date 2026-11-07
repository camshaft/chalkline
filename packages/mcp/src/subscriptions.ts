import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

/**
 * The resources of one server that a client may subscribe to, and the ones it subscribes to. A
 * server holds one handler of subscribe requests and one of unsubscribe requests, so each resource
 * that sends notifications/resources/updated offers itself here.
 */
export class Subscriptions {
  readonly #server: McpServer;
  readonly #offered: string[] = [];
  readonly #subscribed = new Set<string>();

  /**
   * Adds subscriptions to the server's resources capability, which a server can't change once it is
   * connected, so make it before the server connects.
   */
  constructor(server: McpServer) {
    this.#server = server;
    server.server.registerCapabilities({ resources: { subscribe: true } });
    server.server.setRequestHandler(SubscribeRequestSchema, ({ params }) => {
      this.#check(params.uri);
      this.#subscribed.add(params.uri);
      return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, ({ params }) => {
      this.#check(params.uri);
      this.#subscribed.delete(params.uri);
      return {};
    });
  }

  /** Lets a client subscribe to the resource at `uri`. */
  offer(uri: string): void {
    if (!this.#offered.includes(uri)) this.#offered.push(uri);
  }

  /**
   * Sends notifications/resources/updated for `uri` where the client subscribes to it. Where the
   * notification fails, it logs the failure under `what`, the notification's description.
   */
  updated(uri: string, what: string): void {
    if (!this.#subscribed.has(uri)) return;
    this.#server.server.sendResourceUpdated({ uri }).catch((error: unknown) => {
      console.error(`${what} failed:`, error);
    });
  }

  #check(uri: string): void {
    if (this.#offered.includes(uri)) return;
    throw new McpError(
      ErrorCode.InvalidParams,
      `${uri} isn't a resource of the helper's: subscribe to ${this.#offered.join(' or ')}.`,
    );
  }
}

const servers = new WeakMap<McpServer, Subscriptions>();

/** The subscriptions of `server`, which the first call makes: call it before the server connects. */
export function subscriptionsOf(server: McpServer): Subscriptions {
  let subscriptions = servers.get(server);
  if (subscriptions === undefined) {
    subscriptions = new Subscriptions(server);
    servers.set(server, subscriptions);
  }
  return subscriptions;
}
